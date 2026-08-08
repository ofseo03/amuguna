"""② 청킹 + 임베딩 (SPEC §7.1).

청킹: 문단 단위, 목표 ~500자. 첫 청크에는 `title + summary` 를 앞에 붙여 문맥을 준다.
청크별로 `program_embeddings` 한 행이 되고, 질의 시 프로그램 단위 MAX(sim)로 집계한다
(벡터 자체를 pooling 하지 않는다 — SPEC §7.1).

Mock 임베딩은 **교차팀 확정 계약**이다. 웹팀이 TypeScript로 같은 알고리즘을 구현하고,
질의 벡터↔문서 벡터가 같은 공간에 있어야 데모가 동작한다. 아래 구현을 바꾸지 말 것::

    dim = 1024
    text → Unicode NFC 정규화 → lowercase → 코드포인트 시퀀스
    v = zeros(1024)
    인접한 코드포인트 쌍 (c1, c2) 마다:  idx = (c1*31 + c2) % 1024 ;  v[idx] += 1
    코드포인트가 2개 미만이면 v[0] = 1
    마지막에 L2 정규화

코사인 유사도가 문자 bigram 겹침을 재게 된다 — 데모 수준으로는 충분하다.
실 provider(voyage/openai)는 **W1에 한국어 성능 실측 후 확정** (SPEC §4, §12 리스크 2).
"""

from __future__ import annotations

import logging
import math
import re
import unicodedata
from dataclasses import dataclass
from typing import Sequence

from .config import EMBEDDING_DIM, Settings

try:  # pragma: no cover - 실 provider 호출 경로에서만 필요
    import httpx  # type: ignore
except ImportError:  # pragma: no cover
    httpx = None  # type: ignore[assignment]

log = logging.getLogger(__name__)

TARGET_CHUNK_CHARS = 500
MAX_CHUNK_CHARS = 900
MAX_CHUNKS = 20


# ---------------------------------------------------------------------- 청킹


def _split_long_paragraph(paragraph: str, limit: int) -> list[str]:
    """한 문단이 limit 를 넘으면 문장 경계로 자른다."""
    sentences = re.split(r"(?<=[.!?。])\s+|(?<=다\.)\s*", paragraph)
    sentences = [s.strip() for s in sentences if s and s.strip()]
    if not sentences:
        return [paragraph[:limit]]
    out: list[str] = []
    buf = ""
    for sentence in sentences:
        while len(sentence) > limit:  # 문장 하나가 이미 너무 길면 강제 절단
            out.append(sentence[:limit])
            sentence = sentence[limit:]
        if buf and len(buf) + len(sentence) + 1 > limit:
            out.append(buf)
            buf = sentence
        else:
            buf = f"{buf} {sentence}".strip()
    if buf:
        out.append(buf)
    return out


def chunk_text(
    body: str,
    *,
    title: str = "",
    summary: str = "",
    target: int = TARGET_CHUNK_CHARS,
) -> list[str]:
    """문단 기반 청킹. 첫 청크 앞에 title + summary 를 붙인다 (SPEC §7.1)."""
    body = (body or "").strip()
    paragraphs: list[str] = []
    for raw in re.split(r"\n\s*\n", body):
        raw = raw.strip()
        if not raw:
            continue
        if len(raw) > MAX_CHUNK_CHARS:
            paragraphs.extend(_split_long_paragraph(raw, target))
        else:
            paragraphs.append(raw)

    chunks: list[str] = []
    buf = ""
    for paragraph in paragraphs:
        if buf and len(buf) + len(paragraph) + 1 > target:
            chunks.append(buf)
            buf = paragraph
        else:
            buf = f"{buf}\n{paragraph}".strip()
    if buf:
        chunks.append(buf)

    header = "\n".join(p for p in (title.strip(), summary.strip()) if p)
    if not chunks:
        return [header] if header else []
    if header:
        chunks[0] = f"{header}\n{chunks[0]}"
    return chunks[:MAX_CHUNKS]


# ----------------------------------------------------------------- mock 임베딩


