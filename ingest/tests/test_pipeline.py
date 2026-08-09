"""SPEC §3.2 상태 기계 + 임베딩 계약 검증."""

from __future__ import annotations

import dataclasses
import math

import pytest

from ingest.collectors import COLLECTORS
from ingest.collectors.base import Collector, CollectorError
from ingest.config import EMBEDDING_DIM, Settings
from ingest.db import InMemoryDatabase
from ingest.embedder import Embedder, chunk_text, cosine, mock_embed
from ingest.models import CollectedProgram
from ingest.pipeline import Pipeline
from ingest.summarize import Summarizer

SETTINGS = Settings(mock_embeddings=True)


# ------------------------------------------------------------------ 픽스처


def make_program(**overrides) -> CollectedProgram:
    base = dict(
        external_id="fake:001",
        source_key="fake",
        source_url="https://example.test/notice/1",
        title="청년 전월세보증금 대출 지원",
        body_text=(
            "중소기업에 재직하는 청년의 전월세 보증금을 저리로 대출합니다.\n\n"
            "대출 한도는 최대 1억원이며 금리는 연 1.5%입니다."
        ),
        eligibility_text="만 19세 이상 34세 이하 무주택 세대주로 기준 중위소득 150% 이하인 자",
        form="loan",
        issuer="국토교통부",
        issuer_level="central",
        benefit_amount_text="최대 1억원",
        benefit_amount_max=100_000_000,
        apply_url="https://example.test/apply",
        apply_method="온라인 신청",
        starts_at="2026-03-01",
        ends_at="2026-12-31",
        raw_body={"servId": "001", "inqNum": "100"},
    )
    base.update(overrides)
    return CollectedProgram(**base)


class FakeCollector(Collector):
    """네트워크·픽스처 파일 없이 프로그램 목록을 그대로 돌려주는 수집기."""

    source_key = "fake"

    def __init__(self, programs, *, source_ids=None, fail=False):
        super().__init__(SETTINGS, use_fixtures=True)
        self.programs = list(programs)
        self.source_ids = source_ids
        self.fail = fail

    def _query_params(self, *, since, page):  # pragma: no cover - 미사용
        return {}

    def _items_container(self, payload):  # pragma: no cover - 미사용
        return []

    def _map_item(self, item):  # pragma: no cover - 미사용
        return None

    def fetch(self, *, since=None, max_pages=5):
        if self.fail:
            raise CollectorError("소스 장애 시뮬레이션")
        return list(self.programs)

    def list_external_ids(self):
        if self.source_ids is not None:
            return set(self.source_ids)
        return {p.external_id for p in self.programs}


def make_pipeline(db: InMemoryDatabase) -> Pipeline:
    return Pipeline(
        db,
        embedder=Embedder(SETTINGS),
        summarizer=Summarizer(SETTINGS),  # 키 없음 → mock 요약
        llm=None,
        dry_run=True,
    )


# ------------------------------------------------------------- 신규 / 무변경


def test_new_program_creates_all_rows() -> None:
    db = InMemoryDatabase()
    pipeline = make_pipeline(db)
    stats = pipeline.run_source(FakeCollector([make_program()]))

    assert (stats.created, stats.updated, stats.unchanged) == (1, 0, 0)
    assert len(db.raw_documents) == 1
    assert len(db.programs) == 1

    program = db.programs[1]
    assert program["external_id"] == "fake:001"
    assert program["status"] == "active"
    assert program["summary"]
    # 교차팀 계약: apply_steps 는 문자열 3개 배열 (web/src/lib/types.ts)
    assert len(program["apply_steps"]) == 3
    assert all(isinstance(step, str) and step for step in program["apply_steps"])

    rules = db.rules[1]
    assert (rules["age_min"], rules["age_max"]) == (19, 34)
    assert rules["income_decile_max"] == 7
    assert db.embeddings[1]


def test_unchanged_skips_reparse_and_reembed() -> None:
    db = InMemoryDatabase()
    pipeline = make_pipeline(db)
    collector = FakeCollector([make_program()])

    pipeline.run_source(collector)
    parsed_after_first = pipeline.report.parse.parsed
    chunks_after_first = pipeline.report.chunks_written

    stats = pipeline.run_source(collector)

    assert (stats.created, stats.updated, stats.unchanged) == (1, 0, 1)
    assert len(db.raw_documents) == 1, "무변경이면 raw_documents 에 새 행이 쌓이지 않는다"
    assert pipeline.report.parse.parsed == parsed_after_first, "파싱 재호출 없음"
    assert pipeline.report.chunks_written == chunks_after_first, "재임베딩 없음"


