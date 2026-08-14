-- 소득분위와 기준중위소득 비율은 서로 환산하지 않고 같은 소득 축 안에서 독립 비교한다.
BEGIN;

ALTER TABLE eligibility_rules
  ADD COLUMN median_income_percent_max smallint
    CHECK (median_income_percent_max BETWEEN 0 AND 1000);

ALTER TABLE profiles
  ADD COLUMN median_income_percent smallint
    CHECK (median_income_percent BETWEEN 0 AND 10000);

COMMENT ON COLUMN eligibility_rules.median_income_percent_max IS
  '공고문의 기준중위소득 상한(%). 소득분위로 환산하지 않는다. NULL = 무관.';
COMMENT ON COLUMN eligibility_rules.income_decile_max IS
  '공고문에 명시된 소득분위 상한 1..10. 기준중위소득 비율을 환산해 넣지 않는다. NULL = 무관.';
COMMENT ON COLUMN profiles.median_income_percent IS
  '공식 가구원별 기준액으로 브라우저에서 계산한 정수 비율. 원 월소득은 전송·저장하지 않는다.';

-- 이 열을 도입하기 전 파서는 "기준 중위소득 150% 이하"의 숫자를
-- income_decile_max 에 저장했다. evidence 원문이 명확한 행만 옮긴다.
UPDATE eligibility_rules
SET
  median_income_percent_max = substring(
    parse_evidence -> 'income_decile_max' ->> 'text'
    FROM '(?:기준[[:space:]]*)?중위소득[[:space:]]*(1000|[0-9]{1,3})[[:space:]]*%[[:space:]]*(?:이하|이내|까지)'
  )::smallint,
  income_decile_max = NULL,
  parse_evidence = (parse_evidence - 'income_decile_max') || jsonb_build_object(
    'median_income_percent_max', parse_evidence -> 'income_decile_max'
  )
WHERE median_income_percent_max IS NULL
  AND parse_evidence -> 'income_decile_max' ->> 'text' ~
    '(?:기준[[:space:]]*)?중위소득[[:space:]]*(1000|[0-9]{1,3})[[:space:]]*%[[:space:]]*(?:이하|이내|까지)';

UPDATE eligibility_rules
SET
  median_income_percent_max = substring(
    parse_evidence -> 'income_decile_max' ->> 'text'
    FROM '(?:기준[[:space:]]*)?중위소득[[:space:]]*(1000|[1-9][0-9]{0,2})[[:space:]]*%[[:space:]]*미만'
  )::smallint - 1,
  income_decile_max = NULL,
  parse_evidence = (parse_evidence - 'income_decile_max') || jsonb_build_object(
    'median_income_percent_max', parse_evidence -> 'income_decile_max'
  )
WHERE median_income_percent_max IS NULL
  AND parse_evidence -> 'income_decile_max' ->> 'text' ~
    '(?:기준[[:space:]]*)?중위소득[[:space:]]*(1000|[1-9][0-9]{0,2})[[:space:]]*%[[:space:]]*미만';

-- 차상위·기초생활·의료급여는 분위와 동치가 아니다. 과거 추정치는 제거한다.
UPDATE eligibility_rules
SET
  income_decile_max = NULL,
  parse_evidence = parse_evidence - 'income_decile_max'
WHERE income_decile_max IS NOT NULL
  AND parse_evidence -> 'income_decile_max' ->> 'text' ~
    '(차상위|기초생활|의료급여)';

-- 기존 7인자 함수의 검증된 자격/벡터 결과에 기준중위소득 위반만 합성한다.
-- 기존 함수도 유지해 배포 전환 중인 호출을 깨지 않는다.
CREATE FUNCTION match_programs(
  p_age                    int,
  p_gender                 text,
  p_region_codes           text[],
  p_occupation             text,
  p_income_decile          int,
  p_median_income_percent  int,
  p_qvec                   vector(1024),
  p_topk                   int
)
RETURNS TABLE (
  program_id bigint,
  sim real,
  violations int,
  violated_field text
)
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  WITH base AS (
    SELECT *
    FROM public.match_programs(
      p_age,
      p_gender,
      p_region_codes,
      p_occupation,
      COALESCE(p_income_decile, 1),
      p_qvec,
      p_topk
    )
  ), adjusted AS (
    SELECT
      b.program_id,
      b.sim,
      b.violations + CASE
        WHEN e.median_income_percent_max IS NULL
          OR p_median_income_percent IS NULL
          OR p_median_income_percent <= e.median_income_percent_max
          OR b.violated_field = 'income'
        THEN 0 ELSE 1
      END AS violations,
      CASE
        WHEN b.violations = 0
          AND e.median_income_percent_max IS NOT NULL
          AND p_median_income_percent IS NOT NULL
          AND p_median_income_percent > e.median_income_percent_max
        THEN 'income'
        ELSE b.violated_field
      END AS violated_field
    FROM base b
    JOIN public.eligibility_rules e ON e.program_id = b.program_id
  )
  SELECT a.program_id, a.sim, a.violations, a.violated_field
  FROM adjusted a
  WHERE a.violations <= 1;
$$;

COMMENT ON FUNCTION match_programs(int, text, text[], text, int, int, vector, int) IS
  '소득분위와 기준중위소득 비율을 독립 비교하는 서버 전용 자격/의도 매칭 RPC.';

REVOKE ALL ON FUNCTION match_programs(int, text, text[], text, int, int, vector, int) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION match_programs(int, text, text[], text, int, int, vector, int) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION match_programs(int, text, text[], text, int, int, vector, int) FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION match_programs(int, text, text[], text, int, int, vector, int) TO service_role';
  END IF;
END;
$$;

COMMIT;
