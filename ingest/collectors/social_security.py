"""T1 — 한국사회보장정보원 사회보장급여/공공서비스 목록·상세 (보조금24).

SPEC §3.3 T1 첫 줄. 전국 + 지자체 복지·지원금을 가장 넓게 덮는 소스다.

> **W1 실물 검증 필요.**
> 아래 엔드포인트·파라미터명·응답 필드명은 공공데이터포털 문서 기준 *후보값*이다.
> 특히 이 API는 기본 응답이 XML이고 JSON 지원 여부가 계정/버전에 따라 다르다.
> W1에 실 응답을 받아 (1) 자격요건이 구조화 필드인지 서술형 텍스트인지
> (SPEC §12 최대 리스크 1), (2) 증분 수집 파라미터가 있는지, (3) 일일 호출 한도가
> 충분한지를 확인하고 여기를 고친다.
"""

from __future__ import annotations

from typing import Any

from ..models import CollectedProgram
from .base import Collector, first_of, parse_amount


def _ymd(value: str) -> str | None:
    """'20260401' / '2026-04-01' → ISO date. 파싱 실패 시 None."""
    digits = "".join(ch for ch in (value or "") if ch.isdigit())
    if len(digits) != 8:
        return None
    return f"{digits[0:4]}-{digits[4:6]}-{digits[6:8]}"


class SocialSecurityCollector(Collector):
    source_key = "social_security"
    # 후보 엔드포인트 (W1 검증 대상)
    endpoint = (
        "https://apis.data.go.kr/B554287/NationalWelfareInformationsV001/NationalWelfarelistV001"
    )
    id_list_endpoint = endpoint
    default_form = "subsidy"

    def _query_params(self, *, since: str | None, page: int) -> dict[str, Any]:
        params: dict[str, Any] = {
            "serviceKey": self.settings.data_go_kr_api_key,
            "callTp": "L",  # L = 목록
            "pageNo": page,
            "numOfRows": self.page_size,
            "srchKeyCode": "001",
            "_type": "json",
        }
        if since:
            # 증분 수집 (SPEC §3.2). 파라미터명은 W1 검증 대상 — 미지원이면
            # content_hash 비교만으로 변경분을 걸러낸다.
            params["srchModDt"] = since.replace("-", "")
        return params

    def _items(self, payload: Any) -> list[dict[str, Any]]:
        if not isinstance(payload, dict):
            return []
        body = (payload.get("response") or {}).get("body") or payload.get("body") or {}
        items = body.get("items") or {}
        if isinstance(items, dict):
            items = items.get("item") or []
        if isinstance(items, dict):
            items = [items]
        return [i for i in items if isinstance(i, dict)]

    def _map_item(self, item: dict[str, Any]) -> CollectedProgram | None:
        native_id = first_of(item, ("servId", "servid", "SERV_ID"))
        title = first_of(item, ("servNm", "servnm", "SERV_NM"))
        if not native_id or not title:
            return None

        outline = first_of(item, ("wlfareInfoOutlCn", "servDgst", "servDtlLink"))
        target = first_of(item, ("sprtTrgtCn", "trgterIndvdlArray"))
        criteria = first_of(item, ("slctCritCn",))
        benefit = first_of(item, ("alwServCn",))
        eligibility = "\n".join(p for p in (target, criteria) if p)

        body_parts = [outline, benefit and f"[지원내용]\n{benefit}", eligibility and f"[지원대상]\n{eligibility}"]
        body_text = "\n\n".join(p for p in body_parts if p)

        issuer = first_of(item, ("jurOrgNm", "jurMnofNm"), default="정부")
        # 소관 조직명으로 중앙/광역/기초를 가른다. 정밀 판정은 W1에 기관코드로 교체.
        if any(k in issuer for k in ("부", "청", "처", "위원회", "공단")):
            issuer_level = "central"
        elif any(issuer.endswith(k) for k in ("특별시", "광역시", "도", "특별자치시", "특별자치도")):
            issuer_level = "metro"
        else:
            issuer_level = "local"

        amount_text = first_of(item, ("sprtAmtCn", "alwServCn"))
        amount_min, amount_max = parse_amount(amount_text)

        starts_at = _ymd(first_of(item, ("enfcBgngYmd",)))
        ends_at = _ymd(first_of(item, ("enfcEndYmd",)))

        return CollectedProgram(
            external_id=self.external_id(native_id),
            source_key=self.source_key,
            source_url=first_of(
                item,
                ("servDtlLink", "servUrl"),
                default=f"https://www.bokjiro.go.kr/ssis-tbu/twataa/wlfareInfo/moveTWAT52011M.do?wlfareInfoId={native_id}",
            ),
            title=title,
            body_text=body_text or title,
            eligibility_text=eligibility,
            form=self.default_form,
            issuer=issuer,
            issuer_level=issuer_level,
            benefit_amount_text=amount_text,
            benefit_amount_min=amount_min,
            benefit_amount_max=amount_max,
            apply_url=first_of(item, ("applmetUrl", "onapPsbltYn")),
            apply_method=first_of(item, ("applmetCn", "srvPvsnNm")),
            starts_at=starts_at,
            ends_at=ends_at,
            is_always_open=ends_at is None,
            raw_body=item,
        )
