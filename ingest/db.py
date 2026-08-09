"""DB 접근 계층 (SPEC §5 스키마).

`Database` 는 파이프라인이 쓰는 최소 인터페이스다. 구현이 둘 있다:

* `InMemoryDatabase` — 테스트와 `--dry-run` 용. psycopg 없이 돌아간다.
* `PostgresDatabase` — 실 적재용. `psycopg` 는 **import-guarded** 라
  미설치 환경에서도 테스트가 돌아간다.

스키마 계약(바꾸지 말 것):
* `programs.id` bigint, `programs.external_id` UNIQUE = 'source_key:원본고유번호'
* `program_embeddings` 행은 (program_id, chunk_idx, vector(1024))
* `raw_documents` 는 **append-only** — 수정분도 새 행. 버전 이력이 된다.
"""

from __future__ import annotations

import contextlib
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, ContextManager, Iterable, Protocol, Sequence, runtime_checkable

from .config import EMBEDDING_DIM

try:  # pragma: no cover - 실 적재 경로에서만 필요
    import psycopg  # type: ignore
    from psycopg.types.json import Jsonb  # type: ignore
except ImportError:  # pragma: no cover
    psycopg = None  # type: ignore[assignment]
    Jsonb = None  # type: ignore[assignment]

log = logging.getLogger(__name__)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


PROGRAM_COLUMNS = (
    "external_id",
    "raw_document_id",
    "title",
    "body_text",
    "summary",
    "apply_steps",
    "form",
    "issuer",
    "issuer_level",
    "benefit_amount_text",
    "benefit_amount_min",
    "benefit_amount_max",
    "apply_url",
    "apply_method",
    "starts_at",
    "ends_at",
    "is_always_open",
    "source_url",
    "fetched_at",
    "status",
)

RULE_COLUMNS = (
    "age_min",
    "age_max",
    "gender",
    "regions",
    "occupations",
    "income_decile_max",
    "extra_conditions",
    "parse_method",
    "parse_evidence",
    "confidence",
)


@runtime_checkable
class Database(Protocol):
    """파이프라인이 의존하는 유일한 DB 계약."""

    def latest_content_hash(self, external_id: str) -> str | None: ...
    def insert_raw_document(
        self,
        *,
        external_id: str,
        source_key: str,
        source_url: str,
        content_hash: str,
        raw_body: dict[str, Any],
        fetched_at: datetime,
    ) -> int: ...
    def get_program_id(self, external_id: str) -> int | None: ...
    def get_program_status(self, external_id: str) -> str | None: ...
    def upsert_program(self, values: dict[str, Any]) -> int: ...
    def touch_program(self, external_id: str, fetched_at: datetime) -> None: ...
    def replace_rules(self, program_id: int, values: dict[str, Any]) -> None: ...
    def replace_embeddings(self, program_id: int, vectors: Sequence[Sequence[float]]) -> None: ...
    def delete_embeddings(self, program_id: int) -> None: ...
    def active_external_ids(self, source_key: str) -> set[str]: ...
    def expire_programs(self, external_ids: Iterable[str]) -> int: ...
    def record_scope(self) -> ContextManager[Any]: ...
    def purge_stale_profiles(self) -> int: ...
    def commit(self) -> None: ...
    def close(self) -> None: ...


# --------------------------------------------------------------- In-memory


