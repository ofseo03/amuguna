"""SPEC §10 파서 검증 — 손으로 만든 자격요건 문장 40개 (정상 30 + 함정 10).

함정 케이스의 목적은 **오탐을 잡는 것**이다. SPEC §10 이 예로 든
"만 65세 이상 어르신을 모시는 가구"(→ 신청자 나이 조건 아님)를 포함한다.
누락은 NULL(= 통과)로 흡수되지만 오탐은 잘못된 탈락을 만든다 (SPEC §7.3).
"""

from __future__ import annotations

import pytest

from ingest.dictionaries import midrate_to_decile
from ingest.parser import parse_eligibility

# --------------------------------------------------------------------------
# 정상 30건 — (문장, 기대하는 필드 부분집합)
# 기대값에 없는 필드는 검사하지 않는다 (같은 문장이 여러 축을 동시에 채우기 때문).
# --------------------------------------------------------------------------
NORMAL_CASES: list[tuple[str, dict]] = [
    ("만 19세 이상 34세 이하 청년", {"age_min": 19, "age_max": 34}),
    ("만 65세 이상 어르신", {"age_min": 65}),
    ("만 40세 미만인 자", {"age_max": 39}),  # 미만 = 경계 미포함
    ("만 19~39세 청년", {"age_min": 19, "age_max": 39}),
    ("19세 이상 34세 이하", {"age_min": 19, "age_max": 34}),
    ("만 18세 부터 신청 가능", {"age_min": 18}),
    ("만 34세까지 신청할 수 있습니다", {"age_max": 34}),
    ("만 60세 초과 가입자", {"age_min": 61}),  # 초과 = 경계 미포함
    ("만 19세 이상 39세 미만 청년", {"age_min": 19, "age_max": 38}),
    ("만 15세 이상 69세 이하 구직자", {"age_min": 15, "age_max": 69, "occupations": ["jobseeker"]}),
    ("기준 중위소득 60% 이하 가구", {"income_decile_max": 3}),
    ("기준 중위소득 150% 이하", {"income_decile_max": 7}),
    ("중위소득 100% 이하 가구", {"income_decile_max": 5}),
    ("기준 중위소득 48% 이하 가구", {"income_decile_max": 2}),
    ("소득 3분위 이하 가구", {"income_decile_max": 3}),
    ("차상위계층 또는 기초생활수급 가구", {"income_decile_max": 2}),
    ("기준 중위소득 180% 이하 가구원", {"income_decile_max": 8}),
    ("여성만 신청 가능합니다", {"gender": "F"}),
    ("남성에 한정합니다", {"gender": "M"}),
    ("여성 가구주에 한함", {"gender": "F"}),
    ("서울특별시 관악구에 거주하는 자", {"regions": ["11620"]}),
    ("부산광역시 해운대구 소재 사업장", {"regions": ["26350"]}),
    ("전라남도 순천시 거주 농업인", {"regions": ["46150"], "occupations": ["farmer_fisher"]}),
    ("경기도에 주소를 둔 세대", {"regions": ["41"]}),
    ("소상공인 및 자영업자", {"occupations": ["self_employed"]}),
    ("대학생 및 대학원생", {"occupations": ["student"]}),
    ("프리랜서 및 특수형태근로종사자", {"occupations": ["freelancer"]}),
    (
        "만 19세 이상 34세 이하이며 기준 중위소득 150% 이하인 서울특별시 거주 청년",
        {"age_min": 19, "age_max": 34, "income_decile_max": 7, "regions": ["11"]},
    ),
    ("기초생활수급 가구의 만 65세 이상 어르신", {"age_min": 65, "income_decile_max": 2}),
    (
        "부산광역시 해운대구에 사업장을 둔 소상공인",
        {"regions": ["26350"], "occupations": ["self_employed"]},
    ),
]

