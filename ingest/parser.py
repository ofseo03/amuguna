"""① 자격요건 파싱 — 정규식 우선 (SPEC §6).

설계 원칙 (SPEC §1 차별점 2, §6.3):

* **정규식이 1차, LLM은 보완.** 결과가 항상 같고, 공짜고, 빠르다.
* **근거(matched span)를 남긴다.** 오탐이 나오면 어느 패턴이 범인인지 특정할 수 있다.
* **누락이 오탐보다 싸다.** 확신이 없으면 필드를 비우고(NULL = 통과)
  원문을 ``extra_conditions`` 로 넘긴다. 잘못된 탈락을 만들지 않는다.

SPEC §6.1 은 "형태를 보여주는 예시이며 확정 스펙이 아니다"라고 명시한다.
아래 패턴은 그 예시를 기준선으로 삼아 확장한 것이고, **W1 실물 응답 확인 후
미매칭 리포트 루프(§6.1)로 갱신해야 한다.**
"""

from __future__ import annotations

import re
from typing import Any, Callable, Iterable, Sequence

from .dictionaries import (
    has_dependent_context,
    lookup_occupations,
    lookup_regions,
    midrate_to_decile,
    normalize_text,
)
from .models import CollectedProgram, EligibilityRules

Handler = Callable[[re.Match[str]], dict[str, Any]]

# 앞쪽에 오면 '제3자(부양가족)의 속성'을 뜻하는 명사 — 신청자 조건이 아니다.
PREFIX_DEPENDENT_NOUNS = ("자녀", "아동", "손자녀", "피부양자", "배우자", "부양가족")

_DASH = r"[~∼〜–—\-]"


# --------------------------------------------------------------------- 나이
# 긴 패턴(범위)을 먼저 둔다. 앞선 패턴이 먹은 구간은 뒤 패턴이 다시 먹지 않는다.
AGE: Sequence[tuple[str, Handler]] = (
    # '만 19세 이상 34세 이하' / '19세 이상 만 34세 까지'
    (
        rf"만?\s*(\d{{1,3}})\s*세\s*(?:이상|부터)\s*(?:만\s*)?(\d{{1,3}})\s*세\s*(?:이하|까지)",
        lambda m: {"age_min": int(m[1]), "age_max": int(m[2])},
    ),
    # '만 19세 이상 39세 미만' — 미만은 경계 미포함 (SPEC §6.1 주석)
    (
        rf"만?\s*(\d{{1,3}})\s*세\s*(?:이상|부터)\s*(?:만\s*)?(\d{{1,3}})\s*세\s*미만",
        lambda m: {"age_min": int(m[1]), "age_max": int(m[2]) - 1},
    ),
    # '만 19~34세' / '19-34세'
    (
        rf"만?\s*(\d{{1,3}})\s*{_DASH}\s*(\d{{1,3}})\s*세(?!대)",
        lambda m: {"age_min": int(m[1]), "age_max": int(m[2])},
    ),
    (r"만?\s*(\d{1,3})\s*세\s*미만", lambda m: {"age_max": int(m[1]) - 1}),
    (r"만?\s*(\d{1,3})\s*세\s*초과", lambda m: {"age_min": int(m[1]) + 1}),
    (r"만?\s*(\d{1,3})\s*세\s*(?:이상|부터)", lambda m: {"age_min": int(m[1])}),
    (r"만?\s*(\d{1,3})\s*세\s*(?:이하|까지)", lambda m: {"age_max": int(m[1])}),
)

# ------------------------------------------------------------------- 소득분위
INCOME: Sequence[tuple[str, Handler]] = (
    (
        r"(?:기준\s*)?중위소득\s*(\d{1,3})\s*%\s*(?:이하|까지)",
        lambda m: {"income_decile_max": midrate_to_decile(int(m[1]))},
    ),
    (r"소득\s*(\d{1,2})\s*분위\s*이하", lambda m: {"income_decile_max": int(m[1])}),
    (r"(\d{1,2})\s*분위\s*이하", lambda m: {"income_decile_max": int(m[1])}),
    (r"차상위\s*계층|기초생활\s*수급|의료급여\s*수급", lambda m: {"income_decile_max": 2}),
)