@dataclass
class InMemoryDatabase:
    """딕셔너리 기반 구현. 테스트와 `--dry-run` 이 같은 코드 경로를 타게 한다."""

    raw_documents: list[dict[str, Any]] = field(default_factory=list)
    programs: dict[int, dict[str, Any]] = field(default_factory=dict)
    rules: dict[int, dict[str, Any]] = field(default_factory=dict)
    embeddings: dict[int, list[dict[str, Any]]] = field(default_factory=dict)
    _by_external: dict[str, int] = field(default_factory=dict)
    _next_program_id: int = 1
    _next_raw_id: int = 1
    committed: int = 0

    # -- raw_documents (append-only) ------------------------------------

    def latest_content_hash(self, external_id: str) -> str | None:
        rows = [r for r in self.raw_documents if r["external_id"] == external_id]
        if not rows:
            return None
        return max(rows, key=lambda r: r["fetched_at"])["content_hash"]

    def insert_raw_document(
        self,
        *,
        external_id: str,
        source_key: str,
        source_url: str,
        content_hash: str,
        raw_body: dict[str, Any],
        fetched_at: datetime,
    ) -> int:
        raw_id = self._next_raw_id
        self._next_raw_id += 1
        self.raw_documents.append(
            {
                "id": raw_id,
                "external_id": external_id,
                "source_key": source_key,
                "source_url": source_url,
                "content_hash": content_hash,
                "raw_body": raw_body,
                "fetched_at": fetched_at,
            }
        )
        return raw_id

    # -- programs --------------------------------------------------------

    def get_program_id(self, external_id: str) -> int | None:
        return self._by_external.get(external_id)

    def get_program_status(self, external_id: str) -> str | None:
        program_id = self._by_external.get(external_id)
        if program_id is None:
            return None
        return self.programs[program_id].get("status")

    def upsert_program(self, values: dict[str, Any]) -> int:
        # 파이프라인이 넘기는 키가 SPEC §5 programs 컬럼과 어긋나면 여기서 즉시 터진다.
        assert set(values) == set(PROGRAM_COLUMNS), (
            f"programs 컬럼 불일치: {sorted(set(values) ^ set(PROGRAM_COLUMNS))}"
        )
        external_id = values["external_id"]
        program_id = self._by_external.get(external_id)
        now = values.get("fetched_at") or utcnow()
        if program_id is None:
            program_id = self._next_program_id
            self._next_program_id += 1
            self._by_external[external_id] = program_id
            row = {"id": program_id, "first_seen_at": now}
            row.update(values)
            row["last_changed_at"] = now
            self.programs[program_id] = row
        else:
            # 수정 시 id 를 유지한다 (SPEC §3.2 — 상세 URL·알림 중복 방지).
            row = self.programs[program_id]
            row.update(values)
            row["last_changed_at"] = now
        return program_id

    def touch_program(self, external_id: str, fetched_at: datetime) -> None:
        program_id = self._by_external.get(external_id)
        if program_id is not None:
            self.programs[program_id]["fetched_at"] = fetched_at

    # -- eligibility_rules -----------------------------------------------

    def replace_rules(self, program_id: int, values: dict[str, Any]) -> None:
        assert set(values) == set(RULE_COLUMNS), (
            f"eligibility_rules 컬럼 불일치: {sorted(set(values) ^ set(RULE_COLUMNS))}"
        )
        row = {"program_id": program_id}
        row.update(values)
        self.rules[program_id] = row

    # -- program_embeddings ----------------------------------------------

    def replace_embeddings(self, program_id: int, vectors: Sequence[Sequence[float]]) -> None:
        # 청크 수가 줄어도 잔여 행이 남지 않도록 전체 삭제 후 재삽입 (SPEC §5 주석).
        self.delete_embeddings(program_id)
        now = utcnow()
        self.embeddings[program_id] = [
            {
                "program_id": program_id,
                "chunk_idx": idx,
                "embedding": list(vector),
                "embedded_at": now,
            }
            for idx, vector in enumerate(vectors)
        ]

    def delete_embeddings(self, program_id: int) -> None:
        self.embeddings.pop(program_id, None)

    # -- 전량 대조 ---------------------------------------------------------

    def active_external_ids(self, source_key: str) -> set[str]:
        prefix = f"{source_key}:"
        return {
            row["external_id"]
            for row in self.programs.values()
            if row.get("status") == "active" and str(row["external_id"]).startswith(prefix)
        }

    def expire_programs(self, external_ids: Iterable[str]) -> int:
        count = 0
        for external_id in external_ids:
            program_id = self._by_external.get(external_id)
            if program_id is None:
                continue
            row = self.programs[program_id]
            if row.get("status") == "expired":
                continue
            row["status"] = "expired"
            # 만료 건이 벡터 top-k 슬롯을 차지하면 유효 결과가 밀려난다 (SPEC §5, §7.3).
            self.delete_embeddings(program_id)
            count += 1
        return count

    def record_scope(self) -> ContextManager[Any]:
        """한 건 처리 구간. 인메모리에는 롤백할 트랜잭션이 없어 no-op 이다.

        `--dry-run` 은 쓰기가 없으므로 부분 상태가 남아도 부작용이 없다.
        실 적재의 격리는 `PostgresDatabase.record_scope`(SAVEPOINT) 가 담당한다.
        """
        return contextlib.nullcontext()

    def purge_stale_profiles(self) -> int:
        return 0

    def commit(self) -> None:
        self.committed += 1

    def close(self) -> None:  # noqa: D401 - 인터페이스 맞춤
        return None