# --------------------------------------------------------------------------
# 함정 10건 — (문장, 반드시 NULL 이어야 하는 필드, 설명)
# --------------------------------------------------------------------------
TRAP_CASES: list[tuple[str, dict, str]] = [
    (
        "만 65세 이상 어르신을 모시는 가구",
        {"age_min": None, "age_max": None},
        "SPEC §10 명시 함정 — 나이는 부양 대상의 것이지 신청자 것이 아니다",
    ),
    (
        "만 12세 이하 아동을 양육하는 가정",
        {"age_min": None, "age_max": None},
        "양육 대상 아동의 나이",
    ),
    (
        "자녀가 만 6세 이하인 가구",
        {"age_min": None, "age_max": None},
        "조건 앞쪽이 부양가족 지칭",
    ),
    (
        "여성가족부 소관 아이돌봄 사업",
        {"gender": None},
        "기관명의 '여성' — 성별 조건이 아니다",
    ),
    (
        "여성기업 확인서를 보유한 중소기업",
        {"gender": None, "occupations": None},
        "기업 속성이지 신청자 성별·직업이 아니다 ('중소기업'의 '소기업'도 잡히면 안 된다)",
    ),
    (
        "사업 개시 후 3년 이상 경과한 기업",
        {"age_min": None, "age_max": None},
        "'년'은 '세'가 아니다 — 업력을 나이로 읽으면 안 된다",
    ),
    (
        "기준 중위소득 150% 초과 가구는 지원 대상에서 제외됩니다",
        {"income_decile_max": None},
        "'초과 제외'를 '이하'로 뒤집어 읽지 않는다 — extra_conditions 로만 남긴다",
    ),
    (
        "부산광역시 해운대구 소재 점포",
        {"regions": ["26350"]},
        "'해운대구'의 '대구'가 대구광역시(27)로 잡히면 안 된다",
    ),
    (
        "중구에 거주하는 자",
        {"regions": None},
        "동명 시군구(서울 중구 / 울산 중구) — 시도 문맥이 없으면 조건으로 쓰지 않는다",
    ),
    (
        "공무원연금 수급자는 제외합니다",
        {"occupations": None},
        "제외 조항의 직업을 자격 조건으로 뒤집어 읽지 않는다",
    ),
]


def test_case_counts() -> None:
    """SPEC §10: 정상 30 + 함정 10 = 40."""
    assert len(NORMAL_CASES) == 30
    assert len(TRAP_CASES) == 10
    assert len(NORMAL_CASES) + len(TRAP_CASES) == 40


@pytest.mark.parametrize("sentence,expected", NORMAL_CASES, ids=[c[0] for c in NORMAL_CASES])
def test_normal_cases(sentence: str, expected: dict) -> None:
    rules = parse_eligibility(sentence)
    for field, want in expected.items():
        got = getattr(rules, field)
        assert got == want, f"{field}: {got!r} != {want!r} — {sentence!r}"


@pytest.mark.parametrize(
    "sentence,expected,why", TRAP_CASES, ids=[c[0] for c in TRAP_CASES]
)
def test_trap_cases(sentence: str, expected: dict, why: str) -> None:
    rules = parse_eligibility(sentence)
    for field, want in expected.items():
        got = getattr(rules, field)
        assert got == want, f"{field}: {got!r} != {want!r} — {why}"


# ------------------------------------------------------------- 부수 계약


def test_dependent_trap_is_kept_as_extra_condition() -> None:
    """버린 조건은 조용히 사라지지 않고 '추가 확인 필요'로 남는다 (SPEC §6.3)."""
    rules = parse_eligibility("만 65세 이상 어르신을 모시는 가구")
    kinds = {c["kind"] for c in rules.extra_conditions}
    assert "dependent_person" in kinds


def test_unformalizable_conditions_go_to_extra_conditions() -> None:
    rules = parse_eligibility(
        "관내 6개월 이상 계속 거주하며 무주택 세대주이고 최근 1년간 유사 지원을 받지 않은 자"
    )
    kinds = {c["kind"] for c in rules.extra_conditions}
    assert {"residency_period", "housing", "duplicate_support"} <= kinds
    # 정형 필드는 건드리지 않는다 — 필터링에 쓰지 않는다 (SPEC §6.3)
    assert rules.age_min is None and rules.income_decile_max is None


def test_income_exception_is_recorded_but_not_filtered() -> None:
    rules = parse_eligibility("기준 중위소득 150% 초과 가구는 지원 대상에서 제외됩니다")
    assert rules.income_decile_max is None
    assert "income_exception" in {c["kind"] for c in rules.extra_conditions}


def test_parse_evidence_records_matched_span() -> None:
    """오탐 시 어느 패턴이 범인인지 특정할 수 있어야 한다 (SPEC §1 차별점 2)."""
    rules = parse_eligibility("만 19세 이상 34세 이하 청년")
    assert "age_min" in rules.parse_evidence
    evidence = rules.parse_evidence["age_min"]
    assert evidence["method"] == "regex"
    assert "19" in evidence["text"]
    assert rules.parse_method == "regex"


def test_confidence_low_when_nothing_extracted() -> None:
    rules = parse_eligibility("자세한 내용은 공고문을 참고하시기 바랍니다")
    assert rules.filled_fields() == []
    assert rules.confidence == pytest.approx(0.2)


def test_confidence_higher_with_more_fields() -> None:
    few = parse_eligibility("만 19세 이상")
    many = parse_eligibility("만 19세 이상 34세 이하이며 서울특별시 거주 소상공인")
    assert many.confidence > few.confidence


