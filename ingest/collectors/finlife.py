"""T1 — 금융감독원 금융상품통합비교공시 (finlife.fss.or.kr).

예·적금·대출·연금 상품 (SPEC §3.3 T1 셋째 줄).

이 소스는 성격이 다르다: **자격조건이 거의 없다.** `NULL = 통과` 규칙(SPEC §7.3)상
전 상품이 항상 집합 A에 들어오므로, P3(입력 건너뜀) 경로에서 범용 예·적금이
상위를 도배할 수 있다 — SPEC §10 'A-only 경로 분포' 점검 항목이 바로 이것이다.
가입대상 문구(`join_member`)에 나이 조건이 있으면 파서가 잡아준다.

> **W1 실물 검증 필요.**
> finlife 는 `auth` 파라미터와 `topFinGrpNo`(금융권역), `financeCd` 를 쓴다.
> 상품 유형별로 엔드포인트가 갈린다(예금/적금/대출/연금). 아래는 정기예금 기준 후보값.
"""

from __future__ import annotations

from typing import Any

from ..models import CollectedProgram
from .base import Collector, first_of, parse_amount

#: 금융권역 코드 (W1 검증 대상). 020000 = 은행.
TOP_FIN_GRP_NO = "020000"


class FinlifeCollector(Collector):
    source_key = "finlife"
    endpoint = "https://finlife.fss.or.kr/finlifeapi/depositProductsSearch.json"
    id_list_endpoint = endpoint
    default_form = "product"

    def _query_params(self, *, since: str | None, page: int) -> dict[str, Any]:
        # finlife 는 증분 파라미터가 없다 → content_hash 비교로 변경분을 거른다 (SPEC §3.2).
        return {
            "auth": self.settings.data_go_kr_api_key,
            "topFinGrpNo": TOP_FIN_GRP_NO,
            "pageNo": page,
        }

    def _items_container(self, payload: Any) -> list[Any] | None:
        if not isinstance(payload, dict):
            return None
        result = payload.get("result")
        if not isinstance(result, dict) or "baseList" not in result:
            # finlife 는 인증 실패도 200 + {"result": {"err_cd": "010", ...}} 로 준다.
            # baseList 가 아예 없으면 '상품 0건'이 아니라 에러/스키마 변경이다.
            return None
        base = result.get("baseList") or []
        options = result.get("optionList") or []
        by_product: dict[str, list[dict[str, Any]]] = {}
        for option in options:
            if isinstance(option, dict):
                by_product.setdefault(str(option.get("fin_prdt_cd")), []).append(option)
        merged: list[dict[str, Any]] = []
        for row in base:
            if not isinstance(row, dict):
                continue
            row = dict(row)
            row["_options"] = by_product.get(str(row.get("fin_prdt_cd")), [])
            merged.append(row)
        return merged

    def _map_item(self, item: dict[str, Any]) -> CollectedProgram | None:
        product_code = first_of(item, ("fin_prdt_cd",))
        company_code = first_of(item, ("fin_co_no",))
        title = first_of(item, ("fin_prdt_nm",))
        if not product_code or not title:
            return None

        company = first_of(item, ("kor_co_nm",), default="금융회사")
        join_way = first_of(item, ("join_way",))
        join_member = first_of(item, ("join_member",))
        special = first_of(item, ("spcl_cnd",))
        note = first_of(item, ("etc_note",))
        deny = first_of(item, ("join_deny",))

        options = item.get("_options") or []
        rate_lines = [
            f"- {o.get('save_trm')}개월 {o.get('intr_rate_type_nm', '')} 기본 {o.get('intr_rate')}% / 최고 {o.get('intr_rate2')}%"
            for o in options
            if isinstance(o, dict)
        ]

        body_text = "\n\n".join(
            p
            for p in (
                f"{company}의 {title} 상품입니다.",
                join_way and f"[가입방법] {join_way}",
                rate_lines and "[금리]\n" + "\n".join(rate_lines),
                special and f"[우대조건]\n{special}",
                note and f"[유의사항]\n{note}",
                join_member and f"[가입대상]\n{join_member}",
            )
            if p
        )

        limit_text = first_of(item, ("max_limit",))
        amount_min, amount_max = parse_amount(limit_text + "원" if limit_text.isdigit() else limit_text)
        if limit_text.isdigit():
            amount_max = int(limit_text)
            amount_min = None

        return CollectedProgram(
            # 상품코드는 회사 안에서만 유일하다 → 회사코드와 함께 묶는다.
            external_id=self.external_id(f"{company_code}-{product_code}"),
            source_key=self.source_key,
            source_url="https://finlife.fss.or.kr/finlife/svings/fdrmDpst/list.do?menuId=2000100",
            title=f"[{company}] {title}",
            body_text=body_text,
            eligibility_text=join_member or deny,
            form=self.default_form,
            issuer=company,
            issuer_level="central",
            benefit_amount_text=f"최고한도 {limit_text}원" if limit_text else "",
            benefit_amount_min=amount_min,
            benefit_amount_max=amount_max,
            apply_url="https://finlife.fss.or.kr/",
            apply_method=join_way or "영업점·인터넷뱅킹",
            starts_at=None,
            ends_at=None,
            is_always_open=True,  # 공시 상품은 상시 — 전량 대조(§3.2)로만 내려간다
            raw_body=item,
        )
