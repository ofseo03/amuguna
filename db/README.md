# db — amuguna 데이터베이스 레이어

Postgres (Supabase) + `pgvector`. SPEC.md §5(데이터 모델) / §7.3(교차 검증) / §7.6(근접 탈락) / §8(개인정보) 구현.

| 파일 | 내용 |
|---|---|
| `migrations/0001_init.sql` | `vector` 확장, `raw_documents` / `programs` / `eligibility_rules` / `program_embeddings`, 인덱스, 불변식 트리거, RLS |
| `migrations/0002_match.sql` | `match_programs()` 교차 검증 RPC + `region_prefixes()` 헬퍼 |
| `migrations/0003_privacy.sql` | `profiles` + `purge_stale_profiles()` (90일 정리) + 스케줄링 안내 |
| `migrations/0004_embedding_provider.sql` | 벡터 공간 혼합을 막는 provider 식별자 |
| `migrations/0005_revoke_api_function_access.sql` | Supabase `anon` / `authenticated` 함수 실행 권한 회수 |
| `migrations/0006_income_axes.sql` | 소득분위와 기준중위소득 비율의 독립 저장·매칭 |
| `migrations/0007_embedding_vector_space.sql` | provider 식별자에 모델명 포함 — 같은 provider 안의 모델 교체도 재색인 |
| `migrations/0008_application_window.sql` | 접수 시작 전 공고를 매칭·상세에서 제외하도록 RPC 갱신 |
| `migrations/0009_operational_integrity.sql` | 원자적 임베딩 전환·수집 baseline·재검토 상태 |
| `migrations/0010_cursor_matching.sql` | 서버 점수 정렬·커서 페이지 RPC |
| `migrations/0012_drop_profiles.sql` | `profiles` 제거 — 프로필은 서명 쿠키에만 두고 서버에 저장하지 않는다 |
| `migrations/0013_page_offset.sql` | `match_program_page()` 에 행 offset 추가 — 먼 페이지 번호를 요청 한 번으로 연다 |

---

## 1. 적용

번호 순서대로 **한 번씩** 적용한다. 재실행을 가정한 멱등 스크립트가 아니다(`CREATE TABLE` 에 `IF NOT EXISTS` 를 두지 않았다 — 이미 만들어진 스키마를 조용히 건너뛰는 것보다 에러가 낫다).

```bash
# psql 직접 적용
for f in db/migrations/*.sql; do
  psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$f"
done

# 또는 Supabase CLI (supabase/migrations/ 로 심볼릭 링크하거나 복사한 뒤)
supabase db push
```

각 파일은 `BEGIN; ... COMMIT;` 으로 감싸져 있어 중간에 실패하면 통째로 롤백된다.

`0001` / `0003` 의 마지막 `DO $$ ... $$` 블록은 `anon` / `authenticated` / `service_role` 롤이 **있을 때만** 권한을 조정한다. Supabase 가 아닌 순정 Postgres(로컬 검증용)에서도 그대로 돈다.

`0004`/`0007` 적용 직후와 `EMBEDDING_PROVIDER` **또는 임베딩 모델** 변경 시에는 `npm run ingest -- --weekly-reconcile`로 전량 재색인한다. 증분 실행은 기존 값이 다르거나 unknown이면 실패해 서로 다른 벡터 공간이 섞이는 것을 막는다.

`provider` 는 provider 단독이 아니라 `provider[:model]` 을 담는다 (`voyage:voyage-4-large`, mock 은 모델이 없어 `mock`). provider 만 저장하면 `voyage-3 → voyage-4-large` 같은 **같은 provider 안의 모델 교체를 감지하지 못해**, 옛 벡터 공간의 문서가 새 모델의 질의 벡터와 비교되며 유사도가 조용히 망가진다.

### 로컬 검증

```bash
sudo apt-get install -y postgresql-16 postgresql-16-pgvector
initdb -D /tmp/pg && pg_ctl -D /tmp/pg -o "-p 55432" start
createdb -p 55432 amuguna
for f in db/migrations/*.sql; do
  psql -v ON_ERROR_STOP=1 -p 55432 -d amuguna -f "$f"
done
```

---

## 2. 환경변수

| 변수 | 값 | 두는 곳 |
|---|---|---|
| `DATABASE_URL` | `postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres` | Next.js 서버·Node 배치·GitHub Actions Secret |

