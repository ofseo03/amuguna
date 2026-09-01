# amuguna

개인 프로필 기반 공공 금융정보 매칭 서비스 — 2026 금융 AI Challenge 출품작.

인적사항과 두 소득 기준(자격 축, SQL), "원하는 것" 한 줄(의도 축, 벡터)의 **교집합**으로,
받을 수 있는데 몰라서 못 받는 지원금·정책자금·금융상품을 찾아준다.
설계 근거와 전체 명세는 [SPEC.md](SPEC.md).

## 구조

```
[배치]  T1 Open API/픽스처 → regex 파싱 → eligibility_rules
                            → 청크 임베딩 → program_embeddings (pgvector)
                            → 결정형 요약·절차 → programs

[요청]  프로필 → SQL 자격 필터(A) ∩ 의도 임베딩 top-k(B) → 스코어링 → 카드
        → 질의가 있는 최초 전체 검색에 한해 상위 5건 공개 메타데이터 기반 OpenRouter 답변
```

| 디렉터리 | 내용 |
|---|---|
| `db/` | Postgres 마이그레이션 — 스키마(§5), `match_programs` 교차검증·근접탈락 RPC(§7.3/7.6). 개인정보 테이블은 없다(§8). [db/README.md](db/README.md) |
| `ingest/` | API 응답 봉투·목록/상세 조인을 재현한 픽스처 JSON 6종 |
| `web/` | Next.js + TypeScript 웹서비스와 독립 Node 배치(`web/ingest`) — 수집·파싱·임베딩, 화면/API, 스코어링. [web/README.md](web/README.md) |
| `shared/` | 공통 계약 데이터 — 지역코드, 직업분류(+파서 동의어), 소득분위 라벨, 2026 가구원별 기준중위소득표 |

## 빠른 시작 (API 키 없이)

공공 API·임베딩·DB는 키가 없으면 픽스처·mock·데모 모드로 동작한다. OpenRouter 키가
없으면 실시간 AI 안내만 unavailable이 되고 카드 결과는 그대로 표시된다.

```bash
# 웹 — DB 없이 내장 데모 데이터로 전체 흐름 동작
(cd web && npm install && npm run dev)

# 테스트 + 수집 파이프라인 픽스처 30건 end-to-end
(cd web && npm test)
(cd web && npm run ingest -- --fixtures --dry-run)
```

## 실 연동 (키 준비 후)

Next.js 런타임과 독립 배치는 `web/.env.local`을 읽는다. 수집용 키는 GitHub Actions Secrets에, OpenRouter 키는 Vercel 환경변수에 둔다.

| 변수 | 용도 |
|---|---|
| `DATABASE_URL` | Supabase Postgres (`db/migrations/` 순서대로 적용) |
| `DATA_GO_KR_API_KEY` | 공공데이터포털 — 중앙·지자체복지, 보조금24, K-Startup (각 데이터셋 활용신청 필요) |
| `BIZINFO_API_KEY` | 기업마당 지원사업 API |
| `FINLIFE_API_KEY` | 금융감독원 금융상품 한눈에 API |
| `EMBEDDING_PROVIDER` / `EMBEDDING_API_KEY` | `voyage` \| `openai` \| `mock` (Voyage 모델: `voyage-4-large`, 차원 1024 고정) |
| `OPENROUTER_API_KEY` / `LLM_MODEL` | Vercel 런타임 전용 — 질의가 있는 최초 전체 검색의 상위 5건 공개 메타데이터로 실시간 답변 생성. 실패해도 카드 결과는 유지 |
| `RATE_LIMIT_SESSION_PER_MIN` / `RATE_LIMIT_ANON_PER_MIN` / `RATE_LIMIT_IP_PER_MIN` | 검색 한도. 기본 10 / 60 / 600. `0` 은 해제 — 재배포 없이 값만 바꿔 적용된다 |
| `SESSION_SECRET` | 프로덕션 비밀 키 (32자 이상). 프로필 쿠키 **암호화** 키와 세션 id 서명 키를 여기서 파생한다 |