def test_reversed_age_range_is_discarded() -> None:
    """오탈자 원문이 age_min > age_max 를 만들면 조건 자체를 버린다."""
    rules = parse_eligibility("만 65세 이상 19세 이하")
    assert rules.age_min is None and rules.age_max is None


def test_empty_text_is_all_null() -> None:
    rules = parse_eligibility("")
    assert rules.filled_fields() == []
    assert rules.extra_conditions == []


@pytest.mark.parametrize(
    "percent,decile",
    [(30, 2), (50, 2), (60, 3), (75, 3), (100, 5), (120, 6), (150, 7), (180, 8), (200, 9), (300, 10)],
)
def test_midrate_to_decile_uses_shared_table(percent: int, decile: int) -> None:
    """shared/midincome_to_decile.json 계약 (§6.1)."""
    assert midrate_to_decile(percent) == decile


def test_regions_use_shared_admin_codes() -> None:
    """시군구가 특정되면 5자리, 시도만이면 2자리 (SPEC §5 regions 규약)."""
    assert parse_eligibility("서울특별시 관악구 거주").regions == ["11620"]
    assert parse_eligibility("서울특별시 거주").regions == ["11"]


def test_open_to_all_products_get_no_occupation_condition() -> None:
    """'실명의 개인 및 개인사업자' 에 self_employed 를 걸면 사무직이 잘못 탈락한다."""
    assert parse_eligibility("실명의 개인 및 개인사업자").occupations is None
    assert parse_eligibility("사업자등록증을 보유한 개인사업자").occupations == ["self_employed"]


def test_gender_requires_a_person_noun() -> None:
    """'여성 + 사람'은 성별 조건, '여성 + 조직'은 아니다."""
    assert parse_eligibility("여성 소상공인 대상 특별자금").gender == "F"
    assert parse_eligibility("여성 한부모 가구").gender == "F"
    assert parse_eligibility("남성 근로자에 한함").gender == "M"
    assert parse_eligibility("여성기업 확인서 보유 기업").gender is None
    assert parse_eligibility("여성가족부 공고").gender is None


def test_age_descriptor_is_not_also_an_occupation_condition() -> None:
    """'만 65세 이상 어르신' → 나이 조건만. retired 까지 걸면 67세 무직자가 탈락한다."""
    rules = parse_eligibility("만 65세 이상 어르신 중 소득인정액이 선정기준액 이하인 분")
    assert rules.age_min == 65
    assert rules.occupations is None
    # 나이 조건이 없으면 직업 신호로 남긴다
    assert parse_eligibility("노인 대상 일자리 연계 사업").occupations == ["retired"]


# --------------------------------------------------------------------------
# 배타적 연령 구간 (코드리뷰 지적) — 좁히지 말고 비운다
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "만 19세 이상 34세 이하 또는 만 65세 이상인 자",
        "만 19~34세 및 만 65세 이상 어르신",
        "만 19세 이상 34세 이하 혹은 만 65세 이상",
    ],
)
def test_disjoint_age_ranges_are_not_narrowed(text: str) -> None:
    """'19~34세 또는 65세 이상'을 19~34세로 저장하면 고령자가 전원 오탈락한다.

    단일 [min, max] 로 표현할 수 없으므로 NULL(= 통과) 로 두고 원문을 노출한다.
    """
    rules = parse_eligibility(text)
    assert rules.age_min is None and rules.age_max is None
    assert rules.review_reason == "age_alternatives"
    assert "age" in rules.unrepresentable  # LLM 보완이 다시 좁히지 못하게
    kinds = [c.get("kind") for c in rules.extra_conditions]
    assert "age_alternatives" in kinds, "원문 조건이 상세 화면에 남아야 한다"


def test_single_age_range_is_still_parsed() -> None:
    """대안 감지가 정상 단일 구간까지 비우면 안 된다 (과잉 반응 방지)."""
    rules = parse_eligibility("만 19세 이상 34세 이하 청년")
    assert (rules.age_min, rules.age_max) == (19, 34)
    assert rules.review_reason != "age_alternatives"


def test_distant_age_mention_does_not_trigger_alternatives() -> None:
    """접속사 없이 멀리 떨어진 언급은 대안으로 보지 않는다 (기존 동작 유지)."""
    rules = parse_eligibility(
        "서울시 관악구에 거주하는 만 19세 이상 34세 이하 청년. "
        "별도 공고로 만 65세 이상 어르신 대상 사업도 운영합니다."
    )
    assert (rules.age_min, rules.age_max) == (19, 34)


def test_unrepresentable_age_blocks_llm_fallback() -> None:
    from ingest.llm_fallback import missing_field_groups

    rules = parse_eligibility("만 19세 이상 34세 이하 또는 만 65세 이상")
    assert "age" not in missing_field_groups(rules)
