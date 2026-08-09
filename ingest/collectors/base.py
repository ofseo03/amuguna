"""수집기 공통 뼈대.

두 가지 모드를 같은 매핑 코드로 처리한다:

* **live** — `httpx` 로 data.go.kr 계열 엔드포인트 호출 (키는 환경변수)
* **fixtures** — `ingest/fixtures/<source_key>.json` 을 읽는다.
  픽스처는 *응답 봉투(envelope) 그대로* 저장하므로 매핑 코드 경로가 동일하게 실행된다.
  이렇게 해야 픽스처 테스트가 실제 파싱 로직을 검증한다.

> **W1 실물 검증 필요.** 엔드포인트 경로·파라미터명·응답 필드명은 SPEC §3.3 이
> 명시하듯 후보값이다. 실 응답을 받아본 뒤 `ENDPOINT` 와 `_map_item` 을 고친다.
"""

from __future__ import annotations

import json
import logging
from abc import ABC, abstractmethod
from typing import Any, Sequence

from ..config import FIXTURES_DIR, Settings
from ..models import CollectedProgram

try:  # pragma: no cover - live 경로에서만 필요
    import httpx  # type: ignore
except ImportError:  # pragma: no cover
    httpx = None  # type: ignore[assignment]

log = logging.getLogger(__name__)

#: 크롤링 정책(SPEC §3.4)과 동일한 식별 원칙을 API 호출에도 적용한다.
USER_AGENT = "amuguna-ingest/0.1 (2026 금융 AI Challenge; contact: ofseo03@gmail.com)"


class CollectorError(RuntimeError):
    """수집 실패. 파이프라인은 소스 단위로 격리하고 나머지를 계속 돈다."""


