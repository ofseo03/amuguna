-- 결과 화면 정렬: match_program_page() 가 정렬 축을 받아 순서를 다시 매긴다.
--
-- 0014 의 "결과 안에서 찾기"(낱말 배열)를 걷어내고 그 자리에 축 하나를 받는다. 결과 화면에서
-- 사람이 고르고 싶은 건 대개 "무슨 말이 들어 있나"가 아니라 "새 공고부터 보자" 같은 한 가지
-- 축이었는데, 낱말을 치게 하면 무엇을 칠지부터 정해야 하고 오타 하나가 순서를 통째로 바꿨다.
--
--   'relevance' (기본) — §7.4 스코어 그대로. 0013 과 조금도 다르지 않다.
--   'newest'          — 공고일이 늦은 것부터
--   'oldest'          — 공고일이 이른 것부터
--
-- **공고일 = COALESCE(starts_at, fetched_at::date).** `starts_at` 은 공고문이 말하는 접수
-- 시작일이라 "언제 나온 공고인가"에 가장 가깝다. 상시 접수처럼 시작일이 없는 건은 우리가 그
-- 공고를 처음 본 날로 대신한다 — 정확한 게시일은 아니지만, 날짜가 없어 전부 같은 자리에 몰리는
-- 것보다 낫다.
--
-- **정렬 키를 늘리지 않는다.** 웹은 keyset 커서 (sort_score, id) 로만 페이지를 넘기고 커서는
-- 0~1 만 받는다. 그래서 날짜도 같은 sort_score 안에 접어 넣어 `ORDER BY sort_score DESC, id ASC`
-- 한 줄이 세 축을 모두 처리한다 — 페이지 커서·건너뛰기(p_offset)·웹 캐시가 축과 무관하게 그대로
-- 동작한다.
--
-- 후보 집합은 건드리지 않는다. `match_programs()` 도 자격 조건도 그대로이고 총 건수·탭 건수도
-- 같다 — 바뀌는 건 ORDER BY 뿐이다.
--
-- 점수 공식은 `web/src/lib/result-sort.ts` 와 **완전히 같아야 한다** — 데모 모드는 TypeScript 로,
-- DB 모드는 이 함수로 같은 순서를 내야 두 모드가 같은 화면이 된다.
BEGIN;

-- **먼저 옛 오버로드를 전부 지운다 — 이 파일 하나만 부어도 되게.**
--
-- 새 판은 마지막 두 인자에 DEFAULT 가 있어 14·15·16인자 호출을 모두 받는다. 그래서 옛 판이
-- 하나라도 남으면 그 인자 수의 호출이 통째로 `is not unique` 로 죽는다 — 날짜 정렬만이 아니라
-- **정확도순 기본 화면까지** 함께 죽는다는 뜻이다. 운영 DB 가 0010·0013·0014 중 어디에 서
-- 있는지는 파일이 알 수 없으므로, 셋 다 지우고 시작한다. `migrate-production` 워크플로가
-- 이 파일만 입력으로 받아도 안전한 상태로 수렴해야 한다.
--
--   0010 — 14인자 (p_offset·p_sort 없음)
--   0013 — 15인자 (p_offset 까지)
--   0014 — 16인자, 마지막이 낱말 배열(text[]) — 새 판과 자리가 같고 타입만 다르다
--
-- 셋 다 IF EXISTS 라 재적용은 무해하다 (CREATE OR REPLACE 와 함께 멱등이다).
DROP FUNCTION IF EXISTS public.match_program_page(
  integer, text, text[], text, integer, integer, vector, integer, boolean, text,
  double precision, bigint, integer, integer
);

DROP FUNCTION IF EXISTS public.match_program_page(
  integer, text, text[], text, integer, integer, vector, integer, boolean, text,
  double precision, bigint, integer, integer, integer
);

DROP FUNCTION IF EXISTS public.match_program_page(
  integer, text, text[], text, integer, integer, vector, integer, boolean, text,
  double precision, bigint, integer, integer, integer, text[]
);

CREATE OR REPLACE FUNCTION public.match_program_page(
  p_age integer, p_gender text, p_region_codes text[], p_occupation text,
  p_income_decile integer, p_median_income_percent integer,
  p_query_embedding vector(1024), p_topk integer DEFAULT 200,
  p_has_query boolean DEFAULT false, p_form text DEFAULT NULL,
  p_after_score double precision DEFAULT NULL, p_after_id bigint DEFAULT NULL,
  p_limit integer DEFAULT 20, p_violations integer DEFAULT 0,
  p_offset integer DEFAULT 0,
  -- 결과 화면 정렬 축. 'newest' / 'oldest' 외의 값(NULL 포함)은 §7.4 스코어 순서 그대로다.
  p_sort text DEFAULT 'relevance'
)
RETURNS TABLE (program_id bigint, sim real, violations integer, sort_score double precision)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH candidates AS (
    SELECT p.id, p.form, p.benefit_amount_min, p.benefit_amount_max, p.ends_at, p.is_always_open,
      -- 공고일의 두 재료. date 컬럼과 timestamptz 를 섞지 않도록 수집 시각도 KST 달력 날짜로 읽는다.
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
      (CASE WHEN p_has_query THEN
        0.30 * GREATEST(0.0, LEAST(1.0, COALESCE(sim, 0.0)::double precision)) +
        0.25 * specificity + 0.20 * region_score + 0.15 * amount_score + 0.10 * deadline_score
      ELSE
        (0.25 * specificity + 0.20 * region_score + 0.15 * amount_score + 0.10 * deadline_score) / 0.70
      END) AS base_score,
      -- 공고일을 0~1 로 편다. 1970-01-01 부터 40000일(약 2079년)이 창이고, 하루의 간격은
      -- 1/40000 = 0.000025 로 일정하다. 창을 벗어난 날짜는 양 끝에 붙는다.
      GREATEST(0.0, LEAST(1.0, (
        COALESCE(starts_at, (fetched_at AT TIME ZONE 'Asia/Seoul')::date, DATE '1970-01-01')
          - DATE '1970-01-01'
      )::double precision / 40000.0)) AS recency
    FROM parts
  ), ranked AS (
    -- 0.99999 : 0.00001 은 "날짜가 항상 먼저" 를 정렬 키 하나로 표현한 것이다. 하루 차이가 만드는
    -- 0.99999 * 0.000025 = 0.0000249975 가 §7.4 스코어의 최대 차이 0.00001 * 1 보다 크므로,
    -- §7.4 스코어는 **같은 날짜일 때만** 순서를 정한다. 두 항 모두 0~1 이라 합도 0~1 이고
    -- keyset 커서(0~1 검증)가 그대로 유효하다.
    SELECT id, sim, violations,
      round((CASE
        WHEN p_sort = 'newest' THEN 0.99999 * recency + 0.00001 * base_score
        WHEN p_sort = 'oldest' THEN 0.99999 * (1.0 - recency) + 0.00001 * base_score
        ELSE base_score
      END)::numeric, 12)::double precision AS sort_score
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
