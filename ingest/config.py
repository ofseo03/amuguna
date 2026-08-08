"""환경변수·경로 설정 (교차팀 확정 계약 — 이름을 바꾸지 말 것).

| 변수 | 용도 |
|---|---|
| DATABASE_URL      | Supabase Postgres 접속 문자열 (psycopg) |
| DATA_GO_KR_API_KEY| 공공데이터포털 서비스키 (사회보장급여 / 기업마당 / finlife) |
| ANTHROPIC_API_KEY | 배치 LLM (파싱 보완 §6.2, 요약·절차 §7.5) |
| EMBEDDING_PROVIDER| voyage | openai | mock |
| EMBEDDING_API_KEY | 임베딩 API 키 |
| MOCK_EMBEDDINGS   | '1'이면 provider 무시하고 mock 강제 |
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

# ingest/ 의 부모 = 저장소 루트. shared/*.json 은 읽기 전용 계약 데이터다.
PACKAGE_DIR = Path(__file__).resolve().parent
REPO_ROOT = PACKAGE_DIR.parent
SHARED_DIR = REPO_ROOT / "shared"
FIXTURES_DIR = PACKAGE_DIR / "fixtures"

#: 임베딩 차원 — DB `vector(1024)` 와 웹팀 mock 구현이 동일 값을 쓴다.
EMBEDDING_DIM = 1024

#: 배치 전용 LLM (SPEC §4 기술 선택).
LLM_MODEL = "claude-sonnet-5"


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


@dataclass(frozen=True)
class Settings:
    database_url: str = ""
    data_go_kr_api_key: str = ""
    anthropic_api_key: str = ""
    embedding_provider: str = "mock"
    embedding_api_key: str = ""
    mock_embeddings: bool = True

    @classmethod
    def from_env(cls) -> "Settings":
        provider = _env("EMBEDDING_PROVIDER", "mock").lower() or "mock"
        forced_mock = _env("MOCK_EMBEDDINGS") == "1"
        return cls(
            database_url=_env("DATABASE_URL"),
            data_go_kr_api_key=_env("DATA_GO_KR_API_KEY"),
            anthropic_api_key=_env("ANTHROPIC_API_KEY"),
            embedding_provider="mock" if forced_mock else provider,
            embedding_api_key=_env("EMBEDDING_API_KEY"),
            # 키가 없으면 실 provider 를 요청해도 mock 으로 떨어진다 (배치가 죽지 않게).
            mock_embeddings=forced_mock or provider == "mock" or not _env("EMBEDDING_API_KEY"),
        )