class Collector(ABC):
    source_key: str = ""
    #: 실 엔드포인트 (W1 검증 대상)
    endpoint: str = ""
    #: 전량 대조용 목록 엔드포인트. 상세 조회 없이 ID만 받는다 (SPEC §3.2).
    id_list_endpoint: str = ""
    #: 이 소스의 기본 form (SPEC §5 programs.form)
    default_form: str = "subsidy"

    def __init__(
        self,
        settings: Settings | None = None,
        *,
        use_fixtures: bool = False,
        client: Any = None,
        page_size: int = 100,
    ) -> None:
        self.settings = settings or Settings.from_env()
        self.use_fixtures = use_fixtures
        self._client = client
        self.page_size = page_size
        self.http_calls = 0

    # ------------------------------------------------------------ 하위 클래스

    @abstractmethod
    def _query_params(self, *, since: str | None, page: int) -> dict[str, Any]:
        """엔드포인트 쿼리 파라미터 (증분 수집 파라미터 포함)."""

    @abstractmethod
    def _items_container(self, payload: Any) -> list[Any] | None:
        """응답 봉투에서 항목 리스트를 꺼낸다.

        **없으면 None** — 빈 리스트(정상적인 '이번 페이지 0건')와 반드시 구분한다.
        이 구분이 없으면 스키마가 바뀌었을 때 0건이 정상 종료로 보인다.
        """

    def _items(self, payload: Any) -> list[dict[str, Any]]:
        return [i for i in (self._items_container(payload) or []) if isinstance(i, dict)]

    @abstractmethod
    def _map_item(self, item: dict[str, Any]) -> CollectedProgram | None:
        """소스 항목 → CollectedProgram. 필수 필드가 없으면 None."""

    # ------------------------------------------------------------------ 공통

    @property
    def fixture_path(self):
        return FIXTURES_DIR / f"{self.source_key}.json"

    def _load_fixture(self) -> Any:
        path = self.fixture_path
        if not path.exists():
            raise CollectorError(f"픽스처 없음: {path}")
        with path.open(encoding="utf-8") as fh:
            return json.load(fh)

    def _get(self, params: dict[str, Any]) -> Any:
        if httpx is None:  # pragma: no cover
            raise CollectorError("httpx 미설치 — --fixtures 모드를 쓰거나 httpx 를 설치하세요")
        if not self.settings.data_go_kr_api_key:
            raise CollectorError(f"{self.source_key}: DATA_GO_KR_API_KEY 미설정")
        client = self._client
        self.http_calls += 1
        try:
            if client is None:
                with httpx.Client(
                    timeout=30.0, headers={"User-Agent": USER_AGENT}, follow_redirects=True
                ) as owned:
                    response = owned.get(self.endpoint, params=params)
            else:
                response = client.get(self.endpoint, params=params)
            response.raise_for_status()
            return response.json()
        except Exception as exc:  # pragma: no cover - 네트워크 경로
            raise CollectorError(f"{self.source_key} 호출 실패: {exc}") from exc

    def external_id(self, native_id: str) -> str:
        """'source_key:원본고유번호' (SPEC §3.2). source_url 을 키로 쓰지 않는다."""
        return f"{self.source_key}:{native_id}"

    # -------------------------------------------------------------- 봉투 검증

    #: 정상을 뜻하는 결과코드. 공공데이터포털 계열은 '00', 금감원은 '000'.
    OK_RESULT_CODES = frozenset({"00", "000", "0", "OK", "SUCCESS", "NORMAL SERVICE"})

    #: 결과코드가 실릴 수 있는 키 (소스·버전마다 흔들려서 후보를 모두 본다)
    _RESULT_CODE_KEYS = ("resultCode", "returnReasonCode", "err_cd", "errCd", "code")
    _RESULT_MSG_KEYS = ("resultMsg", "returnAuthMsg", "err_msg", "errMsg", "message")

    def _validate_envelope(self, payload: Any) -> None:
        """에러 봉투·스키마 변경을 '항목 0건'으로 오인하기 전에 거른다.

        공공 API 상당수가 인증 실패·호출 한도 초과·서비스 점검을 **HTTP 200 +
        에러 봉투**로 돌려준다. 이걸 정상 페이징 종료로 처리하면 수집 0건이
        성공으로 보고되고, 워크플로는 녹색인 채 직전 스냅샷이 무기한 낡는다.
        판정 불가는 CollectorError 로 올려 소스 단위로 실패시킨다 —
        파이프라인이 기존 데이터를 그대로 유지한다 (SPEC §3.2).
        """
        if not isinstance(payload, (dict, list)):
            raise CollectorError(
                f"{self.source_key}: 응답이 JSON 객체가 아닙니다 ({type(payload).__name__})"
            )
        if isinstance(payload, dict):
            self._check_result_code(payload)
            header = (payload.get("response") or {}).get("header")
            if isinstance(header, dict):
                self._check_result_code(header)
            nested = payload.get("result")  # finlife: {"result": {"err_cd": ...}}
            if isinstance(nested, dict):
                self._check_result_code(nested)
            fault = payload.get("cmmMsgHeader") or payload.get("OpenAPI_ServiceResponse")
            if isinstance(fault, dict):
                self._check_result_code(fault)
                raise CollectorError(f"{self.source_key}: 서비스 오류 응답 — {fault}")

        if self._items_container(payload) is None:
            raise CollectorError(
                f"{self.source_key}: 응답에서 항목 목록을 찾지 못했습니다 "
                "(스키마 변경 또는 에러 봉투). 0건으로 처리하지 않습니다"
            )

    def _check_result_code(self, envelope: dict[str, Any]) -> None:
        for key in self._RESULT_CODE_KEYS:
            value = envelope.get(key)
            if value in (None, ""):
                continue
            code = str(value).strip().upper().rstrip(".")
            # '0' / '00' / '000' / '0000' — 자릿수는 소스마다 다르고 전부 정상을 뜻한다.
            if not code.strip("0") or code in self.OK_RESULT_CODES:
                return
            message = next(
                (str(envelope[k]) for k in self._RESULT_MSG_KEYS if envelope.get(k)), ""
            )
            raise CollectorError(
                f"{self.source_key}: 소스가 오류 코드를 반환했습니다 ({key}={value} {message})"
            )

    # ------------------------------------------------------------------ API

    def fetch(self, *, since: str | None = None, max_pages: int = 5) -> list[CollectedProgram]:
        """증분 수집. `since` 는 소스가 수정일 파라미터를 지원할 때만 쓰인다."""
        payloads: list[Any] = []
        if self.use_fixtures:
            payload = self._load_fixture()
            self._validate_envelope(payload)  # 픽스처도 같은 계약을 지켜야 한다
            payloads.append(payload)
        else:
            for page in range(1, max_pages + 1):
                payload = self._get(self._query_params(since=since, page=page))
                # 빈 페이지를 종료 신호로 삼기 **전에** 봉투가 정상인지 확인한다.
                self._validate_envelope(payload)
                items = self._items(payload)
                payloads.append(payload)
                if len(items) < self.page_size:
                    break

        collected: list[CollectedProgram] = []
        seen: set[str] = set()
        for payload in payloads:
            for item in self._items(payload):
                try:
                    program = self._map_item(item)
                except Exception as exc:
                    log.warning("%s: 항목 매핑 실패 (%s)", self.source_key, exc)
                    continue
                if program is None or program.external_id in seen:
                    continue
                seen.add(program.external_id)
                collected.append(program)
        return collected

    def list_external_ids(self) -> set[str]:
        """주 1회 전량 대조용 ID 목록 (SPEC §3.2 — 상세 조회 호출 없음).

        픽스처 모드에서는 `<source_key>.ids.json` 이 있으면 그것을, 없으면
        본 픽스처에서 파생한다. `.ids.json` 으로 '원본에서 내려간 공고'를 흉내 낼 수 있다.
        """
        if self.use_fixtures:
            ids_path = FIXTURES_DIR / f"{self.source_key}.ids.json"
            if ids_path.exists():
                with ids_path.open(encoding="utf-8") as fh:
                    return {self.external_id(str(i)) for i in json.load(fh)["ids"]}
            return {p.external_id for p in self.fetch()}
        # live: 목록 엔드포인트가 따로 있으면 그것을 쓰고, 없으면 상세 없는 목록 조회로 대체
        return {p.external_id for p in self.fetch(max_pages=50)}