def test_volatile_fields_do_not_change_content_hash() -> None:
    """조회수·응답 생성 시각이 바뀌어도 '수정'으로 판정하면 안 된다 (SPEC §3.2)."""
    original = make_program()
    volatile = make_program(
        raw_body={"servId": "001", "inqNum": "999999", "resultTime": "2026-08-09T18:00:00+09:00"},
        source_url="https://example.test/notice/1?sessionId=abc123",
    )
    assert original.content_hash() == volatile.content_hash()

    db = InMemoryDatabase()
    pipeline = make_pipeline(db)
    pipeline.run_source(FakeCollector([original]))
    stats = pipeline.run_source(FakeCollector([volatile]))
    assert stats.unchanged == 1 and stats.updated == 0


def test_comparison_field_change_does_change_hash() -> None:
    original = make_program()
    for field_name, value in (
        ("title", "제목이 바뀌었습니다"),
        ("body_text", "본문이 바뀌었습니다"),
        ("ends_at", "2027-01-31"),
        ("benefit_amount_max", 200_000_000),
        ("eligibility_text", "만 19세 이상 39세 이하"),
    ):
        changed = dataclasses.replace(original, **{field_name: value})
        assert original.content_hash() != changed.content_hash(), field_name


# ------------------------------------------------------------------- 수정


def test_modified_program_updates_in_place_and_keeps_id() -> None:
    db = InMemoryDatabase()
    pipeline = make_pipeline(db)
    pipeline.run_source(FakeCollector([make_program()]))
    original_id = db.programs[1]["id"]

    # 마감 연장 + 자격 완화
    updated = make_program(
        ends_at="2027-06-30",
        eligibility_text="만 19세 이상 39세 이하 무주택 세대주로 기준 중위소득 180% 이하인 자",
    )
    stats = pipeline.run_source(FakeCollector([updated]))

    assert (stats.created, stats.updated, stats.unchanged) == (1, 1, 0)
    assert len(db.programs) == 1
    assert db.programs[original_id]["id"] == original_id, "상세 URL·알림 중복 방지 (SPEC §3.2)"
    assert db.programs[original_id]["ends_at"] == "2027-06-30"
    assert db.rules[original_id]["age_max"] == 39
    assert db.rules[original_id]["income_decile_max"] == 8
    # raw_documents 는 덮어쓰지 않고 쌓인다 = 버전 이력
    assert len(db.raw_documents) == 2
    assert db.raw_documents[0]["content_hash"] != db.raw_documents[1]["content_hash"]


def test_reembedding_removes_stale_chunks() -> None:
    """청크 수가 줄어도 잔여 행이 남지 않아야 한다 (SPEC §5 주석)."""
    long_body = "\n\n".join(f"문단 {i}. " + "공고 본문 내용입니다. " * 30 for i in range(4))
    db = InMemoryDatabase()
    pipeline = make_pipeline(db)
    pipeline.run_source(FakeCollector([make_program(body_text=long_body)]))
    assert len(db.embeddings[1]) > 1

    pipeline.run_source(FakeCollector([make_program(body_text="짧아진 본문입니다.")]))
    assert len(db.embeddings[1]) == 1
    assert [row["chunk_idx"] for row in db.embeddings[1]] == [0]


# ------------------------------------------------------------- 만료 / 전량 대조


def test_reconcile_expires_missing_programs_and_drops_embeddings() -> None:
    db = InMemoryDatabase()
    pipeline = make_pipeline(db)
    alive = make_program(external_id="fake:001")
    gone = make_program(external_id="fake:002", title="사라질 상시 공고")
    pipeline.run_source(FakeCollector([alive, gone]))
    assert len(db.programs) == 2

    # 원본 목록에 fake:002 가 없다 → 조용히 내려간 상시 공고
    stats = pipeline.run_source(
        FakeCollector([alive], source_ids={"fake:001"}), reconcile=True
    )

    assert stats.expired == 1
    gone_id = db.get_program_id("fake:002")
    assert db.programs[gone_id]["status"] == "expired"
    assert gone_id not in db.embeddings, "만료 건이 벡터 top-k 슬롯을 차지하면 안 된다 (§7.3)"
    # 행 자체는 지우지 않는다
    assert db.programs[gone_id]["title"] == "사라질 상시 공고"
    assert db.get_program_id("fake:001") in db.embeddings


