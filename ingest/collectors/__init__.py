"""소스별 수집기 (SPEC §3.3 T1 3종).

* `social_security` — 한국사회보장정보원 사회보장급여/공공서비스 (보조금24)
* `bizinfo`         — 기업마당 지원사업 정보
* `finlife`         — 금융감독원 금융상품통합비교공시

전 수집기가 `--fixtures` 모드를 지원한다. 실 엔드포인트 경로·파라미터는
**W1 실물 검증 대상**이며(SPEC §3.3 주석) 지금은 후보값이다.
"""

from __future__ import annotations

from .base import Collector, CollectorError
from .bizinfo import BizinfoCollector
from .finlife import FinlifeCollector
from .social_security import SocialSecurityCollector

#: source_key → 클래스. CLI `--source` 로 고른다.
COLLECTORS: dict[str, type[Collector]] = {
    SocialSecurityCollector.source_key: SocialSecurityCollector,
    BizinfoCollector.source_key: BizinfoCollector,
    FinlifeCollector.source_key: FinlifeCollector,
}

__all__ = [
    "COLLECTORS",
    "BizinfoCollector",
    "Collector",
    "CollectorError",
    "FinlifeCollector",
    "SocialSecurityCollector",
]
