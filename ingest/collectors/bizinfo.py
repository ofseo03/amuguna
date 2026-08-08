"""T1 — 기업마당(bizinfo.go.kr) 지원사업 정보.

소상공인·창업·중소기업 정책자금 커버 (SPEC §3.3 T1 둘째 줄, 페르소나 P2).

> **W1 실물 검증 필요.**
> 기업마당은 data.go.kr 이 아니라 자체 오픈 API(`crtfcKey` 인증)를 쓴다.
> 키 발급 경로·파라미터명·응답 필드명 모두 W1에 실물로 확인한다.
> `reqstBeginEndDe` 처럼 '기간을 문자열 하나로 주는' 필드가 있어 분해 파싱이 필요하다.
"""

from __future__ import annotations

import re
from typing import Any

from ..models import CollectedProgram
from .base import Collector, first_of, parse_amount

_PERIOD = re.compile(r"(\d{4})[.\-/]?(\d{2})[.\-/]?(\d{2})")


def _split_period(text: str) -> tuple[str | None, str | None, bool]:
    """'20260801 ~ 20260930' / '2026-08-01 ~ 예산소진시' → (start, end, is_always_open)."""
    if not text:
        return None, None, False
    dates = [f"{m[1]}-{m[2]}-{m[3]}" for m in _PERIOD.finditer(text)]
    always = bool(re.search(r"예산\s*소진|상시|연중", text))
    if len(dates) >= 2:
        return dates[0], dates[1], False
    if len(dates) == 1:
        return dates[0], None, True
    return None, None, always


class BizinfoCollector(Collector):
    source_key = "bizinfo"
    # 후보 엔드포인트 (W1 검증 대상)
    endpoint = "https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do"
    id_list_endpoint = endpoint
    default_form = "loan"

    def _query_params(self, *, since: str | None, page: int) -> dict[str, Any]:
        params: dict[str, Any] = {
            "crtfcKey": self.settings.data_go_kr_api_key,
            "dataType": "json",
            "pageUnit": self.page_size,
            "pageIndex": page,
        }
        if since:
            params["searchBgnDe"] = since.replace("-", "")  # 증분 수집 (W1 검증)
        return params

    def _items(self, payload: Any) -> list[dict[str, Any]]:
        if not isinstance(payload, dict):
            return []
        job = payload.get("jsonArray")
        if job is None:
            job = (payload.get("response") or {}).get("body", {}).get("items")
        if isinstance(job, dict):
            job = [job]
        return [i for i in (job or []) if isinstance(i, dict)]

    def _map_item(self, item: dict[str, Any]) -> CollectedProgram | None:
        native_id = first_of(item, ("pblancId", "pblance_id"))
        title = first_of(item, ("pblancNm", "pblanc_nm"))
        if not native_id or not title:
            return None

        summary_cn = first_of(item, ("bsnsSumryCn", "bsns_sumry_cn"))
        target = first_of(item, ("trgetNm", "trget_nm"))
        realm = first_of(item, ("pldirSportRealmLclasCodeNm",))

        body_text = "\n\n".join(
            p
            for p in (
                summary_cn,
                realm and f"[지원분야] {realm}",
                target and f"[지원대상]\n{target}",
            )
            if p
        )

        issuer = first_of(item, ("jrsdInsttNm", "excInsttNm"), default="중소벤처기업부")
        issuer_level = "metro" if any(
            issuer.startswith(k)
            for k in ("서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종", "경기", "강원", "충청", "전라", "경상", "제주", "전북", "전남", "경북", "경남", "충북", "충남")
        ) else "central"

        amount_text = first_of(item, ("sportScvlNm", "sportAmtCn")) or summary_cn
        amount_min, amount_max = parse_amount(amount_text)

        starts_at, ends_at, always = _split_period(first_of(item, ("reqstBeginEndDe",)))

        return CollectedProgram(
            external_id=self.external_id(native_id),
            source_key=self.source_key,
            source_url=first_of(
                item,
                ("pblancUrl", "rceptEngnHmpgUrl"),
                default=f"https://www.bizinfo.go.kr/web/lay1/bbs/S1T122C128/AS/74/view.do?pblancId={native_id}",
            ),
            title=title,
            body_text=body_text or title,
            eligibility_text=target,
            form=self.default_form,
            issuer=issuer,
            issuer_level=issuer_level,
            benefit_amount_text=first_of(item, ("sportScvlNm", "sportAmtCn")),
            benefit_amount_min=amount_min,
            benefit_amount_max=amount_max,
            apply_url=first_of(item, ("rceptEngnHmpgUrl", "pblancUrl")),
            apply_method=first_of(item, ("reqstMthPapersCn", "rceptMthNm"), default="온라인 신청"),
            starts_at=starts_at,
            ends_at=ends_at,
            is_always_open=always and ends_at is None,
            raw_body=item,
        )