def mock_embed(text: str, dim: int = EMBEDDING_DIM) -> list[float]:
    """문자 bigram 해시 임베딩 — 웹팀 TypeScript 구현과 **바이트 단위로 동일해야 한다.**"""
    normalized = unicodedata.normalize("NFC", text or "").lower()
    codepoints = [ord(ch) for ch in normalized]
    vector = [0.0] * dim
    if len(codepoints) < 2:
        vector[0] = 1.0
    else:
        for first, second in zip(codepoints, codepoints[1:]):
            vector[(first * 31 + second) % dim] += 1.0
    norm = math.sqrt(sum(v * v for v in vector))
    if norm == 0.0:  # 이론상 도달 불가 — 방어적으로 결정론을 유지한다
        vector[0] = 1.0
        return vector
    return [v / norm for v in vector]


def cosine(a: Sequence[float], b: Sequence[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


# ------------------------------------------------------------------- Embedder


@dataclass
class EmbeddingResult:
    chunks: list[str]
    vectors: list[list[float]]
    provider: str


class Embedder:
    """EMBEDDING_PROVIDER 로 구현을 고른다. 기본은 mock."""

    def __init__(self, settings: Settings | None = None, *, dim: int = EMBEDDING_DIM) -> None:
        self.settings = settings or Settings.from_env()
        self.dim = dim
        self.provider = "mock" if self.settings.mock_embeddings else self.settings.embedding_provider
        self.api_calls = 0

    # -- 실 provider 스텁 ------------------------------------------------
    # 엔드포인트·모델명·차원은 **W1에 한국어 성능 실측 후 확정**한다 (SPEC §4, §12).
    # 지금 확정처럼 적어두면 W1에서 조용히 어긋난다. 실측 전까지는 mock 이 기본이다.

    def _embed_voyage(self, texts: list[str]) -> list[list[float]]:  # pragma: no cover
        if httpx is None:
            raise RuntimeError("httpx 미설치 — voyage provider 사용 불가")
        response = httpx.post(
            "https://api.voyageai.com/v1/embeddings",
            headers={"Authorization": f"Bearer {self.settings.embedding_api_key}"},
            json={"model": "voyage-3", "input": texts, "input_type": "document"},
            timeout=60.0,
        )
        response.raise_for_status()
        return [row["embedding"] for row in response.json()["data"]]

    def _embed_openai(self, texts: list[str]) -> list[list[float]]:  # pragma: no cover
        if httpx is None:
            raise RuntimeError("httpx 미설치 — openai provider 사용 불가")
        response = httpx.post(
            "https://api.openai.com/v1/embeddings",
            headers={"Authorization": f"Bearer {self.settings.embedding_api_key}"},
            json={"model": "text-embedding-3-small", "input": texts, "dimensions": self.dim},
            timeout=60.0,
        )
        response.raise_for_status()
        return [row["embedding"] for row in response.json()["data"]]

    # -- 공개 API --------------------------------------------------------

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        if self.provider == "mock":
            return [mock_embed(t, self.dim) for t in texts]
        try:
            self.api_calls += 1
            if self.provider == "voyage":
                vectors = self._embed_voyage(texts)
            elif self.provider == "openai":
                vectors = self._embed_openai(texts)
            else:
                raise RuntimeError(f"알 수 없는 EMBEDDING_PROVIDER: {self.provider}")
        except Exception as exc:  # 임베딩 실패 시 mock 으로 강등 (배치 중단 금지)
            log.warning("임베딩 provider '%s' 실패 → mock 강등: %s", self.provider, exc)
            return [mock_embed(t, self.dim) for t in texts]
        for vector in vectors:
            if len(vector) != self.dim:
                raise ValueError(f"임베딩 차원 불일치: {len(vector)} != {self.dim}")
        return vectors

    def embed_program(self, *, title: str, summary: str, body: str) -> EmbeddingResult:
        chunks = chunk_text(body, title=title, summary=summary)
        return EmbeddingResult(chunks=chunks, vectors=self.embed_texts(chunks), provider=self.provider)