def test_reconcile_skips_when_source_list_is_empty() -> None:
    """목록이 통째로 비면 소스 장애일 가능성이 높다 — 전량 만료는 위험하다."""
    db = InMemoryDatabase()
    pipeline = make_pipeline(db)
    pipeline.run_source(FakeCollector([make_program()]))

    stats = pipeline.run_source(
        FakeCollector([make_program()], source_ids=set()), reconcile=True
    )
    assert stats.expired == 0
    assert db.programs[1]["status"] == "active"


def test_source_failure_keeps_previous_snapshot() -> None:
    """실패 시 직전 성공 스냅샷 유지, 빈 결과 노출 금지 (SPEC §3.2)."""
    db = InMemoryDatabase()
    pipeline = make_pipeline(db)
    pipeline.run_source(FakeCollector([make_program()]))

    stats = pipeline.run_source(FakeCollector([], fail=True))
    assert stats.errors and stats.fetched == 1  # 직전 성공값 유지
    assert db.programs[1]["status"] == "active"
    assert db.embeddings[1]


# --------------------------------------------------------------- 임베딩 계약


def test_mock_embedding_matches_cross_team_contract() -> None:
    """웹팀 TypeScript 구현과 동일해야 한다 — 손으로 계산한 값과 대조."""
    vector = mock_embed("ab")
    index = (ord("a") * 31 + ord("b")) % EMBEDDING_DIM
    assert len(vector) == EMBEDDING_DIM
    assert vector[index] == pytest.approx(1.0)
    assert sum(1 for v in vector if v != 0.0) == 1


def test_mock_embedding_short_text_uses_slot_zero() -> None:
    for text in ("", "a", "가"):
        vector = mock_embed(text)
        assert vector[0] == pytest.approx(1.0)
        assert sum(1 for v in vector if v != 0.0) == 1


def test_mock_embedding_normalizes_case_and_unicode() -> None:
    import unicodedata

    assert mock_embed("AB") == mock_embed("ab")
    # 자모로 분해된(NFD) 한글도 NFC 정규화 후 같은 벡터가 되어야 한다.
    decomposed = unicodedata.normalize("NFD", "가나")
    assert decomposed != "가나"
    assert mock_embed(decomposed) == mock_embed("가나")


def test_mock_embedding_is_deterministic_and_l2_normalized() -> None:
    text = "만 19세 이상 34세 이하 청년 전월세보증금 대출 지원 공고입니다."
    first, second = mock_embed(text), mock_embed(text)
    assert first == second
    assert len(first) == EMBEDDING_DIM
    assert math.sqrt(sum(v * v for v in first)) == pytest.approx(1.0, abs=1e-9)
    assert cosine(first, second) == pytest.approx(1.0, abs=1e-9)


def test_mock_embedding_reflects_bigram_overlap() -> None:
    """데모용이지만 '가까운 문장이 더 가깝게' 나와야 쓸모가 있다."""
    query = mock_embed("보증금 올려달래서 대출 알아봐요")
    close = mock_embed("전월세 보증금 대출 지원 사업")
    far = mock_embed("농작물 재해보험 가입 안내")
    assert cosine(query, close) > cosine(query, far)


def test_embedder_provider_selection() -> None:
    assert Embedder(Settings(mock_embeddings=True)).provider == "mock"
    forced = Settings(embedding_provider="voyage", embedding_api_key="k", mock_embeddings=True)
    assert Embedder(forced).provider == "mock", "MOCK_EMBEDDINGS=1 이 provider 를 이긴다"


# ------------------------------------------------------------------- 청킹


def test_chunking_prepends_title_and_summary_to_first_chunk() -> None:
    chunks = chunk_text("본문 문단입니다.", title="제목", summary="한 줄 요약")
    assert chunks[0].startswith("제목\n한 줄 요약\n")


