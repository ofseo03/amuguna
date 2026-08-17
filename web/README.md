# amuguna — 웹서비스

> 개인 프로필 기반 공공 금융정보 매칭 서비스
> 2026 금융 AI Challenge 출품작 · 상위 스펙은 [`../SPEC.md`](../SPEC.md)

나이·성별·직업·지역과 소득분위/기준중위소득 비율, "원하는 것" 한 줄을 받아,
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
npm test             # 웹 회귀 테스트 + TypeScript 배치 테스트
npm run ingest -- --fixtures --dry-run  # 루트 ingest/ 픽스처 30건 드라이런
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
| 프로필 | 서명 쿠키 (동일) | 서명 쿠키 (동일) — DB 저장 없음 |

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
| 5 | 개인정보처리방침 / 출처 | `/privacy`, `/sources` | `src/app/privacy`, `src/app/sources` |

| 메서드 | 경로 | 파일 |
|---|---|---|
| POST | `/api/profile` | `src/app/api/profile/route.ts` |
| POST | `/api/match` | `src/app/api/match/route.ts` |
| GET | `/api/programs/:id` | `src/app/api/programs/[id]/route.ts` |

### 흐름 확인 (curl)

```bash
# 1) 프로필 생성 — 세션 쿠키 발급
curl -s -c jar -X POST localhost:3000/api/profile -H 'content-type: application/json' \
  -d '{"age":28,"gender":"F","occupation":"employee_office","sidoCode":"11","sigunguCode":"11620","incomeDecile":3,"medianIncomePercent":80}'

# 2) 매칭 — 자유입력은 이 요청에만 쓰이고 저장되지 않는다
curl -s -b jar -X POST localhost:3000/api/match -H 'content-type: application/json' \
  -d '{"query":"보증금 올려달래서 대출 알아봐요","form":"all","cursor":null}'

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

수집기의 공통층은 HTTP·재시도만 담당한다. 응답 형식과 필드 매핑은 소스별 수집기가
소유하며, 중앙부처 복지서비스는 XML 목록을 받은 뒤 각 `servId`의 XML 상세를 조회해
`tgtrDtlCn`과 `slctCritCn`을 자격 파서에 전달한다. 이 공식 목록 API에는 날짜 필터가
없으므로 중앙부처 복지서비스의 `--since`는 API 요청으로 보내지 않는다. 매 회차 전체
목록을 스캔하고, 이미 적재한 ID의 상세 조회를 건너뛰며 `maxDetailCalls` 예산 안에서 신규
건만 상세 적재한다. JSON report의 `incremental_strategy`가 이 동작을 표시한다.

공공데이터포털 전용 어댑터는 `gov24`(보조금24 JSON), `local_welfare`(지자체복지 XML
목록·상세), `kstartup`(K-Startup JSON)이다. 세 소스는 공식 명세 fixture와 테스트에는
포함된다. T1인 `gov24`와 `local_welfare`는 기본 정기 배치 대상이며, 배포 전에 데이터셋별
활용승인과 첫 성공 응답을 반드시 대조한다. T2인 `kstartup`은 승인 후
`npm run ingest -- --source kstartup`처럼 소스별로 검증한다.

### mock 임베딩은 손대지 말 것

`src/lib/embedding.ts` 의 `mockEmbed()` 는 **`ingest/embedder.ts`가 문서를 색인할 때 쓰는
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
따라서 웹 요청 경로에는 OpenRouter API 키를 쓰지 않는다. `OPENROUTER_API_KEY`는
OpenRouter API를 호출하는 독립 Node 배치(`ingest/`)에서만 읽는다.

---

## 팀 공통 계약 데이터

`../shared/*.json` (행정구역 코드 · 직업 대분류 12종 · 소득분위 라벨 · 2026 기준중위소득표)이
단일 출처다. **원본은 수정하지 않는다.**

`scripts/copy-shared.mjs` 가 `predev` / `prebuild` 훅에서 `src/data/` 로 복사한다.
저장소 루트 밖을 import 하지 않게 하려는 것이고, `web/` 만 떼어 배포해도 동작한다
(원본이 없으면 기존 복사본을 그대로 쓴다).

---

## 환경변수

Next.js와 독립 배치의 로컬 실연동 값은 `web/.env.local`에 둔다. `npm run ingest`도
이 파일을 자동으로 읽으며, GitHub Actions에서는 Secrets/Variables로 주입한다. Node.js
**22.9.0 이상**이 필요하다. 배치 스크립트는 이 버전부터 제공되는 Node 내장
`--env-file-if-exists`를 사용하므로 별도 wrapper는 두지 않는다.

```bash
cp .env.example .env.local
```

| 변수 | 기본값 | 설명 |
|---|---|---|
| `DATABASE_URL` | (없음) | 없으면 데모 모드. Supabase Transaction pooler(6543) 권장 |
| `EMBEDDING_PROVIDER` | `mock` | `voyage` (`voyage-4-large`) \| `openai` \| `mock` |
| `EMBEDDING_API_KEY` | (없음) | 실 provider 사용 시 |
| `MOCK_EMBEDDINGS` | — | `1` 이면 provider 무시하고 항상 mock |
| `DATA_GO_KR_API_KEY` | (없음) | 공공데이터포털 소스 실수집 시. 데이터셋별 활용신청 필요 |
| `BIZINFO_API_KEY` | (없음) | 기업마당 실 API 수집 시 |
| `FINLIFE_API_KEY` | (없음) | 금융상품 한눈에 실 API 수집 시 |
| `OPENROUTER_API_KEY` | (없음) | `ingest/` 파싱 보완·요약 시 |
| `LLM_MODEL` | `google/gemma-4-31b-it:free` | OpenRouter 모델 ID |
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

## 실연동 전 확인할 항목

구현은 끝났고 아래 외부 환경만 아직 실물 검증이 필요하다.

1. T1 소스의 실제 응답으로 엔드포인트·파라미터·봉투 필드명을 확인한다. 특히 Finlife의 상품×권역 조합은 공식 안내 페이지가 이 환경에서 열리지 않아 live key로 재검증해야 한다.
2. Supabase에 마이그레이션을 적용한 뒤 `match_programs` RPC를 왕복 검증한다.
3. `voyage-4-large`의 한국어 검색 품질을 실측한다.
4. Vercel 배포와 GitHub Actions 실 배치를 실행해 Secrets와 심사 구간 가용성을 확인한다.

---

## 접근성 (§8)

- 글자 크기 3단계 토글 (전역, localStorage). 루트 `font-size` 를 바꿔 여백·행간까지 함께 커진다.
  `<head>` 인라인 스크립트가 페인트 전에 적용해 깜빡임이 없다.
- 본문 색은 전부 WCAG AA(4.5:1) 이상. 회색을 `gray-400/500` 까지 내리지 않는다.
- 모든 인터랙티브 요소에 레이블, `:focus-visible` outline 유지, "본문 바로가기" 링크.
- 선택지는 네이티브 `radio`/`select` 기반이라 키보드 이동과 스크린리더 그룹 읽기가 그대로 동작한다.
- 행정용어 툴팁 (`src/components/Term.tsx`) — hover 뿐 아니라 키보드 focus 로도 열린다.
- `lang="ko"`, semantic HTML, `word-break: keep-all`, `prefers-reduced-motion` 대응.
