-- 결과 내 검색 정렬: match_program_page() 가 낱말 배열을 받아 순서를 다시 매긴다.
--
-- 결과 화면에서 사람이 찾는 건 대개 "전세", "청년", "관악구" 같은 낱말이다. 그런데 순서는
-- §7.4 스코어 하나로만 정해져 있어서, 이미 눈앞에 있는 결과를 낱말 하나로 끌어올릴 방법이
-- 없었다 — 페이지를 넘겨 가며 눈으로 찾는 수밖에 없었다.
--
-- 의도 축(임베딩)을 한 번 더 거는 대신 **글자 대조**로 푼다. 왜 그 순서인지 화면에서 그대로
-- 확인되고, 질의 임베딩(외부 API, 최대 15초)을 정렬할 때마다 부르지 않아도 된다.
--
-- 후보 집합은 건드리지 않는다. `match_programs()` 도 자격 조건도 그대로이고 총 건수·탭 건수도
-- 같다 — 바뀌는 건 ORDER BY 뿐이다. 낱말에 걸리지 않은 공고는 아래로 내려갈 뿐 사라지지 않는다.
--
-- 낱말 쪼개기(NFC·소문자화·구두점 제거·두 글자 미만 제외)는 웹이 한다
-- (`web/src/lib/keyword-sort.ts` 의 `sortTokens`). 여기는 이미 정규화된 낱말을 받아 대조만 한다.
-- 점수 공식은 그 파일과 **완전히 같아야 한다** — 데모 모드는 TypeScript 로, DB 모드는 이 함수로
-- 같은 순서를 내야 두 모드가 같은 화면이 된다.
BEGIN;

-- 0013 의 15인자 오버로드는 지운다. p_keywords 에 DEFAULT 가 붙는 순간 15인자 호출이
-- 모호해지기 때문이다 (0013 이 14인자 판을 지운 것과 같은 이유). 재적용은 무해하다.
DROP FUNCTION IF EXISTS public.match_program_page(
  integer, text, text[], text, integer, integer, vector, integer, boolean, text,
  double precision, bigint, integer, integer, integer
);

CREATE OR REPLACE FUNCTION public.match_program_page(
  p_age integer, p_gender text, p_region_codes text[], p_occupation text,
  p_income_decile integer, p_median_income_percent integer,
  p_query_embedding vector(1024), p_topk integer DEFAULT 200,
  p_has_query boolean DEFAULT false, p_form text DEFAULT NULL,
  p_after_score double precision DEFAULT NULL, p_after_id bigint DEFAULT NULL,
  p_limit integer DEFAULT 20, p_violations integer DEFAULT 0,
  p_offset integer DEFAULT 0,
  -- 결과 내 검색 정렬용 낱말. NULL 또는 빈 배열이면 §7.4 스코어 순서 그대로다.
  p_keywords text[] DEFAULT NULL
)
RETURNS TABLE (program_id bigint, sim real, violations integer, sort_score double precision)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH candidates AS (
    SELECT p.id, p.form, p.benefit_amount_min, p.benefit_amount_max, p.ends_at, p.is_always_open,
      -- 결과 내 검색이 대조하는 네 자리. 카드에 실제로 보이는 글자만 본다 — 사용자가 화면에서
      -- 확인할 수 없는 본문으로 순서가 정해지면 왜 그 순서인지 설명할 길이 없다.
      lower(coalesce(p.title, '')) AS l_title,
      lower(coalesce(p.summary, '')) AS l_summary,
      lower(coalesce(p.issuer, '')) AS l_issuer,
      lower(coalesce(p.benefit_amount_text, '')) AS l_benefit,
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
      (CASE WHEN p_has_query THEN
        0.30 * GREATEST(0.0, LEAST(1.0, COALESCE(sim, 0.0)::double precision)) +
        0.25 * specificity + 0.20 * region_score + 0.15 * amount_score + 0.10 * deadline_score
      ELSE
        (0.25 * specificity + 0.20 * region_score + 0.15 * amount_score + 0.10 * deadline_score) / 0.70
      END) AS base_score,
      -- 낱말마다 "가장 앞자리에 걸린 점수" 하나만 세고(합산이 아니다) 낱말 수로 나눈다.
      -- 낱말 둘 중 하나만 제목에 있으면 0.5 — 전부 맞은 건이 일부만 맞은 건보다 항상 위다.
      CASE WHEN p_keywords IS NULL OR cardinality(p_keywords) = 0 THEN NULL::double precision
        ELSE round((
          SELECT COALESCE(sum(
            CASE
              WHEN strpos(parts.l_title, kw) > 0 THEN 1.00
              WHEN strpos(parts.l_summary, kw) > 0 THEN 0.60
              WHEN strpos(parts.l_issuer, kw) > 0 THEN 0.50
              WHEN strpos(parts.l_benefit, kw) > 0 THEN 0.35
              ELSE 0.0
            END
          ), 0.0) / cardinality(p_keywords)
          FROM unnest(p_keywords) AS kw
        )::numeric, 2)::double precision
      END AS keyword_score
    FROM parts
  ), ranked AS (
    -- 0.995 : 0.005 는 "검색어가 항상 먼저" 를 한 개의 정렬 키로 표현한 것이다. 검색어 점수는
    -- 소수 둘째 자리까지라 서로 다른 값의 최소 간격이 0.01 이고 0.995 * 0.01 = 0.00995 >
    -- 0.005 * 1 이므로, §7.4 스코어는 검색어 점수가 같을 때만 순서를 정한다. 두 항 모두 0~1 이라
    -- 합도 0~1 이고 keyset 커서(0~1 검증)가 그대로 유효하다.
    SELECT id, sim, violations,
      round((CASE WHEN keyword_score IS NULL THEN base_score
        ELSE 0.995 * keyword_score + 0.005 * base_score END)::numeric, 12)::double precision AS sort_score
    FROM scored
  )
  SELECT id, sim, violations, sort_score FROM ranked
  WHERE p_after_score IS NULL OR sort_score < p_after_score
    OR (sort_score = p_after_score AND id > p_after_id)
  ORDER BY sort_score DESC, id ASC
  -- 100 pages of 15 is the farthest a single jump may reach; the web clamps to the same bound.
  OFFSET LEAST(GREATEST(COALESCE(p_offset, 0), 0), 1500)
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 21);
$$;

REVOKE ALL ON FUNCTION public.match_program_page(integer, text, text[], text, integer, integer, vector, integer, boolean, text, double precision, bigint, integer, integer, integer, text[]) FROM PUBLIC;
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.match_program_page(integer, text, text[], text, integer, integer, vector, integer, boolean, text, double precision, bigint, integer, integer, integer, text[]) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.match_program_page(integer, text, text[], text, integer, integer, vector, integer, boolean, text, double precision, bigint, integer, integer, integer, text[]) TO service_role;
  END IF;
END;
$$;

COMMIT;
