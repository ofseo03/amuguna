-- Query relevance uses only cosine similarity; date sorts retain composite tie scores.
BEGIN;

CREATE OR REPLACE FUNCTION public.match_program_page(
  p_age integer, p_gender text, p_region_codes text[], p_occupation text,
  p_income_decile integer, p_median_income_percent integer,
  p_query_embedding vector(1024), p_topk integer DEFAULT 200,
  p_has_query boolean DEFAULT false, p_form text DEFAULT NULL,
  p_after_score double precision DEFAULT NULL, p_after_id bigint DEFAULT NULL,
  p_limit integer DEFAULT 20, p_violations integer DEFAULT 0,
  p_offset integer DEFAULT 0,
  p_sort text DEFAULT 'relevance'
)
RETURNS TABLE (program_id bigint, sim real, violations integer, sort_score double precision)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH candidates AS (
    SELECT p.id, p.form, p.benefit_amount_min, p.benefit_amount_max, p.ends_at, p.is_always_open,
      p.starts_at, p.fetched_at,
      e.age_min, e.age_max, e.gender, e.regions, e.occupations,
      e.income_decile_max, e.median_income_percent_max,
      m.sim, m.violations, m.violated_field
    FROM public.match_programs(
      p_age, p_gender, p_region_codes, p_occupation, p_income_decile,
      p_median_income_percent, p_query_embedding, p_topk
    ) AS m
    JOIN public.programs AS p ON p.id = m.program_id
    JOIN public.eligibility_rules AS e ON e.program_id = p.id
    WHERE m.violations = p_violations
      AND (p_form IS NULL OR p.form = p_form)
  ), parts AS (
    SELECT c.*,
      (
        (CASE WHEN (c.age_min IS NOT NULL OR c.age_max IS NOT NULL) AND c.violated_field IS DISTINCT FROM 'age' THEN 1 ELSE 0 END) +
        (CASE WHEN c.gender IS NOT NULL AND p_gender IS NOT NULL AND c.gender = p_gender THEN 1 ELSE 0 END) +
        (CASE WHEN c.regions IS NOT NULL AND cardinality(c.regions) > 0 AND c.regions && p_region_codes THEN 1 ELSE 0 END) +
        (CASE WHEN c.occupations IS NOT NULL AND cardinality(c.occupations) > 0 AND c.occupations && ARRAY[p_occupation] THEN 1 ELSE 0 END) +
        (CASE WHEN (c.income_decile_max IS NOT NULL OR c.median_income_percent_max IS NOT NULL)
          AND NOT ((c.income_decile_max IS NOT NULL AND p_income_decile IS NULL) OR
            (c.median_income_percent_max IS NOT NULL AND p_median_income_percent IS NULL))
          AND c.violated_field IS DISTINCT FROM 'income' THEN 1 ELSE 0 END)
      )::double precision / 5.0 AS specificity,
      CASE
        WHEN c.regions IS NULL OR cardinality(c.regions) = 0 THEN 0.30
        WHEN EXISTS (SELECT 1 FROM unnest(c.regions) AS r WHERE char_length(r) = 5 AND r = ANY(p_region_codes)) THEN 1.0
        WHEN c.regions && p_region_codes THEN 0.65 ELSE 0.30
      END AS region_score,
      CASE WHEN COALESCE(c.benefit_amount_max, c.benefit_amount_min) IS NULL
          OR COALESCE(c.benefit_amount_max, c.benefit_amount_min) <= 0 THEN 0.35
        ELSE LEAST(1.0, GREATEST(0.0, ln(1.0 + COALESCE(c.benefit_amount_max, c.benefit_amount_min)::double precision) / ln(100000001.0)))
      END AS amount_score,
      CASE WHEN c.is_always_open OR c.ends_at IS NULL THEN 0.50
        WHEN c.ends_at < (now() AT TIME ZONE 'Asia/Seoul')::date THEN 0.0
        WHEN c.ends_at - (now() AT TIME ZONE 'Asia/Seoul')::date <= 7 THEN 1.0
        ELSE GREATEST(0.50, 1.0 - (((c.ends_at - (now() AT TIME ZONE 'Asia/Seoul')::date - 7)::double precision / 60.0) * 0.50))
      END AS deadline_score
    FROM candidates AS c
  ), scored AS (
    SELECT id, sim, violations,
      (CASE WHEN p_has_query AND p_query_embedding IS NOT NULL THEN
        0.30 * GREATEST(0.0, LEAST(1.0, COALESCE(sim, 0.0)::double precision)) +
        0.25 * specificity + 0.20 * region_score + 0.15 * amount_score + 0.10 * deadline_score
      ELSE
        (specificity + region_score + amount_score + deadline_score) / 4.0
      END) AS base_score,
      GREATEST(0.0, LEAST(1.0, (
        COALESCE(starts_at, (fetched_at AT TIME ZONE 'Asia/Seoul')::date, DATE '1970-01-01')
          - DATE '1970-01-01'
      )::double precision / 40000.0)) AS recency
    FROM parts
  ), ranked AS (
    SELECT id, sim, violations,
      round((CASE
        WHEN p_sort = 'newest' THEN 0.99999 * recency + 0.00001 * base_score
        WHEN p_sort = 'oldest' THEN 0.99999 * (1.0 - recency) + 0.00001 * base_score
        WHEN p_has_query AND p_query_embedding IS NOT NULL AND sim IS NOT NULL
          THEN (GREATEST(-1.0, LEAST(1.0, sim::double precision)) + 1.0) / 2.0
        ELSE base_score
      END)::numeric, 12)::double precision AS sort_score
    FROM scored
  )
  SELECT id, sim, violations, sort_score FROM ranked
  WHERE p_after_score IS NULL OR sort_score < p_after_score
    OR (sort_score = p_after_score AND id > p_after_id)
  ORDER BY sort_score DESC, id ASC
  OFFSET LEAST(GREATEST(COALESCE(p_offset, 0), 0), 1500)
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 21);
$$;

REVOKE ALL ON FUNCTION public.match_program_page(integer, text, text[], text, integer, integer, vector, integer, boolean, text, double precision, bigint, integer, integer, integer, text) FROM PUBLIC;
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.match_program_page(integer, text, text[], text, integer, integer, vector, integer, boolean, text, double precision, bigint, integer, integer, integer, text) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.match_program_page(integer, text, text[], text, integer, integer, vector, integer, boolean, text, double precision, bigint, integer, integer, integer, text) TO service_role;
  END IF;
END;
$$;

COMMIT;