# ---------------------------------------------------------------- Postgres

_UPSERT_PROGRAM = """
INSERT INTO programs (
    external_id, raw_document_id, first_seen_at, last_changed_at,
    title, body_text, summary, apply_steps, form, issuer, issuer_level,
    benefit_amount_text, benefit_amount_min, benefit_amount_max,
    apply_url, apply_method, starts_at, ends_at, is_always_open,
    source_url, fetched_at, status
) VALUES (
    %(external_id)s, %(raw_document_id)s, %(now)s, %(now)s,
    %(title)s, %(body_text)s, %(summary)s, %(apply_steps)s, %(form)s, %(issuer)s, %(issuer_level)s,
    %(benefit_amount_text)s, %(benefit_amount_min)s, %(benefit_amount_max)s,
    %(apply_url)s, %(apply_method)s, %(starts_at)s, %(ends_at)s, %(is_always_open)s,
    %(source_url)s, %(fetched_at)s, %(status)s
)
ON CONFLICT (external_id) DO UPDATE SET
    raw_document_id = EXCLUDED.raw_document_id,
    last_changed_at = EXCLUDED.last_changed_at,
    title = EXCLUDED.title,
    body_text = EXCLUDED.body_text,
    summary = EXCLUDED.summary,
    apply_steps = EXCLUDED.apply_steps,
    form = EXCLUDED.form,
    issuer = EXCLUDED.issuer,
    issuer_level = EXCLUDED.issuer_level,
    benefit_amount_text = EXCLUDED.benefit_amount_text,
    benefit_amount_min = EXCLUDED.benefit_amount_min,
    benefit_amount_max = EXCLUDED.benefit_amount_max,
    apply_url = EXCLUDED.apply_url,
    apply_method = EXCLUDED.apply_method,
    starts_at = EXCLUDED.starts_at,
    ends_at = EXCLUDED.ends_at,
    is_always_open = EXCLUDED.is_always_open,
    source_url = EXCLUDED.source_url,
    fetched_at = EXCLUDED.fetched_at,
    status = EXCLUDED.status
RETURNING id
"""  # id 는 유지된다 — ON CONFLICT DO UPDATE 는 기존 행을 고친다 (SPEC §3.2)

_REPLACE_RULES = """
INSERT INTO eligibility_rules (
    program_id, age_min, age_max, gender, regions, occupations,
    income_decile_max, extra_conditions, parse_method, parse_evidence, confidence
) VALUES (
    %(program_id)s, %(age_min)s, %(age_max)s, %(gender)s, %(regions)s, %(occupations)s,
    %(income_decile_max)s, %(extra_conditions)s, %(parse_method)s, %(parse_evidence)s, %(confidence)s
)
ON CONFLICT (program_id) DO UPDATE SET
    age_min = EXCLUDED.age_min, age_max = EXCLUDED.age_max, gender = EXCLUDED.gender,
    regions = EXCLUDED.regions, occupations = EXCLUDED.occupations,
    income_decile_max = EXCLUDED.income_decile_max,
    extra_conditions = EXCLUDED.extra_conditions, parse_method = EXCLUDED.parse_method,
    parse_evidence = EXCLUDED.parse_evidence, confidence = EXCLUDED.confidence
"""


