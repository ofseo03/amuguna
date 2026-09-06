-- Run against a migrated test database with psql -v ON_ERROR_STOP=1.
-- All fixture changes, including isolation from existing programs, are rolled back.
BEGIN;
UPDATE public.programs SET status = 'expired' WHERE status <> 'expired';

DO $$
DECLARE
  a bigint;
  b bigint;
  c bigint;
  q vector(1024) := ('[1,' || repeat('0,', 1022) || '0]')::vector;
  ids bigint[];
  first_score double precision;
  today date := (now() AT TIME ZONE 'Asia/Seoul')::date;
BEGIN
  INSERT INTO programs (external_id, title, starts_at)
    VALUES ('test:query-a', 'Strong intent, general benefit', today) RETURNING id INTO a;
  INSERT INTO programs (external_id, title, starts_at, ends_at, benefit_amount_max)
    VALUES ('test:query-b', 'Weak intent, strong composite', today, today + 1, 100000000)
    RETURNING id INTO b;
  INSERT INTO programs (external_id, title, starts_at)
    VALUES ('test:query-c', 'Opposite intent, older benefit', today - 1) RETURNING id INTO c;
  UPDATE eligibility_rules SET age_min = 20, age_max = 40, gender = 'F',
    regions = ARRAY['11620'], occupations = ARRAY['employee_office'], income_decile_max = 5
    WHERE program_id = b;
  INSERT INTO program_embeddings (program_id, chunk_idx, embedding, provider) VALUES
    (a, 0, q, 'mock'),
    (b, 0, ('[0.2,0.9797958971132712,' || repeat('0,', 1021) || '0]')::vector, 'mock'),
    (c, 0, ('[-1,' || repeat('0,', 1022) || '0]')::vector, 'mock');

  SELECT array_agg(program_id ORDER BY sort_score DESC, program_id) INTO ids
  FROM match_program_page(28, 'F', ARRAY['11','11620'], 'employee_office', 3, NULL,
    q, 200, true);
  IF ids IS DISTINCT FROM ARRAY[a,b,c] THEN
    RAISE EXCEPTION 'Query relevance must follow cosine, including negative similarity: %', ids;
  END IF;

  SELECT sort_score INTO first_score
  FROM match_program_page(28, 'F', ARRAY['11','11620'], 'employee_office', 3, NULL,
    q, 200, true, NULL, NULL, NULL, 1);
  IF first_score IS DISTINCT FROM 1.0 THEN
    RAISE EXCEPTION 'Identical-vector cosine must map to cursor score 1: %', first_score;
  END IF;
  SELECT array_agg(program_id ORDER BY sort_score DESC, program_id) INTO ids
  FROM match_program_page(28, 'F', ARRAY['11','11620'], 'employee_office', 3, NULL,
    q, 200, true, NULL, first_score, a, 20);
  IF ids IS DISTINCT FROM ARRAY[b,c] THEN
    RAISE EXCEPTION 'Query cursor must continue without duplicates or omissions: %', ids;
  END IF;

  SELECT array_agg(program_id ORDER BY sort_score DESC, program_id) INTO ids
  FROM match_program_page(28, 'F', ARRAY['11','11620'], 'employee_office', 3, NULL,
    NULL, 200, false);
  IF ids IS DISTINCT FROM ARRAY[b,a,c] THEN
    RAISE EXCEPTION 'No-query relevance must retain composite ranking: %', ids;
  END IF;
  SELECT sort_score INTO first_score
  FROM match_program_page(28, 'F', ARRAY['11','11620'], 'employee_office', 3, NULL,
    NULL, 200, false) WHERE program_id = a;
  -- A has specificity 0, region 0.30, amount 0.35, deadline 0.50.
  IF first_score IS DISTINCT FROM 0.2875 THEN
    RAISE EXCEPTION 'No-query score must weight all four factors equally: %', first_score;
  END IF;
  IF EXISTS (
    SELECT 1 FROM match_program_page(28, 'F', ARRAY['11','11620'], 'employee_office', 3, NULL,
      NULL, 200, true) WHERE program_id = a AND sort_score <> first_score
  ) THEN
    RAISE EXCEPTION 'Unavailable query embedding must use the no-query score';
  END IF;
  SELECT array_agg(program_id ORDER BY sort_score DESC, program_id) INTO ids
  FROM match_program_page(28, 'F', ARRAY['11','11620'], 'employee_office', 3, NULL,
    NULL, 200, false, NULL, first_score, a, 20);
  IF ids IS DISTINCT FROM ARRAY[c] THEN
    RAISE EXCEPTION 'Equal-score cursor must use program id: %', ids;
  END IF;

  SELECT array_agg(program_id ORDER BY sort_score DESC, program_id) INTO ids
  FROM match_program_page(28, 'F', ARRAY['11','11620'], 'employee_office', 3, NULL,
    q, 200, true, NULL, NULL, NULL, 20, 0, 0, 'newest');
  IF ids IS DISTINCT FROM ARRAY[a,b,c] THEN
    RAISE EXCEPTION 'Newest must prioritize date, then query relevance: %', ids;
  END IF;
  SELECT array_agg(program_id ORDER BY sort_score DESC, program_id) INTO ids
  FROM match_program_page(28, 'F', ARRAY['11','11620'], 'employee_office', 3, NULL,
    q, 200, true, NULL, NULL, NULL, 20, 0, 0, 'deadline');
  IF ids IS DISTINCT FROM ARRAY[b,a,c] THEN
    RAISE EXCEPTION 'Deadline must prioritize finite dates, then query relevance: %', ids;
  END IF;
END;
$$;
ROLLBACK;
