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
| `db/` | Postgres 마이그레이션 — 스키마(§5), `match_programs` 교차검증·근접탈락 RPC(§7.3/7.6). 개인정보 테이블은 없다(§8). [db/README.md](db/README.md) |
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
| `EMBEDDING_PROVIDER` / `EMBEDDING_API_KEY` | `voyage` \| `openai` \| `mock` (Voyage 모델: `voyage-4-large`, 차원 1024 고정) |
| `OPENROUTER_API_KEY` | 배치 전용 — OpenRouter로 파싱 보완 + 요약 생성 (`google/gemma-4-31b-it:free`) |
| `LLM_FALLBACK_MODELS` | 기본 모델 실패 시 시도할 대체 모델 (쉼표 구분). 비우면 폴백 없음 |
| `RATE_LIMIT_SESSION_PER_MIN` / `RATE_LIMIT_ANON_PER_MIN` / `RATE_LIMIT_IP_PER_MIN` | 검색 한도. 기본 10 / 60 / 600. `0` 은 해제 — 재배포 없이 값만 바꿔 적용된다 |
| `SESSION_SECRET` | 프로덕션 비밀 키 (32자 이상). 프로필 쿠키 **암호화** 키와 세션 id 서명 키를 여기서 파생한다 |

## 배포 (Vercel)

**Root Directory 를 반드시 `web` 으로 지정한다.** 저장소 루트에는 `package.json` 이 없고
Next.js 앱은 `web/` 에 있다. 루트를 그대로 두면 Vercel 이 빌드할 앱을 찾지 못해 배포에
라우트가 하나도 생기지 않고, 모든 주소가 Vercel 자체 `404: NOT_FOUND` 페이지를 띄운다
(앱이 뜬 상태의 404 는 `web/src/app/not-found.tsx` 의 한국어 화면이므로 구분된다).

1. 저장소를 import → **Settings → Build & Deployment → Root Directory = `web`**
2. Framework Preset 은 Next.js 자동 감지. Build / Output 은 기본값 그대로 둔다
3. Environment Variables 에 최소 `SESSION_SECRET` 을 넣는다 — 없으면 화면은 뜨지만
   온보딩 저장이 500 으로 실패한다
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```
4. `DATABASE_URL` 은 나중에 추가해도 된다. 없는 동안에는 데모 모드로 정상 서비스된다

자세한 항목은 [web/README.md](web/README.md#vercel-배포).
