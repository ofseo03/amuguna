"""수집 파이프라인 — SPEC §3.2 상태 기계.

    external_id 조회 → content_hash 비교 → 신규 / 수정 / 무변경 / (전량 대조) 삭제

| 상황 | 판정 | 처리 |
|---|---|---|
| external_id 없음 | 신규 | raw insert → 파싱 → 요약 → 임베딩 → programs insert |
| 있음 + hash 동일 | 무변경 | fetched_at 만 갱신. **파싱·임베딩·LLM 호출 없음** |
| 있음 + hash 상이 | 수정 | raw **insert**(버전 이력) → 재파싱 → 재임베딩 → programs UPDATE (id 유지) |
| 전량 대조에 없음 | 삭제 | status='expired' + 임베딩 행 삭제 |

`content_hash` 는 정규화된 비교 대상 필드로만 계산한다 (`models.HASHED_FIELDS`).
조회수 같은 휘발성 필드를 넣으면 전 건이 매일 '수정'이 되어 증분 수집의
비용 이점이 통째로 사라진다 — SPEC §3.2 가 지목한 조용한 실패 모드다.
"""

from __future__ import annotations

import logging
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Iterable, Sequence

from .collectors.base import Collector, CollectorError
from .db import Database, utcnow
from .embedder import Embedder
from .llm_fallback import LLMFallback, apply_fallback
from .models import CollectedProgram, EligibilityRules
from .parser import eligibility_source_text, parse_program
from .summarize import Summarizer

log = logging.getLogger(__name__)

FIELD_NAMES = ("age_min", "age_max", "gender", "regions", "occupations", "income_decile_max")


@dataclass
class SourceStats:
    source_key: str
    fetched: int = 0
    created: int = 0
    updated: int = 0
    unchanged: int = 0
    expired: int = 0
    errors: list[str] = field(default_factory=list)

    @property
    def changed(self) -> int:
        return self.created + self.updated


@dataclass
class ParseStats:
    """SPEC §10 '수집 상태' + 파싱 커버리지 리포트."""

    parsed: int = 0
    field_hits: Counter = field(default_factory=Counter)
    methods: Counter = field(default_factory=Counter)
    needs_review: int = 0
    with_extra_conditions: int = 0
    confidence_sum: float = 0.0

    def record(self, rules: EligibilityRules) -> None:
        self.parsed += 1
        for name in FIELD_NAMES:
            if getattr(rules, name) not in (None, [], ""):
                self.field_hits[name] += 1
        self.methods[rules.parse_method] += 1
        if rules.needs_review:
            self.needs_review += 1
        if rules.extra_conditions:
            self.with_extra_conditions += 1
        self.confidence_sum += rules.confidence

    def coverage(self, name: str) -> float:
        return (self.field_hits[name] / self.parsed) if self.parsed else 0.0

    @property
    def any_field_rate(self) -> float:
        """정형 필드를 하나라도 뽑아낸 비율."""
        if not self.parsed:
            return 0.0
        covered = max(self.field_hits.values()) if self.field_hits else 0
        return covered / self.parsed

    @property
    def mean_confidence(self) -> float:
        return (self.confidence_sum / self.parsed) if self.parsed else 0.0


@dataclass
class RunReport:
    sources: dict[str, SourceStats] = field(default_factory=dict)
    parse: ParseStats = field(default_factory=ParseStats)
    embeddings_written: int = 0
    chunks_written: int = 0
    llm_parse_calls: int = 0
    llm_summary_calls: int = 0
    embedding_provider: str = "mock"
    dry_run: bool = True
    reconciled: bool = False
    started_at: datetime = field(default_factory=utcnow)

    @property
    def totals(self) -> SourceStats:
        total = SourceStats(source_key="TOTAL")
        for stats in self.sources.values():
            total.fetched += stats.fetched
            total.created += stats.created
            total.updated += stats.updated
            total.unchanged += stats.unchanged
            total.expired += stats.expired
            total.errors.extend(stats.errors)
        return total