- `DATABASE_URL`은 서버 전용이다. `NEXT_PUBLIC_` 접두사를 붙이지 말 것 — 붙는 순간 번들에 실려 나간다.
- 커넥션 풀러(포트 `6543`, PgBouncer transaction mode)를 쓸 경우 `PREPARE` / 세션 GUC 가 요청 간에 유지되지 않는다. `match_programs()` 는 트랜잭션 로컬 설정만 쓰므로 영향이 없지만, 마이그레이션은 반드시 직결 포트 `5432` 로 적용한다.
- SPEC §8: 수집 API 키·임베딩 키·OpenRouter 키도 전부 서버 환경변수. OpenRouter 키는
  Vercel 요청 런타임에서만 쓰며 클라이언트·GitHub Actions 수집 배치에 노출하지 않는다.

---

## 3. `match_programs()` — 교차 검증 RPC

```sql
match_programs(
  p_age            int,           -- 만 나이
  p_gender         text,          -- 'M' | 'F' | NULL('선택 안 함')
  p_region_codes   text[],        -- {시도2, 시군구5} — region_prefixes() 로 만든다
  p_occupation     text,          -- shared/occupations.json 의 code
  p_income_decile  int,           -- 1..10, 모르면 NULL
  p_median_income_percent int,    -- 기준중위소득 대비 %, 모르면 NULL
  p_qvec           vector(1024),          -- NULL = 의도 입력 건너뜀
  p_topk           int                    -- 청크 단위 top-k
) RETURNS TABLE (
  program_id     bigint,
  sim            real,   -- 코사인 유사도. p_qvec IS NULL 이면 NULL
  violations     int,    -- 0 = 자격 통과(집합 A), 1 = 근접 탈락(§7.6)
  violated_field text    -- violations=1 일 때 'age'|'gender'|'region'|'occupation'|'income'
)
```

`violations = 0` 과 `1` 이 **한 벌로** 나온다. 애플리케이션이 갈라 쓴다 — 0 은 §7.4 스코어링 후 15건 단위 페이지네이션, 1 은 상위 5건만 별도 섹션. SQL 은 근접 탈락을 자르지 않는다.

`violations >= 2` 는 반환하지 않고, `B − A`(자격 미달)도 어느 경우에도 나오지 않는다.

### 워크드 예제 — P1 (28세 / 여 / 사무직 / 서울 관악구 / 3분위)

```sql
-- 의도 입력 있음: "보증금 올려달래서 대출 알아봐요" 를 임베딩한 1024차 벡터
SELECT program_id, sim, violations, violated_field
FROM match_programs(
       28,
       'F',
       region_prefixes('11620'),        -- → {11,11620}
       'employee_office',
       3,
       80,
       '[0.0123,-0.0456, ... 1024개 ... ,0.0789]'::vector(1024),
       200
     )
ORDER BY violations, sim DESC;
```

```
 program_id |   sim    | violations | violated_field
------------+----------+------------+----------------
        142 | 0.812345 |          0 |
         77 | 0.744120 |          0 |
        901 | 0.690033 |          1 | income
```

```sql
-- 의도 입력을 건너뛴 경로 (P3). p_qvec 에 NULL 을 넘기면 sim 은 NULL 이고 자격 축만으로 동작한다.
SELECT * FROM match_programs(67, 'F', region_prefixes('46150'), 'retired', 1, 70, NULL::vector, 200);

-- §7.7 1단계 완화: top-k 200 → 500
SELECT * FROM match_programs(28,'F',region_prefixes('11620'),'employee_office',3,80,$1::vector,500);
```

### 벡터를 wire 로 넘기는 법

`vector` 는 **텍스트 리터럴 `'[a,b,c]'` 로 직렬화**한다. JSON 배열이 아니라 문자열이다.

```ts
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false });
const qvec: number[] = await embed(userText); // 길이 1024
const rows = await sql`
  SELECT * FROM match_programs(
    ${28}, ${"F"}, ${["11", "11620"]}, ${"employee_office"}, ${3},
    ${80}, ${`[${qvec.join(",")}]`}::vector, ${200}
  )`;
```

