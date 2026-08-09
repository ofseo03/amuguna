-- =============================================================================
-- amuguna — 0001_init.sql
-- 스키마 초기화: 확장 / 테이블 / 인덱스
--
-- 근거: SPEC.md §5 (데이터 모델), §3.2 (신규·수정·무변경 판정), §7.1 (색인)
-- 적용: psql "$DATABASE_URL" -f db/migrations/0001_init.sql
--
-- 규약 (팀 간 계약 — 변경 금지)
--   * raw_documents.id / programs.id : bigint GENERATED ALWAYS AS IDENTITY
--   * profiles.id                    : uuid (0003_privacy.sql)
--   * 임베딩 차원                     : vector(1024)
--   * 행정구역 코드                   : 시도 2자리 / 시군구 5자리 text (shared/regions.json)
--   * 열거형은 enum 타입이 아니라 text + CHECK 로 둔다.
--     PostgREST/수집기에서 캐스팅이 필요 없고, 값 추가가 ALTER TYPE 없이 가능하다.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 확장
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS vector;   -- pgvector: vector(1024) + HNSW (SPEC §4)


-- -----------------------------------------------------------------------------
-- 공통 도메인 검증 헬퍼
--   CHECK 제약에는 서브쿼리를 직접 쓸 수 없어 IMMUTABLE 함수로 감싼다.
-- -----------------------------------------------------------------------------

-- 행정구역 코드 배열 검증: 각 원소가 2자리(시도) 또는 5자리(시군구) 숫자여야 한다.
-- SPEC §5: "`&&`는 원소 '동등' 비교이므로 양쪽이 같은 자리수 체계를 써야만 매칭된다".
-- 3자리·6자리 코드가 섞여 들어오면 조용히 매칭 0건이 되므로 적재 시점에 막는다.
-- 빈 배열도 거부한다 — NULL(=무관, 통과)과 달리 '{}' && ARRAY[...] 는 항상 false 라
-- 전원 탈락시키는 파서 버그가 된다.
CREATE OR REPLACE FUNCTION is_region_code_array(p_codes text[])
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT p_codes IS NULL
      OR ( cardinality(p_codes) > 0
           AND NOT EXISTS (
             SELECT 1 FROM unnest(p_codes) AS c WHERE c !~ '^[0-9]{2}([0-9]{3})?$'
           ) );
$$;

COMMENT ON FUNCTION is_region_code_array(text[]) IS
  'eligibility_rules.regions / 질의 파라미터용 행정구역 코드 배열 검증 (2자리 시도 | 5자리 시군구, 빈 배열 불가). SPEC §5';

-- 비어 있지 않은 배열(또는 NULL) 검증. NULL = 무관, '{}' = 파서 버그.
CREATE OR REPLACE FUNCTION is_null_or_nonempty(p_arr text[])
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT p_arr IS NULL OR cardinality(p_arr) > 0;
$$;

COMMENT ON FUNCTION is_null_or_nonempty(text[]) IS
  'NULL(=조건 없음) 은 허용하되 빈 배열은 거부한다. 빈 배열은 전원 탈락을 유발하는 조용한 파서 버그. SPEC §7.3';


-- -----------------------------------------------------------------------------
-- raw_documents — 수집 원문 (append-only)
--   수정분도 덮어쓰지 않고 새 행으로 쌓아 그 자체가 버전 이력이 된다 (SPEC §3.2)
-- -----------------------------------------------------------------------------
CREATE TABLE raw_documents (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  external_id   text        NOT NULL,
  source_key    text        NOT NULL,
  source_url    text,
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  content_hash  text        NOT NULL,
  raw_body      text        NOT NULL
);

COMMENT ON TABLE  raw_documents IS
  '수집 원문. append-only — 수정분도 새 행으로 쌓아 버전 이력이 된다. 별도 버전 테이블 없음. SPEC §3.2';