# --------------------------------------------------------------------- 성별
# '여성' + 사람 명사만 성별 조건으로 본다. '여성기업'·'여성가족부'처럼
# 기관·법인 속성에 붙은 '여성'을 신청자 성별로 읽으면 남성 신청자가 잘못 탈락한다.
_PERSON_NOUNS = r"(?:청년|어르신|노인|농업인|어업인|소상공인|자영업자|장애인|가장|한부모|근로자|구직자|가구주)"
GENDER: Sequence[tuple[str, Handler]] = (
    (
        rf"여성만|여성에\s*한(?:함|정)|여성으로\s*한정|여성\s*한정|여성\s*{_PERSON_NOUNS}",
        lambda m: {"gender": "F"},
    ),
    (
        rf"남성만|남성에\s*한(?:함|정)|남성으로\s*한정|남성\s*한정|남성\s*{_PERSON_NOUNS}",
        lambda m: {"gender": "M"},
    ),
)

# ------------------------------------------------------- extra_conditions (§6.3)
# 정형 필드에 안 들어가는 조건. **필터링에 쓰지 않고** 상세 화면에만 노출한다.
EXTRA_CONDITIONS: Sequence[tuple[str, str]] = (
    ("housing", r"무주택(?:자|세대주|세대구성원)?|주택\s*미소유"),
    ("residency_period", r"\d+\s*(?:개월|년)\s*이상\s*(?:계속\s*)?(?:거주|주민등록)"),
    ("duplicate_support", r"중복\s*(?:수혜|지원)\s*(?:불가|제한)|유사\s*지원을?\s*받지\s*않은"),
    ("credit", r"신용\s*등급|신용\s*점수|연체\s*중|채무\s*불이행"),
    ("business_history", r"사업자\s*등록|사업\s*개시\s*후\s*\d+\s*년|업력\s*\d+\s*년"),
    ("insurance", r"4대\s*보험|고용보험\s*가입|건강보험료\s*본인부담"),
    ("assets", r"재산\s*과세표준|자산\s*\d+\s*(?:만원|억)|총자산"),
    ("income_exception", r"중위소득\s*\d{1,3}\s*%\s*(?:초과|이상)"),
    ("household", r"세대주|세대원\s*전원|1인\s*가구"),
    ("education", r"재학\s*중|졸업\s*후\s*\d+\s*년"),
    ("military", r"병역\s*(?:필|의무\s*이행)|군\s*복무"),
    ("prior_training", r"교육\s*(?:이수|수료)\s*(?:자|필수)"),
)

#: 상세 화면 노출용 한국어 라벨.
EXTRA_CONDITION_LABELS = {
    "housing": "주택 보유 조건",
    "residency_period": "거주 기간 조건",
    "duplicate_support": "중복 수혜 제한",
    "credit": "신용 조건",
    "business_history": "사업 이력 조건",
    "insurance": "보험 가입 조건",
    "assets": "재산 조건",
    "income_exception": "소득 예외 조건",
    "household": "세대 구성 조건",
    "education": "학적 조건",
    "military": "병역 조건",
    "prior_training": "사전 교육 조건",
}

_CLAUSE_SPLIT = re.compile(r"[\n·;,]|(?<=[.。])\s")


# ------------------------------------------------------------------ 내부 유틸


def _prefix_dependent(text: str, start: int) -> str | None:
    """조건 문구 **앞**이 부양가족 지칭인지 (예: '자녀가 만 6세 이하인 가구')."""
    head = text[max(0, start - 10) : start]
    for noun in PREFIX_DEPENDENT_NOUNS:
        if noun in head:
            return noun
    return None


def _dependent_reason(text: str, start: int, end: int) -> str | None:
    return has_dependent_context(text, start, end) or _prefix_dependent(text, start)


def _clause_of(text: str, start: int, end: int) -> str:
    """매칭 구간이 속한 절(clause) — extra_conditions 원문 보존용."""
    left = 0
    right = len(text)
    for m in _CLAUSE_SPLIT.finditer(text):
        if m.end() <= start:
            left = m.end()
        elif m.start() >= end:
            right = m.start()
            break
    return text[left:right].strip(" \t-–—·")