차원이 1024가 아니면 `different vector dimensions N and 1024` 로 즉시 실패한다 — 임베딩 모델을 바꿨는데 스키마를 안 바꾼 상황이 조용히 지나가지 않는다.

### 알아둘 동작

- **`hnsw.ef_search`** — pgvector 기본값이 40이라 `LIMIT 200` 을 걸어도 HNSW 인덱스 스캔은 40행만 돌려주고 멈춘다. `match_programs()` 는 벡터 경로에서 `set_config('hnsw.ef_search', k, true)` 로 요청한 k 에 맞춰 올린다(트랜잭션 로컬, 함수 종료 시 원복). 직접 벡터 쿼리를 쓸 일이 있으면 **같은 처리를 반드시 할 것.** 로컬 실측: `ef_search=40 → 40행`, `200 → 200행`, `500 → 500행`.
- **top-k 선절단** — HNSW top-k 는 자격 필터 *이전에* 잘린다(사후 필터). 자격 통과분이 top-k 안에 적으면 교집합이 실제보다 작아진다. 완화 순서는 SPEC §7.7 그대로: ① `p_topk` 200→500 ② `p_qvec = NULL` ③ 근접 탈락만 노출. 그래도 부족하면 pgvector 0.8+ 의 `hnsw.iterative_scan`.
- **`p_topk` 방어** — `NULL`→200, 0·음수→1, 상한 5000 으로 클램프한다.
- **페이지 정렬** — `match_program_page()`가 §7.4 스코어와 `id` tie-break로 정렬해 15건 커서를 반환한다. 웹은 전체 후보를 메모리에 올리지 않는다.

---

## 4. RLS — **켜고 정책 없음(deny-all)** + service-role 우회

공개 스키마의 애플리케이션 테이블은 모두 `ENABLE ROW LEVEL SECURITY` 이고 정책은 **하나도 만들지 않았다**. `service_role` 은 `BYPASSRLS` 라 서버 경로는 영향이 없다. `anon` / `authenticated` 에서는 테이블 권한도 `REVOKE` 했고, 공개 함수의 `PUBLIC` 실행 권한도 회수했다.

**RLS 끄기를 고르지 않은 이유.** Supabase 는 `public` 스키마를 PostgREST 로 자동 노출하고, anon 키는 설계상 브라우저에 내려간다. RLS 를 끄면 "서버를 통해서만 접근한다"가 코드 관례에 불과해지고, anon 키 하나로 수집 데이터와 배치 운영 상태가 그대로 읽힌다. RLS 를 켜두면 그 관례가 DB 가 강제하는 규칙이 된다. 개인정보를 저장하지 않게 된 뒤에도(0012) 비용이 0인 방어를 뺄 이유는 없다.

로컬 검증: `anon` 롤에 `GRANT SELECT ON ALL TABLES` 를 명시적으로 준 상태에서도 `programs` / `program_embeddings` 조회 결과가 전부 0행이었다.

> 앞으로 클라이언트에서 직접 읽을 테이블이 생기면 그때 **해당 테이블에만** 정책을 추가한다. RLS 를 끄는 방향으로 되돌리지 말 것.

---

## 5. 수집·파싱 팀(ingest) 통합 노트

### 적재 순서 (SPEC §3.2)

```sql
-- 1) 원문은 항상 INSERT (덮어쓰지 않는다 = 버전 이력)
INSERT INTO raw_documents (external_id, source_key, source_url, content_hash, raw_body)
VALUES ($1,$2,$3,$4,$5) RETURNING id;

-- 2) 프로그램은 external_id 로 upsert. id 는 유지된다 (상세 URL·알림 중복 방지)
INSERT INTO programs (external_id, raw_document_id, title, body_text, summary, apply_steps,
                      form, issuer, issuer_level, benefit_amount_text, benefit_amount_min,
                      benefit_amount_max, apply_url, apply_method, starts_at, ends_at,
                      is_always_open, source_url, fetched_at, status)
VALUES (...)
ON CONFLICT (external_id) DO UPDATE SET
  raw_document_id = EXCLUDED.raw_document_id,
  title = EXCLUDED.title, body_text = EXCLUDED.body_text, /* ... */
  last_changed_at = now(), fetched_at = now()
RETURNING id;

-- 3) 자격요건도 upsert. 행은 이미 존재한다 (아래 트리거 참고)
INSERT INTO eligibility_rules (program_id, age_min, age_max, gender, regions, occupations,
                               income_decile_max, median_income_percent_max,
                               extra_conditions, parse_method,
                               parse_evidence, confidence)
VALUES (...)
ON CONFLICT (program_id) DO UPDATE SET
  age_min = EXCLUDED.age_min, /* ... */ confidence = EXCLUDED.confidence;

-- 4) 같은 vector space의 개별 공고는 삭제 후 재삽입 (청크 잔여 방지)
DELETE FROM program_embeddings WHERE program_id = $1;
INSERT INTO program_embeddings (program_id, chunk_idx, embedding, provider) VALUES ...;
```

