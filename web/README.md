# amuguna — 웹서비스

> 개인 프로필 기반 공공 금융정보 매칭 서비스
> 2026 금융 AI Challenge 출품작 · 상위 스펙은 [`../SPEC.md`](../SPEC.md)

나이·성별·직업·지역·소득분위 5필드와 "원하는 것" 한 줄을 받아,
**자격(SQL 규칙 대조) ∩ 의도(벡터 유사도)** 의 교집합만 카드로 보여준다.

---

## 빠른 시작

```bash
cd web
npm install
npm run dev          # http://localhost:3000
```

**환경변수를 하나도 설정하지 않아도 그대로 동작한다** (→ 데모 모드).

```bash
npm run build        # 프로덕션 빌드 (검증 게이트)
npm run start        # 빌드 결과 실행
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit
npm run sync:shared  # ../shared/*.json → src/data/ 재복사
```

---

## 데모 모드 (DATABASE_URL 없음)

대회 데모와 오프라인 개발을 위해, **DB 없이도 전 기능이 동작한다.**

| | 데모 모드 | DB 모드 |
|---|---|---|
| 트리거 | `DATABASE_URL` 미설정 | `DATABASE_URL` 설정 |
| 데이터 | `src/demo/programs.json` (22건) | Supabase Postgres |
| 자격 판정 | TypeScript (`src/lib/eligibility.ts`) | RPC `match_programs(...)` |
| 벡터 검색 | 인메모리 코사인 (`src/lib/demo-store.ts`) | pgvector HNSW |
| 스코어링 | `src/lib/scoring.ts` (동일) | `src/lib/scoring.ts` (동일) |
| 근접탈락·완화 | `src/lib/matching.ts` (동일) | `src/lib/matching.ts` (동일) |
| 알림 신청 | 저장 없이 안내만 | `profiles` 테이블 |

스코어링·근거 문장·근접탈락·빈결과 완화는 **두 모드가 같은 코드를 탄다.**
백엔드 차이는 "후보를 어디서 가져오는가" 하나뿐이다.

### 데모 데이터셋

`src/demo/programs.json` — 실제 제도를 참고해 구성한 22건. 금액·기한은 시연용 값이다.
`ends_at` 은 절대 날짜 대신 `demo_ends_in_days`(오늘로부터 N일)로 적는다 —
절대 날짜로 박아두면 시간이 지나 전 건이 만료되어 데모가 빈 화면이 되기 때문이다.

### 데모 모드의 유일한 로직 차이

DB 모드에서 집합 B(의도 축)는 **HNSW top-k 절단**이 정의한다. 그런데 데모 데이터셋은
22건뿐이라 top-k 200 이 전 건을 포함해 버려 교집합이 항상 A 와 같아진다 —
교차 검증이 시연되지 않는다. 그래서 **데모에서만** 유사도 하한으로 B 를 정의한다
(`DEMO_B_RELATIVE = 0.45`, `DEMO_B_ABS_FLOOR = 0.10` in `src/lib/matching.ts`).
SPEC §5 의 예시 문구 4종으로 실측해 정한 값이다.

같은 이유로 §7.7 완화 1단계(top-k 200→500)는 데모 규모에서 k 만 키워봐야 효과가 없으므로,
그 단계에서 하한도 함께 완화해 실제로 후보가 늘어나게 했다.

---

## 화면 / 엔드포인트

| # | 화면 | 경로 | 파일 |
|---|---|---|---|
| 1 | 랜딩 | `/` | `src/app/page.tsx` |
| 2 | 온보딩 6단계 | `/onboarding` | `src/app/onboarding/page.tsx` |
| 3 | 결과 | `/results` | `src/app/results/page.tsx` |
| 4 | 상세 | `/programs/[id]` | `src/app/programs/[id]/page.tsx` |
| 5 | 알림 신청 / 해지 | `/subscribe`, `/unsubscribe` | `src/app/subscribe`, `src/app/unsubscribe` |
| 6 | 개인정보처리방침 / 출처 | `/privacy`, `/sources` | `src/app/privacy`, `src/app/sources` |

| 메서드 | 경로 | 파일 |
|---|---|---|
| POST | `/api/profile` | `src/app/api/profile/route.ts` |
| POST | `/api/match` | `src/app/api/match/route.ts` |
| GET | `/api/programs/:id` | `src/app/api/programs/[id]/route.ts` |
| POST | `/api/subscribe` | `src/app/api/subscribe/route.ts` |
| GET | `/api/unsubscribe/:token` | `src/app/api/unsubscribe/[token]/route.ts` |

