-- Treat the onboarding `other` occupation as unknown, not as a hard mismatch.
-- The 8-argument income-axis wrapper from 0006 calls this 7-argument base RPC,
-- so redefining the base function updates both code paths.
BEGIN;

CREATE OR REPLACE FUNCTION match_programs(
  p_age            int,
  p_gender         text,
  p_region_codes   text[],
  p_occupation     text,
  p_income_decile  int,
  p_qvec           vector(1024) DEFAULT NULL,
  p_topk           int          DEFAULT 200
)
RETURNS TABLE (
  program_id     bigint,
  sim            real,
  violations     int,
  violated_field text
)
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_topk int := LEAST(GREATEST(COALESCE(p_topk, 200), 1), 5000);
BEGIN
  IF p_qvec IS NULL THEN
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
              OR p_occupation = 'other'
              OR p_occupation = ANY (e.occupations)             THEN 0 ELSE 1 END AS v_occupation,
        CASE WHEN  e.income_decile_max IS NULL
              OR p_income_decile <= e.income_decile_max         THEN 0 ELSE 1 END AS v_income
      FROM programs p
      JOIN eligibility_rules e ON e.program_id = p.id
      WHERE p.status = 'active'
        AND (p.starts_at IS NULL OR p.starts_at <= (now() AT TIME ZONE 'Asia/Seoul')::date)
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
    PERFORM set_config('hnsw.ef_search', GREATEST(v_topk, 40)::text, true);

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
              OR p_occupation = 'other'
              OR p_occupation = ANY (e.occupations)             THEN 0 ELSE 1 END AS v_occupation,
        CASE WHEN  e.income_decile_max IS NULL
              OR p_income_decile <= e.income_decile_max         THEN 0 ELSE 1 END AS v_income
      FROM programs p
      JOIN eligibility_rules e ON e.program_id = p.id
      WHERE p.status = 'active'
        AND (p.starts_at IS NULL OR p.starts_at <= (now() AT TIME ZONE 'Asia/Seoul')::date)
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
    vec_topk AS (
      SELECT pe.program_id AS pid,
             pe.embedding <=> p_qvec AS dist
      FROM program_embeddings pe
      ORDER BY pe.embedding <=> p_qvec
      LIMIT v_topk
    ),
    vec_by_program AS (
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
  '자격(SQL) ∩ 의도(pgvector) 교차 검증 + 근접 탈락. occupation=other는 미입력으로 보고 탈락시키지 않는다.';

REVOKE ALL ON FUNCTION match_programs(int, text, text[], text, int, vector, int) FROM PUBLIC;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION match_programs(int, text, text[], text, int, vector, int) FROM %I', r);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION match_programs(int, text, text[], text, int, vector, int) TO service_role';
  END IF;
END;
$$;

COMMIT;