class Pipeline:
    def __init__(
        self,
        db: Database,
        *,
        embedder: Embedder,
        summarizer: Summarizer | None = None,
        llm: LLMFallback | None = None,
        dry_run: bool = False,
    ) -> None:
        self.db = db
        self.embedder = embedder
        self.summarizer = summarizer or Summarizer()
        self.llm = llm
        self.dry_run = dry_run
        self.report = RunReport(
            embedding_provider=embedder.provider, dry_run=dry_run
        )

    # ------------------------------------------------------------ 한 건 처리

    def _process(self, program: CollectedProgram, stats: SourceStats, now: datetime) -> None:
        content_hash = program.content_hash()
        previous_hash = self.db.latest_content_hash(program.external_id)
        program_id = self.db.get_program_id(program.external_id)

        # --- 무변경 -----------------------------------------------------
        if program_id is not None and previous_hash == content_hash:
            self.db.touch_program(program.external_id, now)
            stats.unchanged += 1
            return

        # --- 신규 / 수정 --------------------------------------------------
        raw_id = self.db.insert_raw_document(  # append-only: 수정분도 새 행
            external_id=program.external_id,
            source_key=program.source_key,
            source_url=program.source_url,
            content_hash=content_hash,
            raw_body=program.raw_body,
            fetched_at=now,
        )

        rules = parse_program(program)
        if self.llm is not None:
            before = self.llm.calls
            apply_fallback(rules, eligibility_source_text(program), self.llm)
            self.report.llm_parse_calls += self.llm.calls - before
        self.report.parse.record(rules)

        card = self.summarizer.generate(program)
        self.report.llm_summary_calls = self.summarizer.calls

        status = "needs_review" if rules.needs_review else "active"
        program_id = self.db.upsert_program(
            {
                "external_id": program.external_id,
                "raw_document_id": raw_id,
                "title": program.title,
                "body_text": program.body_text,
                "summary": card.summary,
                "apply_steps": card.apply_steps,
                "form": program.form,
                "issuer": program.issuer,
                "issuer_level": program.issuer_level,
                "benefit_amount_text": program.benefit_amount_text,
                "benefit_amount_min": program.benefit_amount_min,
                "benefit_amount_max": program.benefit_amount_max,
                "apply_url": program.apply_url,
                "apply_method": program.apply_method,
                "starts_at": program.starts_at,
                "ends_at": program.ends_at,
                "is_always_open": program.is_always_open,
                "source_url": program.source_url,
                "fetched_at": now,
                "status": status,
            }
        )
        self.db.replace_rules(program_id, rules.to_row())

        # 재임베딩은 항상 '전체 삭제 후 재삽입' (청크 수가 줄어도 잔여 행 없게)
        result = self.embedder.embed_program(
            title=program.title, summary=card.summary, body=program.embedding_source()
        )
        self.db.replace_embeddings(program_id, result.vectors)
        self.report.embeddings_written += 1
        self.report.chunks_written += len(result.vectors)

        if previous_hash is None:
            stats.created += 1
        else:
            stats.updated += 1

    # ---------------------------------------------------------------- 소스 단위

    def run_source(
        self, collector: Collector, *, since: str | None = None, reconcile: bool = False
    ) -> SourceStats:
        stats = self.report.sources.setdefault(
            collector.source_key, SourceStats(source_key=collector.source_key)
        )
        now = utcnow()
        try:
            programs = collector.fetch(since=since)
        except CollectorError as exc:
            # 실패 시 직전 성공 스냅샷 유지 (빈 결과 노출 금지 — SPEC §3.2)
            log.error("%s 수집 실패, 기존 데이터 유지: %s", collector.source_key, exc)
            stats.errors.append(str(exc))
            return stats

        stats.fetched = len(programs)
        for program in programs:
            try:
                self._process(program, stats, now)
            except Exception as exc:  # 한 건 실패가 배치 전체를 죽이지 않게
                log.exception("%s 처리 실패: %s", program.external_id, exc)
                stats.errors.append(f"{program.external_id}: {exc}")

        if reconcile:
            stats.expired += self.reconcile(collector)

        self.db.commit()
        return stats

    def reconcile(self, collector: Collector) -> int:
        """주 1회 전량 대조 (SPEC §3.2).

        원본 ID 목록에 없는데 우리 DB에서 active 인 건을 expired 로 내린다.
        상세 조회를 하지 않으므로 호출 한도를 거의 쓰지 않는다.
        마감일 있는 건은 `ends_at` 으로 자동 만료되지만, 상시 공고는 이 경로가 유일하다.
        """
        try:
            source_ids = collector.list_external_ids()
        except CollectorError as exc:
            log.error("%s 전량 대조 실패: %s", collector.source_key, exc)
            return 0
        if not source_ids:
            # 목록이 통째로 비면 소스 장애일 가능성이 높다. 전량 만료는 위험하다.
            log.warning("%s 전량 대조 결과가 비어 있어 만료 처리를 건너뜁니다", collector.source_key)
            return 0
        ours = self.db.active_external_ids(collector.source_key)
        gone = sorted(ours - source_ids)
        count = self.db.expire_programs(gone)
        self.report.reconciled = True
        return count

    # ------------------------------------------------------------------ 실행

    def run(
        self,
        collectors: Sequence[Collector],
        *,
        since: str | None = None,
        reconcile: bool = False,
    ) -> RunReport:
        for collector in collectors:
            self.run_source(collector, since=since, reconcile=reconcile)
        self.db.commit()
        return self.report