### 흐름 확인 (curl)

```bash
# 1) 프로필 생성 — 세션 쿠키 발급
curl -s -c jar -X POST localhost:3000/api/profile -H 'content-type: application/json' \
  -d '{"age":28,"gender":"F","occupation":"employee_office","sidoCode":"11","sigunguCode":"11620","incomeDecile":3}'

# 2) 매칭 — 자유입력은 이 요청에만 쓰이고 저장되지 않는다
curl -s -b jar -X POST localhost:3000/api/match -H 'content-type: application/json' \
  -d '{"query":"보증금 올려달래서 대출 알아봐요","form":"all","page":1}'

# 3) 상세 — 세션 프로필과 대조한 자격 체크리스트 포함
curl -s -b jar localhost:3000/api/programs/1
```

---

## 핵심 모듈

| 파일 | 역할 | SPEC |
|---|---|---|
| `src/lib/embedding.ts` | 질의 임베딩 + **mock 임베딩 계약 알고리즘** | §7.2 |
| `src/lib/eligibility.ts` | 자격 판정, 근거 문장 템플릿, 근접탈락 문구, 체크리스트 | §7.3 §7.5 §7.6 |
| `src/lib/scoring.ts` | 5요소 가중 스코어링 | §7.4 |
| `src/lib/matching.ts` | 두 백엔드 오케스트레이션 + 빈결과 완화 | §7.3 §7.7 |
| `src/lib/demo-store.ts` | 번들 데이터셋 로더 + 청크 임베딩 인덱스 | §7.1 |
| `src/lib/db.ts` | Supabase 접속 (`postgres`) | — |
| `src/lib/validation.ts` | 서버 측 입력 검증 | §8 |
| `src/lib/session.ts` | 서명된 httpOnly 프로필 쿠키 | §8 |
| `src/lib/rate-limit.ts` | 세션+IP 10회/분 | §8 |
| `src/lib/shared-data.ts` | 팀 공통 계약 데이터 접근자 | — |

### mock 임베딩은 손대지 말 것

`src/lib/embedding.ts` 의 `mockEmbed()` 는 **수집 팀(Python)이 문서를 색인할 때 쓰는
알고리즘과 완전히 동일해야 한다.** 한 글자라도 어긋나면 유사도가 전부 무의미해진다.

```
dim = 1024
NFC 정규화 → 소문자화 → 코드포인트 시퀀스
인접 코드포인트 쌍 (c1, c2) 마다  idx = (c1*31 + c2) % 1024  위치를 +1
코드포인트가 2개 미만이면 v[0] = 1
L2 정규화
```

### 요청 경로에 LLM이 없다

SPEC §7.5 그대로다. 한 줄 요약과 신청 절차 3단계는 수집 배치가 미리 만들어 DB에 넣고,
매칭 근거 문장은 `eligibility_rules` 의 매칭된 필드로 **템플릿 조립**한다.
그래서 이 프로젝트에 Anthropic API 키가 없다 — 사용자 입력이 LLM에 닿는 경로 자체가 없다.

---

## 팀 공통 계약 데이터

`../shared/*.json` (행정구역 코드 · 직업 대분류 12종 · 소득분위 라벨 · 중위소득 환산표)이
단일 출처다. **원본은 수정하지 않는다.**

`scripts/copy-shared.mjs` 가 `predev` / `prebuild` 훅에서 `src/data/` 로 복사한다.
저장소 루트 밖을 import 하지 않게 하려는 것이고, `web/` 만 떼어 배포해도 동작한다
(원본이 없으면 기존 복사본을 그대로 쓴다).

---

## 환경변수

`.env.example` 을 `.env.local` 로 복사해서 채운다. 자세한 설명은 그 파일에 있다.

| 변수 | 기본값 | 설명 |
|---|---|---|
| `DATABASE_URL` | (없음) | 없으면 데모 모드. Supabase Transaction pooler(6543) 권장 |
| `EMBEDDING_PROVIDER` | `mock` | `voyage` \| `openai` \| `mock` |
| `EMBEDDING_API_KEY` | (없음) | 실 provider 사용 시 |
| `MOCK_EMBEDDINGS` | — | `1` 이면 provider 무시하고 항상 mock |
| `SESSION_SECRET` | 개발용 고정값 | **배포 시 필수.** 프로필 쿠키 서명 키 |

