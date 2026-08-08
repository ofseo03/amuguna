-- =============================================================================
-- amuguna — 0002_match.sql
-- 교차 검증 RPC: match_programs()
--
-- 근거
--   SPEC §7.3  교차 검증 — 집합 A(자격, SQL) ∩ 집합 B(의도, 벡터)
--   SPEC §7.6  근접 탈락 — 자격 조건 1개만 어긋난 프로그램. A 계산과 같은 스캔에서 나온다
--   SPEC §7.1  청크 단위 색인 → 프로그램 단위 MAX(sim) 집계
--   SPEC §7.7  빈 결과 완화 — 1단계(k 200→500)는 p_topk 로, 2단계(의도 해제)는 p_qvec=NULL 로 호출
--
-- 반환 한 벌에 A 와 근접 탈락이 함께 담긴다.
--   violations = 0 → 집합 A (자격 통과).            violated_field = NULL
--   violations = 1 → 근접 탈락 (§7.6).               violated_field = 어긋난 축 1개
--   violations ≥ 2 → 반환하지 않는다.
-- 애플리케이션이 violations 로 갈라 §7.4 스코어링·정렬·페이지네이션을 수행하고,
-- 근접 탈락은 상위 5건만 노출한다 (SQL 은 자르지 않는다).
--
-- 호출 규약: 서버 전용. service_role 로만 EXECUTE 가능하다 (하단 GRANT 참고).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- region_prefixes — profiles.region_code(단일) → match_programs 의 p_region_codes(배열)
--   SPEC §5: 질의 시 :region_prefixes = [시도 2자리, 시군구 5자리] 두 값.
--   웹/배치 어느 쪽에서도 같은 규칙을 쓰도록 DB 에 한 벌만 둔다.
--     region_prefixes('11620') → {11,11620}
--     region_prefixes('11')    → {11}
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION region_prefixes(p_region_code text)
RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
           WHEN p_region_code IS NULL THEN NULL
           WHEN p_region_code ~ '^[0-9]{5}$' THEN ARRAY[substr(p_region_code, 1, 2), p_region_code]
           WHEN p_region_code ~ '^[0-9]{2}$' THEN ARRAY[p_region_code]
           ELSE NULL
         END;
$$;

COMMENT ON FUNCTION region_prefixes(text) IS
  'profiles.region_code 를 match_programs 의 p_region_codes 로 변환한다. 5자리→{시도,시군구}, 2자리→{시도}, 그 외→NULL. SPEC §5';


-- -----------------------------------------------------------------------------
-- match_programs — 자격(A) ∩ 의도(B) + 근접 탈락
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION match_programs(
  p_age            int,
  p_gender         text,               -- 'M' | 'F' | NULL ('선택 안 함')
  p_region_codes   text[],             -- 예: {11,11620} — region_prefixes() 로 만든다
  p_occupation     text,               -- shared/occupations.json 의 code
  p_income_decile  int,                -- 1..10
  p_qvec           vector(1024) DEFAULT NULL,  -- NULL = 의도 입력 건너뜀 (§7.3 / §7.7 2단계)
  p_topk           int          DEFAULT 200    -- 청크 단위 top-k (§7.7 1단계에서 500)
)
RETURNS TABLE (
  program_id     bigint,
  sim            real,    -- 코사인 유사도(1 - 거리). p_qvec IS NULL 이면 NULL
  violations     int,     -- 0 = 자격 통과, 1 = 근접 탈락
  violated_field text     -- violations=1 일 때 'age'|'gender'|'region'|'occupation'|'income', 아니면 NULL
)
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- top-k 는 외부에서 그대로 들어오므로 상한을 둔다. 0/음수면 LIMIT 이 에러가 난다.
  v_topk int := LEAST(GREATEST(COALESCE(p_topk, 200), 1), 5000);