# ------------------------------------------------------------------- 헬퍼


def first_of(item: dict[str, Any], keys: Sequence[str], default: str = "") -> str:
    """소스마다 필드명이 흔들려서(=W1 검증 전) 후보 키를 순서대로 본다."""
    for key in keys:
        value = item.get(key)
        if value not in (None, ""):
            return str(value).strip()
    return default


def parse_amount(text: str) -> tuple[int | None, int | None]:
    """'최대 3,000만원' / '100만원 ~ 1억원' → (min, max) 원 단위.

    실패하면 (None, None) — 금액은 스코어링 가중치 15%라 없으면 그 항만 빠진다.
    """
    import re

    if not text:
        return None, None
    units = {"억": 100_000_000, "천만": 10_000_000, "백만": 1_000_000, "만": 10_000}
    values: list[int] = []
    for m in re.finditer(r"(\d[\d,\.]*)\s*(억|천만|백만|만)?\s*원", text):
        number = float(m.group(1).replace(",", ""))
        unit = units.get(m.group(2) or "", 1)
        values.append(int(number * unit))
    if not values:
        return None, None
    if len(values) == 1:
        # '최대 N원' 이면 상한, '이상' 이면 하한으로 본다
        if re.search(r"최대|이내|한도|까지", text):
            return None, values[0]
        if re.search(r"최소|이상|부터", text):
            return values[0], None
        return values[0], values[0]
    return min(values), max(values)