---

## Vercel 배포

1. Vercel에서 저장소를 import 하고 **Root Directory 를 `web` 으로** 지정한다.
   (모노레포 루트가 아니라 `web/` 이 Next.js 앱이다.)
2. Framework Preset 은 Next.js 자동 감지. Build Command / Output 은 기본값 그대로.
3. Environment Variables 에 최소 `SESSION_SECRET` 을 넣는다.
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```
4. DB를 붙일 준비가 되면 `DATABASE_URL` 을 추가하고 재배포한다.
   변수가 없는 동안에는 데모 모드로 정상 서비스된다.

> `prebuild` 훅이 `../shared` 를 읽으므로 저장소 전체를 clone 하는 기본 설정이면 그대로 동작한다.
> `web/` 만 배포하는 경우 `src/data/` 의 복사본이 사용된다.

보안 헤더(CSP·HSTS·X-Frame-Options 등)는 `next.config.ts` 에서 전 경로에 적용된다.

---

## DB 연동 시 남는 작업

DB 모드 코드 경로는 이미 있고, 아래만 채우면 전환된다.

1. **RPC 계약 확인** — `src/lib/matching.ts` 의 `dbCandidates()`.
   ```
   match_programs(p_age int, p_gender text, p_region_codes text[],
                  p_occupation text, p_income_decile int,
                  p_qvec vector(1024) DEFAULT NULL, p_topk int DEFAULT 200)
   RETURNS TABLE (program_id bigint, sim real, violations int, violated_field text)
   ```
   벡터는 `'[0.1,...]'::vector` 리터럴로 바인딩한다 (`toPgVectorLiteral`).

2. **프로그램 행 조회 SQL** — 같은 파일 `dbCandidates()` 하단과 `getProgram()`.
   `programs LEFT JOIN eligibility_rules` 로 카드/상세에 필요한 컬럼을 가져온다.
   컬럼명이 SPEC §5 와 다르면 `rowToProgram()` 매핑만 고치면 된다.

3. **`profiles` 스키마 보강** — `src/app/api/subscribe/route.ts`.
   SPEC §5 의 `profiles` 에는 `email` 만 있다. 1클릭 해지를 하려면
   `unsubscribe_token text UNIQUE` 컬럼이 추가로 필요하다. 현재 코드는 이 컬럼을 전제로 쓴다.

4. **90일 자동 삭제 cron** — 아직 없다 (§8).
   `email IS NULL AND created_at < now() - interval '90 days'` 인 프로필을 지우는 배치가 필요하다.
   이메일이 있는 프로필은 제외해야 알림이 조용히 죽지 않는다.

5. **실 임베딩 provider 연결** — `src/lib/embedding.ts` 의 `embedQuery()`.
   현재는 mock 으로 폴백하는 자리만 있다. W1 한국어 성능 실측 후 확정한다.
   수집 파이프라인과 **같은 provider·같은 모델**이어야 한다.

6. **Rate limit 공유 저장소** — `src/lib/rate-limit.ts`.
   지금은 인메모리라 Vercel 다중 인스턴스에서 인스턴스당 한도가 된다.
   트래픽이 늘면 Upstash Redis 등으로 교체한다 (교체 지점은 이 파일 하나).

---

## 접근성 (§8)

- 글자 크기 3단계 토글 (전역, localStorage). 루트 `font-size` 를 바꿔 여백·행간까지 함께 커진다.
  `<head>` 인라인 스크립트가 페인트 전에 적용해 깜빡임이 없다.
- 본문 색은 전부 WCAG AA(4.5:1) 이상. 회색을 `gray-400/500` 까지 내리지 않는다.
- 모든 인터랙티브 요소에 레이블, `:focus-visible` outline 유지, "본문 바로가기" 링크.
- 선택지는 네이티브 `radio`/`select` 기반이라 키보드 이동과 스크린리더 그룹 읽기가 그대로 동작한다.
- 행정용어 툴팁 (`src/components/Term.tsx`) — hover 뿐 아니라 키보드 focus 로도 열린다.
- `lang="ko"`, semantic HTML, `word-break: keep-all`, `prefers-reduced-motion` 대응.