BEGIN
  IF p_qvec IS NULL THEN
    ---------------------------------------------------------------------------
    -- 의도 입력을 건너뛴 경로 (SPEC §7.3 결과 구성 "건너뜀" 행, §2 페르소나 P3)
    -- 자격 통과분 전체 + 근접 탈락. sim 은 NULL 이고 §7.4 에서 유사도 가중치는 0,
    -- 나머지 가중치를 정규화해 정렬한다.
    -- 결과가 수백~수천 건일 수 있으므로 애플리케이션에서 페이지네이션한다 (§8 성능).
    ---------------------------------------------------------------------------
    RETURN QUERY
    WITH flags AS (
      SELECT
        p.id AS cand_id,
        -- ── 5개 축 각각 CASE WHEN ... THEN 0 ELSE 1 (SPEC §7.6)
        --    NULL 규칙 = 조건 없음 = 통과 (SPEC §7.3)
        --    나이는 age_min/age_max 두 컬럼이지만 한 축으로 센다 (age_min<=age_max 를
        --    CHECK 로 보장하므로 둘이 동시에 어긋날 수 없다).
        CASE WHEN (e.age_min IS NULL OR p_age >= e.age_min)
              AND (e.age_max IS NULL OR p_age <= e.age_max)     THEN 0 ELSE 1 END AS v_age,
        -- p_gender NULL = '선택 안 함' → 성별 조건 프로그램도 통과 (SPEC §5 입력 필드 정의)
        CASE WHEN  e.gender IS NULL OR p_gender IS NULL
              OR e.gender = p_gender                            THEN 0 ELSE 1 END AS v_gender,
        -- regions NULL = 전국. && 는 원소 동등 비교 — 양쪽 다 2/5자리 체계 (SPEC §5)
        CASE WHEN  e.regions IS NULL
              OR e.regions && p_region_codes                    THEN 0 ELSE 1 END AS v_region,
        CASE WHEN  e.occupations IS NULL
              OR p_occupation = ANY (e.occupations)             THEN 0 ELSE 1 END AS v_occupation,
        CASE WHEN  e.income_decile_max IS NULL
              OR p_income_decile <= e.income_decile_max         THEN 0 ELSE 1 END AS v_income
      FROM programs p
      JOIN eligibility_rules e ON e.program_id = p.id
      WHERE p.status = 'active'
        -- 마감일 당일까지 유효. now() 대신 KST 기준 날짜와 비교한다 (0002 헤더 아래 주석 참고)
        AND (p.ends_at IS NULL OR p.ends_at >= (now() AT TIME ZONE 'Asia/Seoul')::date)
    ),
    candidates AS (
      SELECT
        f.cand_id,
        (f.v_age + f.v_gender + f.v_region + f.v_occupation + f.v_income) AS n_violations,
        CASE WHEN f.v_age        = 1 THEN 'age'
             WHEN f.v_gender     = 1 THEN 'gender'
             WHEN f.v_region     = 1 THEN 'region'
             WHEN f.v_occupation = 1 THEN 'occupation'
             WHEN f.v_income     = 1 THEN 'income'
        END AS first_violated
      FROM flags f
    )
    SELECT
      c.cand_id,
      NULL::real,
      c.n_violations,
      CASE WHEN c.n_violations = 1 THEN c.first_violated ELSE NULL END
    FROM candidates c
    WHERE c.n_violations <= 1;

  ELSE
    ---------------------------------------------------------------------------
    -- 의도 입력이 있는 경로: A ∩ B (SPEC §7.3)
    -- 청크 단위 top-k → 프로그램 단위 MAX(sim) 집계(§7.1) → 자격 집합과 INNER JOIN.
    -- 근접 탈락도 이 경로에서는 벡터 집합 안에서만 나온다 (찾는 것과 무관한 근접 탈락을
    -- 보여줄 이유가 없다).
    -- B − A(자격 미달)는 어느 경우에도 노출하지 않는다 — JOIN 이 그것을 보장한다.
    ---------------------------------------------------------------------------
    RETURN QUERY
    WITH flags AS (
      SELECT
        p.id AS cand_id,
        CASE WHEN (e.age_min IS NULL OR p_age >= e.age_min)
              AND (e.age_max IS NULL OR p_age <= e.age_max)     THEN 0 ELSE 1 END AS v_age,
        CASE WHEN  e.gender IS NULL OR p_gender IS NULL
              OR e.gender = p_gender                            THEN 0 ELSE 1 END AS v_gender,
        CASE WHEN  e.regions IS NULL
              OR e.regions && p_region_codes                    THEN 0 ELSE 1 END AS v_region,
        CASE WHEN  e.occupations IS NULL
              OR p_occupation = ANY (e.occupations)             THEN 0 ELSE 1 END AS v_occupation,
        CASE WHEN  e.income_decile_max IS NULL
              OR p_income_decile <= e.income_decile_max         THEN 0 ELSE 1 END AS v_income
      FROM programs p
      JOIN eligibility_rules e ON e.program_id = p.id
      WHERE p.status = 'active'
        AND (p.ends_at IS NULL OR p.ends_at >= (now() AT TIME ZONE 'Asia/Seoul')::date)
    ),
    candidates AS (
      SELECT
        f.cand_id,
        (f.v_age + f.v_gender + f.v_region + f.v_occupation + f.v_income) AS n_violations,
        CASE WHEN f.v_age        = 1 THEN 'age'
             WHEN f.v_gender     = 1 THEN 'gender'
             WHEN f.v_region     = 1 THEN 'region'
             WHEN f.v_occupation = 1 THEN 'occupation'
             WHEN f.v_income     = 1 THEN 'income'
        END AS first_violated
      FROM flags f
    ),
    vec_topk AS (                    -- 집합 B: 청크 단위 HNSW top-k (사후 필터 구조 — §7.3 주석)
                                     -- (CTE 명 similar 는 SQL 예약어라 못 쓴다)
      SELECT pe.program_id AS pid,
             pe.embedding <=> p_qvec AS dist
      FROM program_embeddings pe
      ORDER BY pe.embedding <=> p_qvec
      LIMIT v_topk
    ),
    vec_by_program AS (              -- 프로그램 단위 최대 유사도 (SPEC §7.1)
      SELECT s.pid, (1 - MIN(s.dist))::real AS max_sim
      FROM vec_topk s
      GROUP BY s.pid
    )
    SELECT
      c.cand_id,
      sbp.max_sim,
      c.n_violations,
      CASE WHEN c.n_violations = 1 THEN c.first_violated ELSE NULL END
    FROM candidates c
    JOIN vec_by_program sbp ON sbp.pid = c.cand_id
    WHERE c.n_violations <= 1;
  END IF;
END;
$$;

COMMENT ON FUNCTION match_programs(int, text, text[], text, int, vector, int) IS
  '자격(SQL) ∩ 의도(pgvector) 교차 검증 + 근접 탈락. SPEC §7.3 / §7.6. violations=0 이 집합 A, 1 이 근접 탈락(앱에서 상위 5건). p_qvec NULL 이면 자격 축만으로 동작하고 sim 은 NULL. 서버 전용 RPC.';


-- -----------------------------------------------------------------------------
-- 실행 권한 — 서버(service_role) 전용. 브라우저에 내려가는 anon 키로는 호출할 수 없다.
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION match_programs(int, text, text[], text, int, vector, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION region_prefixes(text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION match_programs(int, text, text[], text, int, vector, int) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION region_prefixes(text) TO service_role';
  END IF;
END;
$$;

COMMIT;