def test_chunking_splits_long_body_into_multiple_rows() -> None:
    body = "\n\n".join("가" * 400 for _ in range(4))
    chunks = chunk_text(body, title="제목", summary="요약")
    assert len(chunks) >= 3
    assert all(chunk.strip() for chunk in chunks)


def test_short_body_is_single_chunk() -> None:
    assert len(chunk_text("짧은 본문", title="제목", summary="요약")) == 1


# --------------------------------------------------------------- 픽스처 수집


@pytest.mark.parametrize("source_key", sorted(COLLECTORS))
def test_fixture_collectors_produce_contract_shaped_ids(source_key: str) -> None:
    collector = COLLECTORS[source_key](SETTINGS, use_fixtures=True)
    programs = collector.fetch()
    assert programs, f"{source_key} 픽스처가 비어 있다"
    for program in programs:
        assert program.external_id.startswith(f"{source_key}:")
        assert program.title and program.body_text
        assert program.form in {"subsidy", "loan", "tax", "product", "law"}
        assert program.issuer_level in {"central", "metro", "local"}


def test_fixtures_cover_at_least_25_programs() -> None:
    total = sum(
        len(cls(SETTINGS, use_fixtures=True).fetch()) for cls in COLLECTORS.values()
    )
    assert total >= 25


def test_full_fixture_run_is_idempotent() -> None:
    """같은 픽스처를 두 번 돌리면 두 번째는 전부 '무변경'이어야 한다."""
    db = InMemoryDatabase()
    pipeline = make_pipeline(db)
    collectors = [cls(SETTINGS, use_fixtures=True) for cls in COLLECTORS.values()]

    pipeline.run(collectors)
    first_total = pipeline.report.totals
    assert first_total.created >= 25 and first_total.updated == 0

    pipeline.run(collectors)
    second_total = pipeline.report.totals
    assert second_total.updated == 0
    assert second_total.unchanged == first_total.created
    assert len(db.raw_documents) == first_total.created


# ------------------------------------------------------- LLM 보완 (SPEC §6.2)
# anthropic 패키지 없이도 돌도록 스텁 클라이언트를 주입한다.


class _StubBlock:
    type = "tool_use"

    def __init__(self, payload):
        self.input = payload


class _StubMessages:
    def __init__(self, payload):
        self.payload = payload
        self.kwargs = None

    def create(self, **kwargs):
        self.kwargs = kwargs
        if isinstance(self.payload, Exception):
            raise self.payload
        return type("R", (), {"content": [_StubBlock(self.payload)]})()


class _StubClient:
    def __init__(self, payload):
        self.messages = _StubMessages(payload)


def test_llm_is_skipped_when_regex_filled_every_field() -> None:
    from ingest.llm_fallback import LLMFallback, apply_fallback, missing_field_groups
    from ingest.parser import parse_eligibility

    text = "서울특별시에 거주하는 만 19세 이상 34세 이하 여성 소상공인 중 소득 3분위 이하"
    rules = parse_eligibility(text)
    assert missing_field_groups(rules) == [], "정규식이 전 필드를 채웠으면 호출 대상이 없다"

    llm = LLMFallback(SETTINGS, client=_StubClient({}))
    apply_fallback(rules, text, llm)
    assert llm.calls == 0
    assert rules.parse_method == "regex"


def test_llm_fills_only_missing_fields_and_marks_mixed() -> None:
    from ingest.llm_fallback import LLMFallback, apply_fallback
    from ingest.parser import parse_eligibility

    text = "만 19세 이상 34세 이하 청년 (자세한 소득 기준은 붙임 참조)"
    rules = parse_eligibility(text)
    assert rules.income_decile_max is None

    payload = {
        "age_min": 99,  # 정규식 결과를 덮어쓰면 안 된다
        "income_decile_max": 5,
        "evidence": {"income_decile_max": "붙임: 중위소득 100% 이하"},
    }
    llm = LLMFallback(SETTINGS, client=_StubClient(payload))
    apply_fallback(rules, text, llm)

    assert rules.age_min == 19, "정규식 결과 보존"
    assert rules.income_decile_max == 5
    assert rules.parse_evidence["income_decile_max"]["method"] == "llm"
    assert rules.parse_method == "mixed"
    assert rules.review_reason is None