def _apply(
    patterns: Iterable[tuple[str, Handler]],
    text: str,
    out: dict[str, Any],
    evidence: dict[str, Any],
    consumed: list[tuple[int, int]],
    *,
    dependent_guard: bool,
    rejected: list[dict[str, str]],
    conflicts: list[dict[str, Any]] | None = None,
) -> None:
    for pattern, handler in patterns:
        for m in re.finditer(pattern, text):
            if any(m.start() < ce and cs < m.end() for cs, ce in consumed):
                continue  # 이미 더 구체적인 패턴이 먹은 구간
            if dependent_guard:
                reason = _dependent_reason(text, m.start(), m.end())
                if reason:
                    # 신청자 조건이 아니라 '부양 대상'의 조건 — 정형 필드에 넣지 않는다.
                    rejected.append(
                        {
                            "kind": "dependent_person",
                            "text": _clause_of(text, m.start(), m.end()),
                            "reason": f"'{reason}' 문맥 — 신청자 본인 조건이 아님",
                        }
                    )
                    consumed.append((m.start(), m.end()))
                    continue
            values = handler(m)
            fresh = {k: v for k, v in values.items() if out.get(k) is None}
            if not fresh:
                # 이미 채워진 필드에 **다른 값**을 주는 매치 = 별개의 대안 조건일 수 있다.
                # 그냥 버리면 '19~34세 또는 65세 이상'이 조용히 19~34세로 좁혀진다.
                if conflicts is not None and any(
                    out.get(k) is not None and out[k] != v for k, v in values.items()
                ):
                    conflicts.append(
                        {"start": m.start(), "end": m.end(), "text": m.group(0), "values": values}
                    )
                continue
            out.update(fresh)
            for key in fresh:
                evidence[key] = {
                    "text": m.group(0),
                    "start": m.start(),
                    "end": m.end(),
                    "pattern": pattern,
                    "method": "regex",
                }
            consumed.append((m.start(), m.end()))


#: 두 조건을 '둘 중 하나'로 잇는 표현. 이게 사이에 있으면 뒤 조건은 앞 조건의
#: 상세화가 아니라 **대안**이다.
_ALTERNATION = re.compile(r"또는|혹은|이거나|거나|및|,|·|/")

#: 대안 판정에 쓰는 최대 간격. 이보다 멀면 같은 절이 아니라고 본다.
_ALTERNATION_GAP = 30


def _alternation_between(text: str, a: tuple[int, int], b: tuple[int, int]) -> bool:
    """두 매치 구간 사이가 '또는' 류로 이어져 있는지."""
    lo, hi = (a, b) if a[1] <= b[0] else (b, a)
    gap = text[lo[1] : hi[0]]
    if len(gap) > _ALTERNATION_GAP:
        return False
    return bool(_ALTERNATION.search(gap))


def _resolve_age_alternatives(
    text: str,
    out: dict[str, Any],
    evidence: dict[str, Any],
    conflicts: list[dict[str, Any]],
) -> dict[str, str] | None:
    """서로 배타적인 연령 구간이 둘 이상이면 정형 필드를 비운다.

    `만 19세 이상 34세 이하 또는 만 65세 이상` 같은 규칙은 단일 [min, max] 로
    표현할 수 없다. 먼저 잡힌 구간만 남기면 65세 이상 신청자가 전원 오탈락하고,
    그 사실이 아무 데도 남지 않는다. 좁히는 것보다 **조건 없음(NULL = 통과) +
    원문 노출**이 안전하다 (SPEC §7.3 'NULL = 통과', §6.3 extra_conditions).
    """
    spans = [
        (v["start"], v["end"])
        for k, v in evidence.items()
        if k in ("age_min", "age_max") and isinstance(v, dict) and "start" in v
    ]
    if not spans:
        return None
    for conflict in conflicts:
        c_span = (conflict["start"], conflict["end"])
        if not any(_alternation_between(text, span, c_span) for span in spans):
            continue
        lo = min(min(s for s, _ in spans), c_span[0])
        hi = max(max(e for _, e in spans), c_span[1])
        out["age_min"] = out["age_max"] = None
        evidence.pop("age_min", None)
        evidence.pop("age_max", None)
        return {
            "kind": "age_alternatives",
            "text": _clause_of(text, lo, hi),
            "reason": "연령 조건이 둘 이상의 구간으로 나뉘어 있어 자동 판정하지 않습니다",
        }
    return None


def _extract_extra_conditions(text: str) -> list[dict[str, str]]:
    found: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for kind, pattern in EXTRA_CONDITIONS:
        for m in re.finditer(pattern, text):
            clause = _clause_of(text, m.start(), m.end())
            key = (kind, clause)
            if key in seen or not clause:
                continue
            seen.add(key)
            found.append(
                {
                    "kind": kind,
                    "label": EXTRA_CONDITION_LABELS.get(kind, kind),
                    "text": clause,
                    "matched": m.group(0),
                }
            )
    return found


