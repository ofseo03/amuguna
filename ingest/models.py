"""파이프라인 내부 데이터 모델.

DB 컬럼 이름은 SPEC §5 스키마와 1:1로 맞춘다 (교차팀 계약).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from typing import Any

from .dictionaries import normalize_text

#: content_hash 계산에 들어가는 필드 (SPEC §3.2).
#: 조회수·응답 생성 시각처럼 매 호출 바뀌는 필드는 **절대** 넣지 않는다 —
#: 넣으면 전 건이 매일 '수정'으로 판정돼 재파싱·재임베딩이 전량 발생한다.
HASHED_FIELDS = (
    "title",
    "body_text",
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
    "eligibility_text",
)


@dataclass
class CollectedProgram:
    """수집기가 소스 응답을 정규화한 결과 (파이프라인 입력)."""

    external_id: str  # 'source_key:원본고유번호' (SPEC §3.2) — UNIQUE
    source_key: str
    source_url: str
    title: str
    body_text: str
    eligibility_text: str = ""
    form: str = "subsidy"  # subsidy | loan | tax | product | law
    issuer: str = ""
    issuer_level: str = "central"  # central | metro | local
    benefit_amount_text: str = ""
    benefit_amount_min: int | None = None
    benefit_amount_max: int | None = None
    apply_url: str = ""
    apply_method: str = ""
    starts_at: str | None = None  # ISO date, NULL 가능
    ends_at: str | None = None
    is_always_open: bool = False
    raw_body: dict[str, Any] = field(default_factory=dict)  # 소스 응답 원문 그대로

    # ---- 해시 ---------------------------------------------------------

    def comparison_fields(self) -> dict[str, Any]:
        """정규화된 비교 대상 필드만 (SPEC §3.2)."""
        out: dict[str, Any] = {}
        for name in HASHED_FIELDS:
            value = getattr(self, name)
            out[name] = normalize_text(value) if isinstance(value, str) else value
        return out

    def content_hash(self) -> str:
        payload = json.dumps(
            self.comparison_fields(), ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def embedding_source(self) -> str:
        """임베딩 입력 원본 — 자격요건 문단을 본문에 포함한다 (SPEC §7.1)."""
        parts = [self.body_text]
        if self.eligibility_text and self.eligibility_text not in self.body_text:
            parts.append("[자격요건]\n" + self.eligibility_text)
        return "\n\n".join(p for p in parts if p)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class EligibilityRules:
    """SPEC §5 eligibility_rules 1행. NULL = 무관 = 통과."""

    age_min: int | None = None
    age_max: int | None = None
    gender: str | None = None  # None | 'M' | 'F'
    regions: list[str] | None = None  # 행정구역 코드 (2자리/5자리). None = 전국
    occupations: list[str] | None = None
    income_decile_max: int | None = None
    extra_conditions: list[dict[str, str]] = field(default_factory=list)
    parse_method: str = "regex"  # regex | llm | mixed
    parse_evidence: dict[str, Any] = field(default_factory=dict)
    confidence: float = 0.0

    # -- 이하 세 필드는 eligibility_rules 컬럼이 아니다 (파이프라인 내부 신호) --
    needs_review: bool = False
    review_reason: str | None = None
    #: 정형 필드로 표현할 수 없다고 판정된 필드 그룹 (예: 배타적 연령 구간이 둘 이상).
    #: LLM 보완이 이 그룹을 하나의 값으로 좁히지 못하게 막는다 (SPEC §6.2).
    unrepresentable: list[str] = field(default_factory=list)

    #: 이 사유들만 programs.status = 'needs_review' 로 승격한다.
    #: LLM이 아예 설정되지 않은 상태(llm_unavailable)는 '이 공고의 문제'가 아니라
    #: 배치 구성의 문제다. 이걸로 전 건을 비활성화하면 'NULL = 통과'(SPEC §7.3)
    #: 원칙이 무너지고 서비스가 통째로 빈 결과를 낸다.
    BLOCKING_REVIEW_REASONS = ("llm_failed", "llm_validation_rejected")

    @property
    def blocks_activation(self) -> bool:
        return self.review_reason in self.BLOCKING_REVIEW_REASONS

    def to_row(self) -> dict[str, Any]:
        row = asdict(self)
        row.pop("needs_review")
        row.pop("review_reason")
        row.pop("unrepresentable")
        return row

    def filled_fields(self) -> list[str]:
        names = ("age_min", "age_max", "gender", "regions", "occupations", "income_decile_max")
        return [n for n in names if getattr(self, n) not in (None, [], "")]
