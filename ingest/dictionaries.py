"""사전 룩업 (SPEC §6.1 — "지역·직업은 정규식이 아니라 사전 룩업이 맞다").

shared/*.json 은 **읽기 전용 교차팀 계약 데이터**다. 여기서는 로드만 하고
데이터를 코드에 복제하지 않는다. 별칭(서울시 → 서울특별시) 같은 파생 인덱스만 만든다.
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache
from typing import Iterable

from .config import SHARED_DIR


def _load(name: str) -> dict:
    with (SHARED_DIR / name).open(encoding="utf-8") as fh:
        return json.load(fh)


# ---------------------------------------------------------------- 중위소득 → 분위


@lru_cache(maxsize=1)
def _midincome_table() -> list[tuple[int | None, int]]:
    rows = _load("midincome_to_decile.json")["mapping"]
    return [(row["max_percent"], row["decile"]) for row in rows]


def midrate_to_decile(percent: int) -> int:
    """'기준 중위소득 N% 이하' → 소득분위 상한 (SPEC §6.1).

    표에서 percent 이하인 첫 행의 decile. max_percent=null 은 상한 없음(=10).
    """
    for max_percent, decile in _midincome_table():
        if max_percent is None or percent <= max_percent:
            return decile
    return 10


# ---------------------------------------------------------------------- 지역


@dataclass(frozen=True)
class RegionEntry:
    code: str
    name: str
    sido: str  # 시도 2자리 (시도 자신이면 code 와 동일)


#: 시도 축약 별칭. 공고문은 '서울특별시'보다 '서울시'/'서울'을 훨씬 자주 쓴다.
_SIDO_ALIAS_SUFFIXES = ("특별자치시", "특별자치도", "특별시", "광역시", "특별시", "도", "시")


def _sido_aliases(name: str) -> list[str]:
    """'서울특별시' → ['서울특별시', '서울시', '서울'] / '전라남도' → [... '전남']."""
    aliases = {name}
    stem = name
    for suffix in _SIDO_ALIAS_SUFFIXES:
        if stem.endswith(suffix) and len(stem) > len(suffix):
            stem = stem[: -len(suffix)]
            break
    if stem != name:
        aliases.add(stem)
        aliases.add(stem + "시" if name.endswith(("특별시", "광역시", "특별자치시")) else stem + "도")
    # 2글자 축약 (전라남도 → 전남, 충청북도 → 충북, 경상남도 → 경남)
    if len(stem) == 3 and stem[1] in "라청상":
        aliases.add(stem[0] + stem[2])
    return sorted(aliases, key=len, reverse=True)


@lru_cache(maxsize=1)
def region_index() -> tuple[dict[str, list[RegionEntry]], dict[str, list[RegionEntry]]]:
    """(시도 별칭 → entries, 시군구 이름 → entries). 동명 시군구는 리스트가 2개 이상."""
    data = _load("regions.json")
    sido_idx: dict[str, list[RegionEntry]] = {}
    sigungu_idx: dict[str, list[RegionEntry]] = {}

    for row in data["sido"]:
        entry = RegionEntry(code=row["code"], name=row["name"], sido=row["code"])
        for alias in _sido_aliases(row["name"]):
            sido_idx.setdefault(alias, []).append(entry)

    for row in data["sigungu"]:
        entry = RegionEntry(code=row["code"], name=row["name"], sido=row["sido"])
        sigungu_idx.setdefault(row["name"], []).append(entry)
        # '수원시 장안구' 처럼 복합명이면 앞 토막('수원시')도 인덱싱해 둔다.
        # 구 단위가 특정되지 않으므로 매칭 시 시도 2자리로 강등한다 (아래 lookup_regions).
        head, _, tail = row["name"].partition(" ")
        if tail:
            sigungu_idx.setdefault(head, []).append(
                RegionEntry(code=row["sido"], name=head, sido=row["sido"])
            )
    return sido_idx, sigungu_idx


@lru_cache(maxsize=1)
def _sigungu_pattern() -> re.Pattern[str]:
    _, sigungu_idx = region_index()
    names = sorted(sigungu_idx, key=len, reverse=True)
    return re.compile("|".join(re.escape(n) for n in names))


@lru_cache(maxsize=1)
def _sido_pattern() -> re.Pattern[str]:
    sido_idx, _ = region_index()
    # 2글자 별칭('중구' 아님, '서울')이 긴 이름보다 먼저 잡히지 않도록 긴 것부터.
    names = sorted(sido_idx, key=len, reverse=True)
    return re.compile("|".join(re.escape(n) for n in names))


#: 지역명처럼 보이지만 지역 조건이 아닌 표현. 이 안에 들어간 매칭은 버린다.
REGION_BLOCKERS = (
    "여성가족부",
    "중소벤처기업부",
    "서울보증보험",
    "서울신용보증재단",  # 기관명이지 거주 조건이 아님
)


def lookup_regions(text: str) -> tuple[list[str], list[str]]:
    """텍스트에서 행정구역 코드를 뽑는다.

    반환: (코드 리스트, 근거 문자열 리스트).
    시군구가 특정되면 5자리, 시도만 나오면 2자리 (SPEC §5 regions 규약).
    '전국'만 있으면 빈 리스트 = 조건 없음(NULL).
    """
    sido_idx, sigungu_idx = region_index()
    codes: list[str] = []
    evidence: list[str] = []

    # 1) 시도 먼저 훑어 문맥(동명 시군구 해소용)을 만든다.
    sido_hits: list[tuple[int, RegionEntry]] = []
    for m in _sido_pattern().finditer(text):
        if _blocked(text, m.start(), m.end(), REGION_BLOCKERS):
            continue
        entries = sido_idx[m.group(0)]
        if len(entries) == 1:
            sido_hits.append((m.start(), entries[0]))

    # 2) 시군구. 동명이 여럿이면 가장 가까운 앞쪽 시도로 해소하고, 못 하면 버린다.
    consumed_sido: set[str] = set()
    for m in _sigungu_pattern().finditer(text):
        if _blocked(text, m.start(), m.end(), REGION_BLOCKERS):
            continue
        candidates = sigungu_idx[m.group(0)]
        # 앞쪽에 나온 가장 가까운 시도를 문맥으로 삼는다.
        #  - 동명 시군구('중구')를 해소하고,
        #  - 단일 후보라도 시도가 어긋나면('대전 서구' → 광주 서구) 버린다.
        context = [e for pos, e in sido_hits if pos < m.start()]
        nearest = context[-1] if context else None
        if nearest is None:
            matched = candidates
        else:
            matched = [c for c in candidates if c.sido == nearest.sido]
        entry: RegionEntry | None = matched[0] if len(matched) == 1 else None
        if entry is None:
            continue  # 모호한 '중구' 등은 조건으로 쓰지 않는다 (누락 < 오탐)
        if entry.code not in codes:
            codes.append(entry.code)
            evidence.append(m.group(0))
        consumed_sido.add(entry.sido)

    # 3) 시군구로 커버되지 않은 시도만 2자리로 추가.
    for _pos, entry in sido_hits:
        if entry.sido in consumed_sido:
            continue
        if entry.code not in codes:
            codes.append(entry.code)
            evidence.append(entry.name)
        consumed_sido.add(entry.sido)

    return codes, evidence


# ---------------------------------------------------------------------- 직업


@lru_cache(maxsize=1)
def occupation_index() -> dict[str, str]:
    """동의어 → code (SPEC §6.1: 소상공인/자영업자 → self_employed)."""
    idx: dict[str, str] = {}
    for row in _load("occupations.json")["categories"]:
        idx[row["name"]] = row["code"]
        for syn in row["synonyms"]:
            idx[syn] = row["code"]
    return idx


@lru_cache(maxsize=1)
def occupation_codes() -> frozenset[str]:
    return frozenset(row["code"] for row in _load("occupations.json")["categories"])


@lru_cache(maxsize=1)
def _occupation_pattern() -> re.Pattern[str]:
    names = sorted(occupation_index(), key=len, reverse=True)
    return re.compile("|".join(re.escape(n) for n in names))


#: 동의어를 포함하지만 신청자 직업 조건이 아닌 복합어.
#: 예) '노인장기요양보험'의 '노인'은 retired 조건이 아니다.
OCCUPATION_BLOCKERS = (
    "노인장기요양",
    "노인복지관",
    "노인일자리",
    "여성가족부",
    "소상공인시장진흥공단",
    "중소기업진흥공단",
    "농업기술센터",
    "무직자대출",  # 상품명
    "학생증",
)

#: 뒤따르면 '제3자(부양가족)의 속성'임을 뜻하는 표현 — 신청자 조건이 아니다 (§6.3 함정).
DEPENDENT_VERBS = ("모시", "부양", "양육", "돌보", "를 둔", "을 둔", "둔 가구", "동거하는")
DEPENDENT_NOUNS = ("자녀", "아동", "손자녀", "가구원", "세대원", "피부양")


def _blocked(text: str, start: int, end: int, blockers: Iterable[str]) -> bool:
    window = text[max(0, start - 8) : end + 8]
    return any(b in window for b in blockers)


def has_dependent_context(text: str, start: int, end: int) -> str | None:
    """조건 문구 뒤가 '부양가족 대상'인지 판정. 걸리면 그 표현을 돌려준다.

    - 25자 이내에 부양 동사가 오면 제3자 조건
    - 바로 뒤 5자 이내에 부양 명사가 오면 제3자 조건
    """
    tail = text[end : end + 25]
    for verb in DEPENDENT_VERBS:
        if verb in tail:
            return verb
    near = text[end : end + 5]
    for noun in DEPENDENT_NOUNS:
        if noun in near:
            return noun
    return None


def lookup_occupations(text: str) -> tuple[list[str], list[str]]:
    """텍스트 → (직업코드 리스트, 근거 문자열 리스트)."""
    codes: list[str] = []
    evidence: list[str] = []
    idx = occupation_index()
    for m in _occupation_pattern().finditer(text):
        if _blocked(text, m.start(), m.end(), OCCUPATION_BLOCKERS):
            continue
        if has_dependent_context(text, m.start(), m.end()):
            continue
        code = idx[m.group(0)]
        if code not in codes:
            codes.append(code)
            evidence.append(m.group(0))
    return codes, evidence


# ------------------------------------------------------------------- 정규화


def normalize_text(text: str) -> str:
    """NFC 정규화 + 공백 정리. 해시·임베딩 입력 앞단에서 공통으로 쓴다."""
    if not text:
        return ""
    text = unicodedata.normalize("NFC", text)
    text = text.replace(" ", " ").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()