COMMENT ON COLUMN raw_documents.external_id IS
  '''source_key:원본고유번호''. 동일성 판정 키. source_url 은 쿼리 파라미터/세션 토큰 때문에 키로 쓰지 않는다. 원본 고유번호가 없는 T3 크롤링 소스는 sha1(issuer||title). SPEC §3.2';
COMMENT ON COLUMN raw_documents.source_key IS
  '소스 식별자 (예: bokjiro, bizinfo, finlife). SPEC §3.3';
COMMENT ON COLUMN raw_documents.content_hash IS
  '정규화한 비교 대상 필드(제목·본문·기간·금액)만으로 계산. 조회수·응답생성시각 등 매 호출 바뀌는 필드를 넣으면 전 건이 매일 "수정"으로 판정돼 증분 수집의 이점이 통째로 사라진다. SPEC §3.2';
COMMENT ON COLUMN raw_documents.raw_body IS
  '수집 응답 원문(JSON/HTML). TOAST 로 압축 저장된다.';

-- SPEC §5 명시 인덱스. "같은 external_id 의 최신 버전"과 변경 이력 조회를 동시에 받는다.
CREATE INDEX raw_documents_external_id_fetched_at_idx
  ON raw_documents (external_id, fetched_at DESC);


-- -----------------------------------------------------------------------------
-- programs — 정규화된 프로그램 (최신 상태만)
--   수정 시 UPDATE, id 유지. 새로 만들면 상세 URL 이 깨지고 알림이 중복 발송된다 (SPEC §3.2)
-- -----------------------------------------------------------------------------
CREATE TABLE programs (
  id                   bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  external_id          text        NOT NULL UNIQUE,
  raw_document_id      bigint      REFERENCES raw_documents (id) ON DELETE SET NULL,

  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_changed_at      timestamptz NOT NULL DEFAULT now(),

  title                text        NOT NULL,
  body_text            text,
  summary              text,
  apply_steps          jsonb,

  form                 text        CHECK (form IN ('subsidy','loan','tax','product','law')),
  issuer               text,
  issuer_level         text        CHECK (issuer_level IN ('central','metro','local')),

  benefit_amount_text  text,
  benefit_amount_min   bigint      CHECK (benefit_amount_min >= 0),
  benefit_amount_max   bigint      CHECK (benefit_amount_max >= 0),

  apply_url            text,
  apply_method         text,

  starts_at            date,
  ends_at              date,
  is_always_open       boolean     NOT NULL DEFAULT false,

  source_url           text,
  fetched_at           timestamptz NOT NULL DEFAULT now(),

  status               text        NOT NULL DEFAULT 'active'
                                   CHECK (status IN ('active','expired','needs_review')),

  CONSTRAINT programs_amount_range_chk
    CHECK (benefit_amount_min IS NULL OR benefit_amount_max IS NULL
           OR benefit_amount_min <= benefit_amount_max),
  CONSTRAINT programs_period_chk
    CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at <= ends_at)
);

COMMENT ON TABLE  programs IS
  '정규화된 프로그램(공고·상품·법령) 최신 상태. 수정 시 UPDATE 하고 id 를 유지한다. SPEC §5';
COMMENT ON COLUMN programs.external_id IS
  'upsert 대상 키. raw_documents.external_id 와 같은 값. ON CONFLICT (external_id) DO UPDATE 로 적재한다.';
COMMENT ON COLUMN programs.raw_document_id IS
  '현재 반영된 원문 버전. 같은 external_id 의 raw_documents 중 하나를 가리킨다.';
COMMENT ON COLUMN programs.body_text IS
  '임베딩 입력 원본(자격요건 문단 포함). title + summary + body_text 를 청킹해 색인한다. SPEC §7.1';
COMMENT ON COLUMN programs.summary IS
  '한 줄 요약 40자 이내. 수집 배치에서 LLM 이 신규·수정 시 1회 생성. 요청 경로에 LLM 없음. SPEC §7.5';
COMMENT ON COLUMN programs.apply_steps IS
  '신청 절차 3단계. jsonb 배열 형식: ["...","...","..."]. 배치에서 LLM 생성. SPEC §7.5';
COMMENT ON COLUMN programs.form IS
  'subsidy | loan | tax | product | law. 결과 화면 탭 전용 — 검색 전 필터가 아니라 결과를 본 뒤 좁히는 용도. SPEC §5';
COMMENT ON COLUMN programs.issuer_level IS
  'central | metro | local. §7.4 지역_근접성 스코어(기초 > 광역 > 전국)에 쓴다.';
COMMENT ON COLUMN programs.benefit_amount_min IS
  '지원금액 하한(원). §7.4 금액_규모 스코어(log 정규화)에 쓴다. 카드에 렌더하는 문구는 benefit_amount_text.';
COMMENT ON COLUMN programs.ends_at IS
  '마감일(date, 마감일 당일까지 유효). match_programs 는 (now() AT TIME ZONE ''Asia/Seoul'')::date 와 비교한다 — 0002_match.sql 헤더 참고. NULL = 마감 없음.';
COMMENT ON COLUMN programs.is_always_open IS
  '상시 공고. 마감일이 없어 자동 만료되지 않으므로 주 1회 전량 대조로만 회수된다. SPEC §3.2';
COMMENT ON COLUMN programs.status IS
  'active | expired | needs_review. match_programs 는 active 만 본다. 원본에서 사라진 건은 행을 지우지 않고 expired 로 전환하며, 그때 program_embeddings 행은 삭제된다(트리거). SPEC §3.2 / §5';

-- match_programs 의 자격 스캔 진입점 (SPEC §7.3).
-- status='active' 로 좁히고 ends_at 범위를 걸러낸다.
CREATE INDEX programs_status_ends_at_idx ON programs (status, ends_at);

-- 배치 재적재 시 "무엇이 언제 바뀌었나" 조회 및 알림용.
CREATE INDEX programs_last_changed_at_idx ON programs (last_changed_at DESC);
-- 원문 버전 역참조 (raw_documents 정리 시).
CREATE INDEX programs_raw_document_id_idx ON programs (raw_document_id);


-- -----------------------------------------------------------------------------
-- eligibility_rules — ① 정형 자격요건
--   프로그램당 정확히 1행. §7.3 eligible 의 JOIN 이 중복 행을 만들지 않는 전제 (SPEC §5)
--   모든 필드에서 NULL = 조건 없음 = 통과. "누락이 오탐보다 비싸다" (SPEC §7.3)
-- -----------------------------------------------------------------------------
CREATE TABLE eligibility_rules (
  program_id        bigint  PRIMARY KEY REFERENCES programs (id) ON DELETE CASCADE,

  age_min           smallint CHECK (age_min BETWEEN 0 AND 120),
  age_max           smallint CHECK (age_max BETWEEN 0 AND 120),
  gender            text     CHECK (gender IN ('M','F')),
  regions           text[]   CHECK (is_region_code_array(regions)),
  occupations       text[]   CHECK (is_null_or_nonempty(occupations)),
  income_decile_max smallint CHECK (income_decile_max BETWEEN 1 AND 10),

  extra_conditions  jsonb,
  parse_method      text     CHECK (parse_method IN ('regex','llm','mixed')),
  parse_evidence    jsonb,
  confidence        real     CHECK (confidence >= 0 AND confidence <= 1),

  CONSTRAINT eligibility_rules_age_range_chk
    CHECK (age_min IS NULL OR age_max IS NULL OR age_min <= age_max)
);

COMMENT ON TABLE  eligibility_rules IS
  '정형 자격요건. 프로그램당 정확히 1행(트리거로 보장). 모든 필드 NULL = 조건 없음 = 통과. SPEC §5 / §7.3';
COMMENT ON COLUMN eligibility_rules.age_min IS
  '만 나이 하한. NULL = 무관. "미만"은 파서가 -1 해서 age_max 로 넣는다. SPEC §6.1';
COMMENT ON COLUMN eligibility_rules.gender IS
  'NULL = 무관 | ''M'' | ''F''. 사용자가 ''선택 안 함''(NULL)이면 성별 조건 프로그램도 통과시킨다. SPEC §5 입력 필드 정의';
COMMENT ON COLUMN eligibility_rules.regions IS
  '행정구역 코드 배열. NULL = 전국. 시도 2자리 / 시군구 5자리로 통일 저장 (shared/regions.json). 질의는 [시도2, 시군구5] 두 값을 && 로 대조하므로 자리수 체계가 어긋나면 매칭되지 않는다. 빈 배열 금지. SPEC §5';
COMMENT ON COLUMN eligibility_rules.occupations IS
  'shared/occupations.json 의 code 배열 (예: {self_employed,farmer_fisher}). NULL = 무관. 빈 배열 금지.';
COMMENT ON COLUMN eligibility_rules.income_decile_max IS
  '소득분위 상한 1..10. NULL = 무관. 중위소득 % 는 shared/midincome_to_decile.json 으로 환산해 넣는다. SPEC §6.1';
COMMENT ON COLUMN eligibility_rules.extra_conditions IS
  '무주택·거주기간 등 정형화 실패분. 표시 전용 — 필터링에 쓰지 않는다. 자동 판정을 포기하는 대신 잘못된 탈락을 만들지 않는다. SPEC §6.3';
COMMENT ON COLUMN eligibility_rules.parse_method IS
  'regex | llm | mixed. 오탐 발생 시 어느 쪽이 문제인지 사후 분리하기 위한 기록. SPEC §6.2';
COMMENT ON COLUMN eligibility_rules.parse_evidence IS
  '필드별 매칭된 원문 구간. 예: {"age": {"span": "만 19~34세", "offset": 412}}. 추출 근거 추적용. SPEC §1 차별점 2';
COMMENT ON COLUMN eligibility_rules.confidence IS
  '0..1 추출 신뢰도.';


-- -----------------------------------------------------------------------------
-- program_embeddings — ② 벡터 인덱스
--   긴 본문은 청크별 행. 질의 시 프로그램 단위 MAX(sim) 집계 (SPEC §7.1)
-- -----------------------------------------------------------------------------
CREATE TABLE program_embeddings (
  program_id  bigint        NOT NULL REFERENCES programs (id) ON DELETE CASCADE,
  chunk_idx   int           NOT NULL DEFAULT 0 CHECK (chunk_idx >= 0),
  embedding   vector(1024)  NOT NULL,
  embedded_at timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (program_id, chunk_idx)
);

COMMENT ON TABLE  program_embeddings IS
  '청크 단위 임베딩. 벡터를 max/mean-pooling 으로 합치지 않는다 — 좌표를 섞으면 코사인 유사도가 왜곡되고 "한 문단이 강하게 일치"하는 신호가 희석된다. 질의 시 프로그램 단위 MAX 로 집계. SPEC §7.1';
COMMENT ON COLUMN program_embeddings.chunk_idx IS
  '0부터. 짧은 문서는 0 하나. 재임베딩 시 해당 program_id 청크 전체 삭제 후 재삽입 — 청크 수가 줄어도 잔여 행이 남지 않게. SPEC §5';
COMMENT ON COLUMN program_embeddings.embedding IS
  'vector(1024). 팀 간 고정 계약 — 모델 교체 시에도 1024 차원으로 맞추거나 마이그레이션을 새로 낸다. 코사인 거리(<=>) 로 검색한다.';

-- SPEC §5 명시 인덱스. 코사인 거리(<=>) top-k 용.
-- 주의: HNSW top-k 는 자격 필터 '이전에' 잘린다(사후 필터 구조). 자격 통과분이 top-k 안에
-- 적으면 교집합이 실제보다 작게 나온다 — §7.7 1단계(k 200→500) 가 그 대응이고,
-- 그래도 부족하면 pgvector 0.8+ 의 hnsw.iterative_scan 을 검토한다. SPEC §7.3 주석
CREATE INDEX program_embeddings_embedding_hnsw_idx
  ON program_embeddings USING hnsw (embedding vector_cosine_ops);


-- -----------------------------------------------------------------------------
-- 불변식 트리거
-- -----------------------------------------------------------------------------

-- (1) programs 1행 : eligibility_rules 1행.
--     SPEC §7.3 의 eligible 은 INNER JOIN 이라, 규칙 행이 없는 프로그램은 결과에서
--     조용히 사라진다. "누락이 오탐보다 비싸다"(§7.3) 는 원칙과 정면으로 충돌하므로
--     프로그램 insert 시 전 필드 NULL(= 조건 없음 = 통과) 행을 자동 생성해 전제를 보장한다.
--     파서는 이 행을 UPDATE 하거나 ON CONFLICT (program_id) DO UPDATE 로 upsert 하면 된다.
--     자격요건이 아예 없는 소스(금감원 금융상품 등)는 이 기본 행 그대로 두면 항상 통과한다 (SPEC §10).
CREATE OR REPLACE FUNCTION programs_ensure_eligibility_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public.eligibility_rules (program_id)
  VALUES (NEW.id)
  ON CONFLICT (program_id) DO NOTHING;
  RETURN NULL;
END;
$$;

CREATE TRIGGER programs_ensure_eligibility_row_trg
  AFTER INSERT ON programs
  FOR EACH ROW EXECUTE FUNCTION programs_ensure_eligibility_row();

COMMENT ON FUNCTION programs_ensure_eligibility_row() IS
  'programs insert 시 전 필드 NULL 인 eligibility_rules 행을 만들어 §7.3 eligible INNER JOIN 의 1:1 전제를 보장한다.';


-- (2) status → 'expired' 전환 시 임베딩 행 삭제.
--     만료 건이 벡터 top-k 슬롯을 차지하면 유효 결과가 밀려난다. SPEC §3.2 / §5
CREATE OR REPLACE FUNCTION programs_drop_embeddings_on_expire()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  DELETE FROM public.program_embeddings WHERE program_id = NEW.id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER programs_drop_embeddings_on_expire_trg
  AFTER UPDATE OF status ON programs
  FOR EACH ROW
  WHEN (NEW.status = 'expired' AND OLD.status IS DISTINCT FROM 'expired')
  EXECUTE FUNCTION programs_drop_embeddings_on_expire();

COMMENT ON FUNCTION programs_drop_embeddings_on_expire() IS
  'expired 전환 시 해당 프로그램의 임베딩 청크를 삭제한다. 만료 건이 벡터 top-k 슬롯을 점유하지 않게. SPEC §5';


-- -----------------------------------------------------------------------------
-- 접근 제어 — RLS deny-all + 서버(service_role) 전용
--   Supabase 는 public 스키마를 PostgREST 로 노출하고 anon 키는 브라우저에 내려간다.
--   RLS 를 끄면 anon 키만으로 전량 조회가 가능해지므로, 정책 없이 RLS 만 켜 전부 거부한다.
--   service_role 은 BYPASSRLS 이므로 서버 경로는 영향 없다. 근거는 db/README.md 참고.
-- -----------------------------------------------------------------------------
ALTER TABLE raw_documents      ENABLE ROW LEVEL SECURITY;
ALTER TABLE programs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE eligibility_rules  ENABLE ROW LEVEL SECURITY;
ALTER TABLE program_embeddings ENABLE ROW LEVEL SECURITY;

-- 정책을 하나도 만들지 않는다 = 비-BYPASSRLS 롤에게는 전부 거부.

-- 테이블 권한 자체도 회수한다 (다층 방어). Supabase 가 아닌 환경에서는 롤이 없으므로 건너뛴다.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'REVOKE ALL ON TABLE raw_documents, programs, eligibility_rules, program_embeddings FROM %I', r);
    END IF;
  END LOOP;
END;
$$;

COMMIT;