def test_llm_output_failing_revalidation_is_dropped_and_isolated() -> None:
    """나이 0~120 / 분위 1~10 서버 재검증 (SPEC §6.2)."""
    from ingest.llm_fallback import LLMFallback, apply_fallback
    from ingest.parser import parse_eligibility

    text = "지원 대상은 공고문을 참고하십시오"
    rules = parse_eligibility(text)
    payload = {"age_min": 999, "income_decile_max": 42, "evidence": {}}
    apply_fallback(rules, text, LLMFallback(SETTINGS, client=_StubClient(payload)))

    assert rules.age_min is None and rules.income_decile_max is None
    assert rules.needs_review and rules.review_reason == "llm_validation_rejected"
    assert rules.blocks_activation


def test_llm_api_failure_isolates_the_record() -> None:
    from ingest.llm_fallback import LLMFallback, apply_fallback
    from ingest.parser import parse_eligibility

    rules = parse_eligibility("지원 대상은 공고문을 참고하십시오")
    llm = LLMFallback(SETTINGS, client=_StubClient(RuntimeError("503")))
    apply_fallback(rules, "지원 대상은 공고문을 참고하십시오", llm)
    assert rules.review_reason == "llm_failed" and rules.blocks_activation


def test_llm_unavailable_does_not_block_activation() -> None:
    """키가 없다고 전 건이 비활성이 되면 서비스가 통째로 빈 결과를 낸다."""
    from ingest.llm_fallback import LLMFallback, apply_fallback
    from ingest.parser import parse_eligibility

    rules = parse_eligibility("지원 대상은 공고문을 참고하십시오")
    apply_fallback(rules, "지원 대상은 공고문을 참고하십시오", LLMFallback(SETTINGS))
    assert rules.needs_review and rules.review_reason == "llm_unavailable"
    assert not rules.blocks_activation


def test_llm_prompt_carries_only_relevant_paragraphs() -> None:
    """전체 문서를 다시 넘기지 않는다 (SPEC §6.2)."""
    from ingest.llm_fallback import relevant_paragraphs

    document = (
        "이 사업은 주거 안정을 목적으로 합니다.\n"
        "문의: 담당자 홍길동 02-000-0000\n"
        "지원 대상은 만 19세 이상 청년입니다.\n"
        "예산은 총 100억원입니다."
    )
    excerpt = relevant_paragraphs(document, ["age"])
    assert "만 19세 이상 청년" in excerpt
    assert "예산은 총 100억원" not in excerpt


def test_llm_region_and_occupation_codes_are_whitelisted() -> None:
    from ingest.llm_fallback import revalidate

    ok, rejected = revalidate({"regions": ["11620"], "occupations": ["self_employed"]})
    assert ok == {"regions": ["11620"], "occupations": ["self_employed"]} and not rejected

    bad, rejected = revalidate({"regions": ["99999"], "occupations": ["astronaut"]})
    assert bad == {} and set(rejected) == {"regions", "occupations"}


# --------------------------------------------------- 요약·절차 생성 (SPEC §7.5)


def test_mock_card_copy_respects_limits() -> None:
    from ingest.summarize import SUMMARY_MAX_CHARS, mock_card_copy

    card = mock_card_copy(make_program())
    assert card.method == "mock"
    assert 0 < len(card.summary) <= SUMMARY_MAX_CHARS
    assert len(card.apply_steps) == 3
    assert all(isinstance(step, str) and step.strip() for step in card.apply_steps)


def test_summarizer_truncates_overlong_llm_summary() -> None:
    from ingest.summarize import SUMMARY_MAX_CHARS, Summarizer as S

    payload = {"summary": "가" * 200, "apply_steps": ["하나", "둘", "셋"]}
    card = S(SETTINGS, client=_StubClient(payload)).generate(make_program())
    assert card.method == "llm"
    assert len(card.summary) <= SUMMARY_MAX_CHARS


def test_summarizer_falls_back_to_mock_on_bad_schema() -> None:
    from ingest.summarize import Summarizer as S

    payload = {"summary": "요약", "apply_steps": ["하나", "둘"]}  # 3단계가 아니다
    card = S(SETTINGS, client=_StubClient(payload)).generate(make_program())
    assert card.method == "mock"
    assert len(card.apply_steps) == 3