# ----------------------------------------------------------------- 리포트 렌더


def render_report(report: RunReport) -> str:
    """SPEC §10 '수집 상태' 로그 — 소스별 건수 + 파싱 커버리지."""
    lines: list[str] = []
    mode = "DRY-RUN (in-memory)" if report.dry_run else "LIVE"
    lines.append(f"=== amuguna ingest — {mode} ===")
    lines.append(f"시작: {report.started_at.isoformat(timespec='seconds')}")
    lines.append(f"임베딩 provider: {report.embedding_provider}")
    lines.append("")
    header = f"{'source':<18}{'fetched':>8}{'new':>7}{'changed':>9}{'same':>7}{'expired':>9}{'err':>6}"
    lines.append(header)
    lines.append("-" * len(header))
    for stats in report.sources.values():
        lines.append(
            f"{stats.source_key:<18}{stats.fetched:>8}{stats.created:>7}"
            f"{stats.updated:>9}{stats.unchanged:>7}{stats.expired:>9}{len(stats.errors):>6}"
        )
    total = report.totals
    lines.append("-" * len(header))
    lines.append(
        f"{'TOTAL':<18}{total.fetched:>8}{total.created:>7}"
        f"{total.updated:>9}{total.unchanged:>7}{total.expired:>9}{len(total.errors):>6}"
    )

    parse = report.parse
    lines.append("")
    lines.append(f"--- 파싱 커버리지 (신규·수정 {parse.parsed}건 기준) ---")
    if parse.parsed:
        for name in FIELD_NAMES:
            hits = parse.field_hits[name]
            lines.append(f"  {name:<20} {hits:>4}/{parse.parsed}  {parse.coverage(name) * 100:5.1f}%")
        methods = ", ".join(f"{k}={v}" for k, v in sorted(parse.methods.items()))
        lines.append(f"  parse_method         {methods}")
        lines.append(f"  extra_conditions 보유 {parse.with_extra_conditions:>3}/{parse.parsed}")
        lines.append(f"  needs_review         {parse.needs_review:>3}/{parse.parsed}")
        lines.append(f"  평균 confidence       {parse.mean_confidence:.3f}")
    else:
        lines.append("  (신규·수정 없음 — 파싱 호출 0회)")

    lines.append("")
    lines.append(
        f"임베딩: 프로그램 {report.embeddings_written}건 / 청크 {report.chunks_written}행"
    )
    lines.append(
        f"LLM 호출: 자격요건 보완 {report.llm_parse_calls}회 / 요약·절차 {report.llm_summary_calls}회"
    )
    if total.errors:
        lines.append("")
        lines.append(f"!! 오류 {len(total.errors)}건")
        for message in total.errors[:10]:
            lines.append(f"   - {message}")
    return "\n".join(lines)


def check_volume_drop(report: RunReport, previous: dict[str, int] | None) -> list[str]:
    """전일 대비 50% 이상 감소 시 경고 (SPEC §10 수집 상태)."""
    warnings: list[str] = []
    if not previous:
        return warnings
    for key, stats in report.sources.items():
        before = previous.get(key)
        if before and stats.fetched < before * 0.5:
            warnings.append(f"{key}: 전일 {before}건 → 금일 {stats.fetched}건 (50% 이상 감소)")
    return warnings


def iter_active_programs(db: Any) -> Iterable[dict[str, Any]]:
    """InMemoryDatabase 점검용 헬퍼 (CLI 요약 출력에 쓴다)."""
    programs = getattr(db, "programs", {})
    return [row for row in programs.values() if row.get("status") != "expired"]