provider·모델이 바뀌는 전량 재색인은 `program_embedding_staging`을 먼저 완성·검증한 뒤,
짧은 트랜잭션에서 활성 테이블과 `ingest_embedding_state` 포인터를 교체한다. 중간 실패 시
기존 활성 벡터는 유지된다.

무변경(hash 동일) 건은 `UPDATE programs SET fetched_at = now()` 만 하고 파싱·임베딩을 건너뛴다.

### DB 가 강제하는 불변식 — 알고 있어야 할 것

1. **`programs` INSERT 시 `eligibility_rules` 행이 자동 생성된다** (트리거 `programs_ensure_eligibility_row_trg`). 전 필드 `NULL` = 조건 없음 = 전원 통과.
   §7.3 의 `eligible` 이 `INNER JOIN` 이라, 규칙 행이 없으면 그 프로그램은 결과에서 **조용히 사라진다.** "누락이 오탐보다 비싸다"(§7.3)와 정면으로 충돌하므로 DB 가 전제를 보장한다.
   자격요건이 아예 없는 소스(금감원 금융상품 등)는 이 기본 행을 그대로 두면 된다 — SPEC §10 이 예상하는 동작 그대로다.
2. **`status` 를 `'expired'` 또는 `'needs_review'` 로 바꾸면 임베딩 행이 자동 삭제된다** (트리거 `programs_drop_embeddings_on_expire_trg`). 비활성 건이 벡터 top-k 슬롯을 점유하지 않게 한다. 다시 `active` 로 되돌리면 **재임베딩이 필요하다.**
3. **`regions` / `occupations` 에 빈 배열 `'{}'` 을 넣을 수 없다** (CHECK). `NULL`(=무관, 통과)과 달리 `'{}' && ARRAY[...]` 는 항상 false 라 전원을 탈락시키는 조용한 파서 버그가 된다. 조건이 없으면 `NULL` 을 넣을 것.
4. **`regions` 원소는 2자리 또는 5자리 숫자여야 한다** (CHECK). `&&` 는 원소 동등 비교라 3자리·6자리가 섞이면 매칭이 0건이 된다(SPEC §5 경고). 코드 사전은 `shared/regions.json`.
5. `age_min <= age_max`, `benefit_amount_min <= benefit_amount_max`, `starts_at <= ends_at`, 상태 화이트리스트, 소득분위 1..10, 기준중위소득 비율 범위, 나이 0..120 — 전부 CHECK 로 막혀 있다. 파서 검증(SPEC §6.2)과 이중으로 걸린다.

### `ends_at` 은 `date` 이고 KST 기준으로 비교한다

SPEC §7.3 에는 `ends_at >= now()` 로 적혀 있지만, `ends_at` 은 날짜형이고 DB 타임존은 UTC 다. `date` 를 `now()` 와 직접 비교하면 자정 기준으로 캐스팅돼 **'오늘 마감'인 공고가 마감일 당일 내내 결과에서 빠진다.** `match_programs()` 는 이렇게 비교한다:

```sql
p.ends_at IS NULL OR p.ends_at >= (now() AT TIME ZONE 'Asia/Seoul')::date
```

`programs` 를 직접 조회하는 곳(카드 D-n 계산, 마감 임박 알림, 관리 화면)에서도 같은 식을 쓸 것. `ends_at` 에는 마감일 당일 날짜를 그대로 넣으면 된다.

---

## 6. 웹 팀 통합 노트