def to_pgvector(vector: Sequence[float]) -> str:
    """pgvector 리터럴. psycopg 어댑터를 따로 등록하지 않아도 캐스팅으로 들어간다.

    소수점 8자리 고정 — web/src/lib/embedding.ts 의 `toPgVectorLiteral`(toFixed(8))과
    같은 표기를 쓴다.
    """
    return "[" + ",".join(f"{v:.8f}" for v in vector) + "]"


#: 로컬 개발용 호스트 — TLS 를 강제하지 않는다.
_LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1", "[::1]")


def ensure_sslmode(dsn: str, default: str = "verify-full") -> str:
    """DSN 에 sslmode 가 없으면 인증서 검증까지 켠 값을 채워 넣는다.

    sslmode 를 지정하지 않으면 libpq 기본값은 `prefer` 다 — 암호화는 되지만
    **서버 인증서를 검증하지 않아** 경로상 공격자가 연결을 중계하면 프로필·이메일
    질의를 관찰·변조할 수 있다. RLS 는 애플리케이션 role 의 작업을 막지 못한다.

    명시된 값이 있으면 존중한다 (로컬 Postgres 는 `sslmode=disable`).
    """
    from urllib.parse import parse_qs, urlsplit

    parts = urlsplit(dsn)
    if "sslmode=" in (parts.query or "") or "sslmode=" in dsn:
        return dsn
    if parse_qs(parts.query).get("sslmode"):
        return dsn
    host = (parts.hostname or "").lower()
    if not host or host in _LOCAL_HOSTS:
        return dsn
    separator = "&" if parts.query else "?"
    log.info("DSN 에 sslmode 가 없어 sslmode=%s 를 적용합니다", default)
    return f"{dsn}{separator}sslmode={default}"


