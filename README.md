# amuguna

개인 프로필 기반 공공 금융정보 매칭 서비스 — 2026 금융 AI Challenge 출품작.

인적사항과 두 소득 기준(자격 축, SQL), "원하는 것" 한 줄(의도 축, 벡터)의 **교집합**으로,
받을 수 있는데 몰라서 못 받는 지원금·정책자금·금융상품을 찾아준다.
설계 근거와 전체 명세는 [SPEC.md](SPEC.md).

## 구조

```
[배치]  T1 Open API/픽스처 → regex 파싱(+LLM 보완) → eligibility_rules
                            → 청크 임베딩 → program_embeddings (pgvector)
                            → 요약·절차 생성(LLM) → programs

[요청]  프로필 → SQL 자격 필터(A) ∩ 의도 임베딩 top-k(B) → 스코어링 → 카드
        (요청 경로에 LLM 없음 — 요약은 배치 사전 생성, 근거는 템플릿)
```

| 디렉터리 | 내용 |
|---|---|
| `db/` | Postgres 마이그레이션 — 스키마(§5), `match_programs` 교차검증·근접탈락 RPC(§7.3/7.6), 프로필 90일 삭제(§8). [db/README.md](db/README.md) |
| `ingest/` | API 응답 봉투·목록/상세 조인을 재현한 픽스처 JSON 6종 |
| `web/` | Next.js + TypeScript 웹서비스와 독립 Node 배치(`web/ingest`) — 수집·파싱·임베딩·요약, 화면/API, 스코어링. [web/README.md](web/README.md) |
| `shared/` | 공통 계약 데이터 — 지역코드, 직업분류(+파서 동의어), 소득분위 라벨, 2026 가구원별 기준중위소득표 |

## 빠른 시작 (API 키 없이)

모든 외부 의존(공공 API·임베딩·LLM·DB)은 키가 없으면 mock/픽스처/데모 모드로 동작한다.

```bash
# 웹 — DB 없이 내장 데모 데이터로 전체 흐름 동작
(cd web && npm install && npm run dev)

# 테스트 + 수집 파이프라인 픽스처 30건 end-to-end
(cd web && npm test)
(cd web && npm run ingest -- --fixtures --dry-run)
```

## 실 연동 (키 준비 후)

Next.js와 독립 배치는 `web/.env.local`, GitHub Actions는 Secrets에 값을 넣으면 실 API로 전환된다.

| 변수 | 용도 |
|---|---|
| `DATABASE_URL` | Supabase Postgres (`db/migrations/` 순서대로 적용) |
| `DATA_GO_KR_API_KEY` | 공공데이터포털 — 중앙·지자체복지, 보조금24, K-Startup (각 데이터셋 활용신청 필요) |
| `BIZINFO_API_KEY` | 기업마당 지원사업 API |
| `FINLIFE_API_KEY` | 금융감독원 금융상품 한눈에 API |
| `EMBEDDING_PROVIDER` / `EMBEDDING_API_KEY` | `voyage-4-large` \| openai \| mock (차원 1024 고정) |
| `OPENROUTER_API_KEY` | 배치 전용 — OpenRouter로 파싱 보완 + 요약 생성 (`google/gemma-4-31b-it:free`) |