def test_summarizer_falls_back_to_mock_on_api_error() -> None:
    from ingest.summarize import Summarizer as S

    card = S(SETTINGS, client=_StubClient(RuntimeError("429"))).generate(make_program())
    assert card.method == "mock"


# --------------------------------------------------------------------------
# 코드리뷰 반영 — 만료 복귀 / 에러 봉투 / DATABASE_URL 강등
# --------------------------------------------------------------------------


def test_expired_program_returning_unchanged_is_reactivated() -> None:
    """전량 대조로 내려간 공고가 그대로 다시 올라오면 복구되어야 한다.

    expire_programs 가 임베딩을 지우므로, fetched_at 만 갱신하면 status 는
    expired 로 남고 임베딩도 비어 영영 매칭에서 빠진다.
    """
    db = InMemoryDatabase()
    pipeline = make_pipeline(db)
    program = make_program()

    pipeline.run_source(FakeCollector([program]))
    program_id = db.get_program_id(program.external_id)
    assert db.programs[program_id]["status"] == "active"

    # 원본 목록에서 사라져 만료 (목록 자체가 비면 소스 장애로 보고 건너뛰므로 다른 id 를 채운다)
    pipeline.run_source(
        FakeCollector([program], source_ids={"fake:999"}), reconcile=True
    )
    assert db.programs[program_id]["status"] == "expired"
    assert db.embeddings.get(program_id) is None

    # 내용 변경 없이 원본에 다시 등장 (stats 는 소스 단위 누적이므로 증분으로 본다)
    unchanged_before = pipeline.report.sources["fake"].unchanged
    stats = pipeline.run_source(FakeCollector([program]))
    assert db.programs[program_id]["status"] == "active"
    assert db.embeddings.get(program_id), "임베딩이 복구되어야 벡터 검색에 다시 잡힌다"
    assert stats.reactivated == 1
    assert stats.unchanged == unchanged_before, "무변경으로 흘려보내면 안 된다"
    assert db.get_program_id(program.external_id) == program_id  # id 유지 (SPEC §3.2)


class EnvelopeCollector(Collector):
    """봉투 검증만 보기 위한 최소 수집기 — `_get` 을 고정 payload 로 대체한다."""

    source_key = "envelope"

    def __init__(self, payload):
        super().__init__(SETTINGS)
        self.payload = payload

    def _query_params(self, *, since, page):
        return {}

    def _items_container(self, payload):
        if not isinstance(payload, dict):
            return None
        body = (payload.get("response") or {}).get("body")
        if not isinstance(body, dict) or "items" not in body:
            return None
        return list(body.get("items") or [])

    def _map_item(self, item):
        return None

    def _get(self, params):
        return self.payload


def test_error_envelope_is_not_treated_as_empty_page() -> None:
    """HTTP 200 + 에러 봉투를 0건으로 처리하면 워크플로는 녹색인 채 데이터가 정지한다."""
    collector = EnvelopeCollector(
        {"response": {"header": {"resultCode": "22", "resultMsg": "LIMITED NUMBER OF SERVICE REQUESTS"}}}
    )
    with pytest.raises(CollectorError):
        collector.fetch()


def test_unknown_schema_is_not_treated_as_empty_page() -> None:
    collector = EnvelopeCollector({"unexpected": {"shape": []}})
    with pytest.raises(CollectorError):
        collector.fetch()


def test_genuinely_empty_page_is_accepted() -> None:
    """증분 수집에서 '이번엔 변경분 0건'은 정상이다 — 에러로 만들면 안 된다."""
    collector = EnvelopeCollector(
        {"response": {"header": {"resultCode": "00"}, "body": {"items": []}}}
    )
    assert collector.fetch() == []


def test_live_run_without_database_url_fails_instead_of_degrading() -> None:
    """DATABASE_URL 이 비었는데 조용히 인메모리로 강등하면 데이터가 무기한 정지한다."""
    from ingest.cli import ConfigError, _make_database

    with pytest.raises(ConfigError):
        _make_database(False, Settings(database_url=""))

    db, in_memory = _make_database(True, Settings(database_url=""))
    assert in_memory and isinstance(db, InMemoryDatabase)  # --dry-run 은 그대로 허용