class PostgresDatabase:
    """psycopg 기반 실 적재 구현.

    W1 적용 절차는 `ingest/README` 대신 최종 보고서에 정리한다. 요약하면:
    `pip install 'psycopg[binary]'` → `DATABASE_URL` 설정 → `--dry-run` 을 뺀다.
    """

    def __init__(self, dsn: str, *, dim: int = EMBEDDING_DIM) -> None:
        if psycopg is None:  # pragma: no cover
            raise RuntimeError(
                "psycopg 미설치 — `pip install 'psycopg[binary]'` 후 다시 실행하거나 "
                "--dry-run 으로 InMemoryDatabase 를 쓰세요."
            )
        self.dim = dim
        self.conn = psycopg.connect(ensure_sslmode(dsn))

    # -- raw_documents ----------------------------------------------------

    def latest_content_hash(self, external_id: str) -> str | None:
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT content_hash FROM raw_documents WHERE external_id = %s "
                "ORDER BY fetched_at DESC LIMIT 1",
                (external_id,),
            )
            row = cur.fetchone()
        return row[0] if row else None

    def insert_raw_document(
        self,
        *,
        external_id: str,
        source_key: str,
        source_url: str,
        content_hash: str,
        raw_body: dict[str, Any],
        fetched_at: datetime,
    ) -> int:
        with self.conn.cursor() as cur:
            cur.execute(
                "INSERT INTO raw_documents "
                "(external_id, source_key, source_url, fetched_at, content_hash, raw_body) "
                "VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
                (
                    external_id,
                    source_key,
                    source_url,
                    fetched_at,
                    content_hash,
                    json.dumps(raw_body, ensure_ascii=False),
                ),
            )
            return cur.fetchone()[0]

    # -- programs ----------------------------------------------------------

    def get_program_id(self, external_id: str) -> int | None:
        with self.conn.cursor() as cur:
            cur.execute("SELECT id FROM programs WHERE external_id = %s", (external_id,))
            row = cur.fetchone()
        return row[0] if row else None

    def get_program_status(self, external_id: str) -> str | None:
        with self.conn.cursor() as cur:
            cur.execute("SELECT status FROM programs WHERE external_id = %s", (external_id,))
            row = cur.fetchone()
        return row[0] if row else None

    def upsert_program(self, values: dict[str, Any]) -> int:
        params = dict(values)
        params["now"] = params.get("fetched_at") or utcnow()
        steps = params.get("apply_steps")
        params["apply_steps"] = Jsonb(steps) if Jsonb is not None else json.dumps(steps)
        with self.conn.cursor() as cur:
            cur.execute(_UPSERT_PROGRAM, params)
            return cur.fetchone()[0]

    def touch_program(self, external_id: str, fetched_at: datetime) -> None:
        with self.conn.cursor() as cur:
            cur.execute(
                "UPDATE programs SET fetched_at = %s WHERE external_id = %s",
                (fetched_at, external_id),
            )

    # -- eligibility_rules --------------------------------------------------

    def replace_rules(self, program_id: int, values: dict[str, Any]) -> None:
        params = dict(values)
        params["program_id"] = program_id
        for key in ("extra_conditions", "parse_evidence"):
            params[key] = Jsonb(params[key]) if Jsonb is not None else json.dumps(params[key])
        with self.conn.cursor() as cur:
            cur.execute(_REPLACE_RULES, params)

    # -- program_embeddings --------------------------------------------------

    def replace_embeddings(self, program_id: int, vectors: Sequence[Sequence[float]]) -> None:
        self.delete_embeddings(program_id)
        if not vectors:
            return
        with self.conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO program_embeddings (program_id, chunk_idx, embedding, embedded_at) "
                "VALUES (%s, %s, %s::vector, now())",
                [(program_id, idx, to_pgvector(v)) for idx, v in enumerate(vectors)],
            )

    def delete_embeddings(self, program_id: int) -> None:
        with self.conn.cursor() as cur:
            cur.execute("DELETE FROM program_embeddings WHERE program_id = %s", (program_id,))

    # -- 전량 대조 -------------------------------------------------------------

    def active_external_ids(self, source_key: str) -> set[str]:
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT external_id FROM programs "
                "WHERE status = 'active' AND external_id LIKE %s",
                (f"{source_key}:%",),
            )
            return {row[0] for row in cur.fetchall()}

    def expire_programs(self, external_ids: Iterable[str]) -> int:
        ids = list(external_ids)
        if not ids:
            return 0
        with self.conn.cursor() as cur:
            cur.execute(
                "UPDATE programs SET status = 'expired' "
                "WHERE external_id = ANY(%s) AND status <> 'expired' RETURNING id",
                (ids,),
            )
            program_ids = [row[0] for row in cur.fetchall()]
            if program_ids:
                cur.execute(
                    "DELETE FROM program_embeddings WHERE program_id = ANY(%s)", (program_ids,)
                )
        return len(program_ids)

    # -- 트랜잭션 -------------------------------------------------------------

    def record_scope(self) -> ContextManager[Any]:
        """한 건 처리를 감싸는 SAVEPOINT.

        psycopg 는 autocommit=False 라 문 하나가 실패하면 **트랜잭션 전체가
        aborted 상태**가 된다. 그 뒤 문장은 전부 InFailedSqlTransaction 으로 죽고,
        마지막 commit() 은 그 소스의 성공분까지 통째로 되돌린다 — 한 건 실패를
        격리하려던 파이프라인 의도와 정반대다.

        `conn.transaction()` 은 이미 트랜잭션이 열려 있으면 SAVEPOINT 를 잡고
        예외 시 그 지점까지만 롤백한다. 열려 있지 않으면 트랜잭션을 시작하고
        블록 종료 시 커밋한다 (= 건 단위 커밋).
        """
        return self.conn.transaction()

    def purge_stale_profiles(self) -> int:
        """SPEC §8 — 보존기간(기본 90일) 지난 익명 프로필 삭제.

        마이그레이션(0003)의 함수를 배치가 직접 호출한다. pg_cron 은 요금제·확장
        활성화에 의존하는데, 심야 배치는 어차피 매일 도는 확실한 실행 지점이다.
        """
        with self.conn.cursor() as cur:
            cur.execute("SELECT purge_stale_profiles()")
            row = cur.fetchone()
        self.conn.commit()
        return int(row[0]) if row and row[0] is not None else 0

    def commit(self) -> None:
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()