- `POST /api/profile` → **DB 를 쓰지 않는다.** 프로필은 서명한 httpOnly 쿠키에만 담는다. 서버에 저장하는 개인정보가 없다는 것이 §8 의 강제 장치다.
- `POST /api/match` → 쿠키에서 프로필을 읽어 `match_programs(age, gender, region_prefixes(region_code), occupation, income_decile, median_income_percent, qvec, 200)`.
  **자유입력 원문도 어디에도 저장하지 않는다**(§8). 임베딩 API에 보내고, 질의가 있는 최초 전체 검색에서만
  OpenRouter에 질의와 상위 5건의 공개 메타데이터를 보내 답변 하나를 만든다. 프로필·쿠키·원문 본문은 보내지 않으며 답변도 저장하지 않는다.
- `GET /api/programs/:id` → 상세. 자격 체크리스트(✅/❌)는 `eligibility_rules` 한 행을 읽어 프로필과 대조해 템플릿으로 조립한다. `extra_conditions` 는 "추가 확인 필요 조건"으로 그대로 노출하고 판정에 쓰지 않는다(§6.3).
- 임베딩 API 실패 시 `p_qvec` 을 `NULL` 로 넘기면 자격 축만으로 degraded 동작한다(§8 신뢰성). 별도 코드 경로가 필요 없다.
- `sim` 은 `p_qvec IS NULL` 일 때 `NULL` 이다. §7.4 에서 유사도 가중치 0.30 을 빼고 나머지를 정규화할 것.

---

## 7. 개인정보 보존기간 (SPEC §8)

**DB 에 보존할 개인정보가 없다.** `0012` 가 `profiles` 와 `purge_stale_profiles()` 를 제거했다. 프로필은 서명한 브라우저 쿠키에만 있고 90일 뒤 만료된다. 따라서 삭제 배치가 필요 없다.

`0003` 과 `0006` 은 이력 보존을 위해 남겨 두었다. 새 환경도 번호 순서대로 적용하면 `0012` 에서 정리되므로 결과는 같다.

**이미 `0011` 을 적용한 DB가 있다면 `0012` 를 반드시 적용해야 한다.** `0011` 이 만든 `notification_outbox` 에는 이메일과 발송 payload 가 들어 있고, `profiles` 에는 이메일·확인 토큰이 남아 있다. `0012` 는 FK 의존성 때문에 `notification_outbox` 를 먼저 지운 뒤 `profiles` 를 지운다.

DB 에 남는 것은 공공 API 에서 수집한 지원사업 데이터(`raw_documents` / `programs` / `eligibility_rules` / `program_embeddings`)와 배치 운영 상태뿐이다.

---

## 8. 스키마 요약

```
raw_documents ──< programs ──1:1── eligibility_rules
                     │
                     ├──< program_embeddings (활성)
                     └──< program_embedding_staging (재색인 중)

ingest_embedding_state · ingest_source_baselines (배치 운영 상태)

개인정보 테이블 없음 — 프로필은 브라우저 쿠키에만 있다 (0012)
```

| 인덱스 | 용도 |
|---|---|
| `raw_documents (external_id, fetched_at DESC)` | 최신 원문 버전 조회 + 변경 이력 (SPEC §5) |
| `programs (external_id) UNIQUE` | upsert 키 |
| `programs (status, ends_at)` | `match_programs` 자격 스캔 진입점 |
| `programs (last_changed_at DESC)` | 변경분 조회·알림 |
| `programs (raw_document_id)` | 원문 역참조 |
| `eligibility_rules (program_id)` PK | 1:1 조인 |
| `program_embeddings (program_id, chunk_idx)` PK | 재임베딩 시 삭제·재삽입 |
| `program_embeddings USING hnsw (embedding vector_cosine_ops)` | 코사인 top-k (SPEC §5) |
| `program_embeddings.provider` | provider·모델 전환 시 전 공고를 한 번 재색인해 벡터 공간 혼합 방지 |

열거값은 enum 타입이 아니라 `text + CHECK` 다 — PostgREST·수집기에서 캐스팅이 필요 없고, 값 추가에 `ALTER TYPE` 이 필요 없다.

`programs` 행 수가 적을 때(수천 건)는 플래너가 `program_embeddings` 를 순차 스캔하고 정확한 top-k 를 낸다. 데이터가 늘면 자동으로 HNSW 로 전환된다 — 어느 쪽이든 결과 의미는 같고, HNSW 쪽이 근사라는 점만 다르다.

---