def compute_confidence(rules: EligibilityRules) -> float:
    """필드별 추출 방법으로 신뢰도를 만든다.

    regex 로 잡힌 필드 1.0, LLM 보완 0.55. 채워진 필드가 3개 이상이면 만점 배율.
    아무 조건도 못 찾으면 0.2 — 'NULL = 통과'라 서비스는 정상 동작하지만,
    '정말 조건이 없는 공고'인지 '파서가 놓친 것'인지는 구분이 안 되기 때문이다.
    """
    filled = rules.filled_fields()
    if not filled:
        return 0.2
    weights = []
    for name in filled:
        method = (rules.parse_evidence.get(name) or {}).get("method", "regex")
        weights.append(0.55 if method == "llm" else 1.0)
    base = sum(weights) / len(weights)
    coverage = min(1.0, len(filled) / 3)
    score = base * (0.6 + 0.4 * coverage)
    if rules.needs_review:
        score *= 0.8
    return round(min(1.0, score), 3)


def resolve_parse_method(evidence: dict[str, Any]) -> str:
    # 진단용 비필드 키(_rejected_fields 등)는 무시한다.
    methods = {
        v.get("method", "regex")
        for key, v in evidence.items()
        if isinstance(v, dict) and not key.startswith("_")
    } - {None}
    if not methods:
        return "regex"
    if methods == {"llm"}:
        return "llm"
    if len(methods) > 1:
        return "mixed"
    return methods.pop()


# --------------------------------------------------------------------- 공개 API


def parse_eligibility(raw_text: str) -> EligibilityRules:
    """자격요건 문구 → 정형 규칙 (정규식 + 사전 룩업만. LLM 미사용)."""
    text = normalize_text(raw_text)
    out: dict[str, Any] = {}
    evidence: dict[str, Any] = {}
    consumed: list[tuple[int, int]] = []
    rejected: list[dict[str, str]] = []
    age_conflicts: list[dict[str, Any]] = []
    unrepresentable: list[str] = []

    if text:
        _apply(
            AGE,
            text,
            out,
            evidence,
            consumed,
            dependent_guard=True,
            rejected=rejected,
            conflicts=age_conflicts,
        )
        # 소득은 가구 단위 조건이라 부양가족 가드를 걸지 않는다
        # ('다자녀 가구 중 중위소득 150% 이하'가 통째로 버려지는 것을 막는다).
        _apply(INCOME, text, out, evidence, consumed, dependent_guard=False, rejected=rejected)
        _apply(GENDER, text, out, evidence, consumed, dependent_guard=False, rejected=rejected)

    # 나이 범위 뒤집힘 방어 (예: '34세 이상 19세 이하' 같은 오탈자 원문)
    if out.get("age_min") is not None and out.get("age_max") is not None:
        if out["age_min"] > out["age_max"]:
            out["age_min"] = out["age_max"] = None
            evidence.pop("age_min", None)
            evidence.pop("age_max", None)

    # '19~34세 또는 65세 이상' 처럼 배타적 구간이 여럿이면 좁히지 않고 비운다.
    age_alternatives = (
        _resolve_age_alternatives(text, out, evidence, age_conflicts) if age_conflicts else None
    )
    if age_alternatives:
        rejected.append(age_alternatives)
        # LLM 보완이 다시 하나의 구간으로 좁히지 못하게 막는다 (§6.2 는 미추출 필드만 채운다).
        unrepresentable.append("age")

    has_age = out.get("age_min") is not None or out.get("age_max") is not None
    regions, region_ev = lookup_regions(text) if text else ([], [])
    occupations, occupation_ev = (
        lookup_occupations(text, drop_age_descriptors=has_age) if text else ([], [])
    )
    if regions:
        evidence["regions"] = {"text": ", ".join(region_ev), "method": "regex"}
    if occupations:
        evidence["occupations"] = {"text": ", ".join(occupation_ev), "method": "regex"}

    extras = _extract_extra_conditions(text) if text else []
    extras.extend(rejected)

    rules = EligibilityRules(
        age_min=out.get("age_min"),
        age_max=out.get("age_max"),
        gender=out.get("gender"),
        regions=regions or None,  # 빈 리스트가 아니라 NULL = 전국
        occupations=occupations or None,
        income_decile_max=out.get("income_decile_max"),
        extra_conditions=extras,
        parse_evidence=evidence,
        unrepresentable=unrepresentable,
    )
    if age_alternatives:
        rules.needs_review = True
        rules.review_reason = "age_alternatives"
    rules.parse_method = resolve_parse_method(evidence)
    rules.confidence = compute_confidence(rules)
    return rules


def eligibility_source_text(program: CollectedProgram) -> str:
    """파싱 대상 텍스트 — 자격요건 필드가 따로 오면 그것을, 없으면 본문을 쓴다."""
    if program.eligibility_text.strip():
        return program.eligibility_text
    return program.body_text


def parse_program(program: CollectedProgram) -> EligibilityRules:
    return parse_eligibility(eligibility_source_text(program))
