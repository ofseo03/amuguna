-- Apply hard eligibility rules before ranking programs by embedding similarity.
BEGIN;

CREATE OR REPLACE FUNCTION public.match_programs(
  p_age integer, p_gender text, p_region_codes text[], p_occupation text,
  p_income_decile integer, p_median_income_percent integer,
  p_qvec vector(1024), p_topk integer
)
RETURNS TABLE (program_id bigint, sim real, violations integer, violated_field text)
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  WITH flags AS MATERIALIZED (
    SELECT p.id AS cand_id,
      CASE WHEN (e.age_min IS NULL OR p_age >= e.age_min)
             AND (e.age_max IS NULL OR p_age <= e.age_max) THEN 0 ELSE 1 END AS v_age,
      CASE WHEN e.gender IS NULL OR p_gender IS NULL OR e.gender = p_gender THEN 0 ELSE 1 END AS v_gender,
      CASE WHEN e.regions IS NULL OR e.regions && p_region_codes THEN 0 ELSE 1 END AS v_region,
      CASE WHEN e.occupations IS NULL OR p_occupation = ANY(e.occupations) THEN 0 ELSE 1 END AS v_occupation,
      CASE WHEN (e.income_decile_max IS NULL OR p_income_decile IS NULL
                   OR p_income_decile <= e.income_decile_max)
              AND (e.median_income_percent_max IS NULL OR p_median_income_percent IS NULL
                   OR p_median_income_percent <= e.median_income_percent_max)
        THEN 0 ELSE 1 END AS v_income
    FROM public.programs AS p
    JOIN public.eligibility_rules AS e ON e.program_id = p.id
    WHERE p.status = 'active'
      AND (p.starts_at IS NULL OR p.starts_at <= (now() AT TIME ZONE 'Asia/Seoul')::date)
      AND (p.ends_at IS NULL OR p.ends_at >= (now() AT TIME ZONE 'Asia/Seoul')::date)
  ), candidates AS MATERIALIZED (
    SELECT f.cand_id,
      f.v_age + f.v_gender + f.v_region + f.v_occupation + f.v_income AS n_violations,
      CASE WHEN f.v_age = 1 THEN 'age'
           WHEN f.v_gender = 1 THEN 'gender'
           WHEN f.v_region = 1 THEN 'region'
           WHEN f.v_occupation = 1 THEN 'occupation'
           WHEN f.v_income = 1 THEN 'income'
      END AS first_violated
    FROM flags AS f
    WHERE f.v_age + f.v_gender + f.v_region + f.v_occupation + f.v_income <= 1
  ), vector_scores AS (
    -- ponytail: exact eligible-first scan; use iterative pgvector filtering only if measured latency requires it.
    SELECT c.cand_id, (1 - MIN(pe.embedding <=> p_qvec))::real AS max_sim
    FROM candidates AS c
    JOIN public.program_embeddings AS pe ON pe.program_id = c.cand_id
    WHERE p_qvec IS NOT NULL
      AND c.n_violations = 0
    GROUP BY c.cand_id
    ORDER BY max_sim DESC, c.cand_id
    LIMIT LEAST(GREATEST(COALESCE(p_topk, 200), 1), 5000)
  )
  SELECT c.cand_id, NULL::real, c.n_violations, c.first_violated
  FROM candidates AS c
  WHERE p_qvec IS NULL

  UNION ALL

  SELECT v.cand_id, v.max_sim, 0, NULL::text
  FROM vector_scores AS v;
$$;

COMMENT ON FUNCTION public.match_programs(integer, text, text[], text, integer, integer, vector, integer) IS
  'SQL 자격조건을 먼저 적용한 뒤 프로그램별 최대 임베딩 유사도로 후보를 고르는 서버 전용 RPC.';

REVOKE ALL ON FUNCTION public.match_programs(integer, text, text[], text, integer, integer, vector, integer) FROM PUBLIC;
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.match_programs(integer, text, text[], text, integer, integer, vector, integer) FROM %I', r
      );
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.match_programs(integer, text, text[], text, integer, integer, vector, integer) TO service_role;
  END IF;
END;
$$;

COMMIT;