## 9. SPEC 대비 편차

| 항목 | SPEC | 구현 | 이유 |
|---|---|---|---|
| `ends_at` 비교 | `ends_at >= now()` | `ends_at >= (now() AT TIME ZONE 'Asia/Seoul')::date` | `date` vs `timestamptz` 비교가 자정 기준으로 캐스팅돼 '오늘 마감' 공고가 당일 내내 누락된다. §5 위 참고 |
| 위반 카운트 축 | §7.6 "6개 조건" | 5개 축 (`age_min`/`age_max` 를 `age` 한 축으로) | 팀 계약의 `violated_field` 5종과 일치시킨다. `age_min <= age_max` CHECK 때문에 둘이 동시에 어긋날 수 없어 결과는 동일 |
| CTE 이름 | `similar`, `similar_by_program` | `vec_topk`, `vec_by_program` | `SIMILAR` 은 SQL 예약어라 파싱 에러가 난다 |
| `eligibility_rules` 행 생성 | 명시 없음 | `programs` INSERT 시 트리거로 자동 생성 | §7.3 의 `INNER JOIN` 이 1:1 을 전제한다. 규칙이 관례가 아니라 DB 불변식이 된다 |
| `hnsw.ef_search` | 명시 없음 | 벡터 경로에서 `p_topk` 에 맞춰 상향 | 기본값 40 이라 `LIMIT 200` 이 실제로는 top-40 이 된다 (실측) |
| `profiles` 테이블 | §5 프로필 저장 | 저장하지 않음 (0012 에서 제거) | 매칭에 쿠키 프로필이면 충분했고, 유일한 저장 이유였던 알림을 MVP 에서 뺐다(§11). 저장하지 않으면 지킬 것도 없다 |

---

## 10. 콜드 스타트와 시드 스냅샷 (SPEC §3.2)

### 문제

"실패 시 직전 성공 스냅샷 유지"는 **직전 스냅샷이 있을 때만** 성립한다. 첫 배포에는 없다.
게다가 중앙부처복지는 상세조회 100회/일이라 461건을 채우는 데 6일이 걸린다 —
그 사이에 심사위원이 들어오면 빈 결과를 본다.

### 진행률 확인

```bash
DATABASE_URL='postgres://...' node web/scripts/coldstart-eta.mjs
```

소스별 적재 건수와 남은 일수를 계산한다. `DATABASE_URL` 없이 돌리면 0건 기준 최악 가정으로 보여준다.
첫 목록 호출에서 `totalCount` 를 확인하면 그 값을 스크립트의 `estimatedTotal` 에 반영한다.

### 시드 스냅샷

적재가 한 번 완주하면 **그 상태를 덤프해 둔다.** DB 가 날아가거나 배치가 데이터를 망가뜨렸을 때
6일을 다시 기다리지 않고 복구하기 위한 것이다. 커스텀 도구를 두지 않고 `pg_dump` 를 쓴다 —
스키마가 바뀌어도 따로 유지보수할 코드가 없다.

```bash
# 덤프 — 수집 결과 4개 테이블 + 임베딩 공간 상태
pg_dump "$DATABASE_URL" \
  --data-only --no-owner --no-privileges \
  -t raw_documents -t programs -t eligibility_rules \
  -t program_embeddings -t ingest_embedding_state \
  -f seed-$(date +%F).sql

# 복구 — 빈 DB에 마이그레이션을 먼저 적용한 뒤
for f in db/migrations/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f seed-2026-09-01.sql
```

주의할 점 세 가지.

- **`ingest_embedding_state` 를 빼면 안 된다.** 이 행의 `active_vector_space` 가 임베딩 벡터와
  맞지 않으면 웹이 의도 축을 통째로 degraded 처리한다 (`src/lib/matching.ts`).
- **`program_embedding_staging` 은 뺀다.** 재색인 중간 산물이라 복구 대상이 아니다.
- **덤프에 개인정보가 없다.** 프로필은 서버에 저장하지 않으므로(§8) 이 덤프는 전부 공공 API
  수집분이다. 다만 용량이 크므로(임베딩 1024차원 × 청크) 저장소는 저장소대로 확보해 둔다.

심사 구간 직전(9/6)에 한 번, 그리고 적재가 처음 완주한 날 한 번 뜨는 것을 권한다.
