-- Executable regression against the migrated database; fixtures never persist.
BEGIN;
UPDATE public.programs SET status = 'expired' WHERE status <> 'expired';

DO $$
DECLARE
  a bigint; b bigint; c bigint; d bigint; e bigint; f bigint; g bigint; h bigint;
  q vector(1024) := ('[1,' || repeat('0,', 1022) || '0]')::vector;
  today date := (now() AT TIME ZONE 'Asia/Seoul')::date;
  ids bigint[];
  expected bigint[];
  paged bigint[];
  mode text;
  has_query boolean;
  row record;
  after_score double precision;
  after_id bigint;
  page_count integer;
BEGIN
  INSERT INTO programs (external_id, title, starts_at, ends_at) VALUES
    ('test:deadline-a', 'Today', today, today) RETURNING id INTO a;
  INSERT INTO programs (external_id, title, starts_at, ends_at) VALUES
    ('test:deadline-b', 'Near, stronger intent', today, today + 1) RETURNING id INTO b;
  INSERT INTO programs (external_id, title, starts_at, ends_at, benefit_amount_max) VALUES
    ('test:deadline-c', 'Near, stronger profile', today, today + 1, 100000000) RETURNING id INTO c;
  INSERT INTO programs (external_id, title, starts_at, ends_at) VALUES
    ('test:deadline-d', 'Far finite deadline', today, DATE '9999-12-31') RETURNING id INTO d;
  INSERT INTO programs (external_id, title, starts_at, ends_at, is_always_open) VALUES
    ('test:deadline-e', 'Always open despite a supplied date', today, today, true) RETURNING id INTO e;
  INSERT INTO programs (external_id, title, starts_at) VALUES
    ('test:deadline-f', 'Unknown deadline', today) RETURNING id INTO f;
  INSERT INTO programs (external_id, title, starts_at, ends_at) VALUES
    ('test:deadline-g', '2099 January, weakest recommendation', today, DATE '2099-01-01') RETURNING id INTO g;
  INSERT INTO programs (external_id, title, starts_at, ends_at, benefit_amount_max) VALUES
    ('test:deadline-h', '2099 December, strongest recommendation', today, DATE '2099-12-31', 100000000) RETURNING id INTO h;
  UPDATE eligibility_rules SET age_min = 20, age_max = 40, gender = 'F',
    regions = ARRAY['11620'], occupations = ARRAY['employee_office'], income_decile_max = 5
    WHERE program_id IN (c,h);
  INSERT INTO program_embeddings (program_id, chunk_idx, embedding, provider)
    SELECT id, 0, ('[' || x || ',' || y || ',' || repeat('0,', 1021) || '0]')::vector, 'mock'
    FROM (VALUES (a, '-1', '0'), (b, '0.8', '0.6'), (c, '0', '1'),
      (d, '-1', '0'), (e, '1', '0'), (f, '0.5', '0.8660254037844386'),
      (g, '-1', '0'), (h, '1', '0')) AS v(id,x,y);

  FOREACH has_query IN ARRAY ARRAY[true,false] LOOP
    FOREACH mode IN ARRAY ARRAY['relevance','newest','deadline','oldest'] LOOP
      IF mode = 'deadline' THEN
        -- January 2099 must beat December despite its lower recommendation score.
        -- Even 9999-12-31 must precede always-open and unknown deadlines.
        expected := CASE WHEN has_query THEN ARRAY[a,b,c,g,h,d,e,f] ELSE ARRAY[a,c,b,g,h,d,e,f] END;
      ELSE
        -- All start dates tie; legacy 'oldest' must behave like relevance.
        expected := CASE WHEN has_query THEN ARRAY[e,h,b,f,c,a,d,g] ELSE ARRAY[c,h,a,b,d,e,f,g] END;
      END IF;
      SELECT array_agg(program_id ORDER BY sort_score DESC, program_id) INTO ids
      FROM match_program_page(28, 'F', ARRAY['11','11620'], 'employee_office', 3, NULL,
        CASE WHEN has_query THEN q ELSE NULL END, 200, has_query,
        NULL, NULL, NULL, 20, 0, 0, mode);
      IF ids IS DISTINCT FROM expected THEN
        RAISE EXCEPTION 'Wrong order or candidate count for sort %, query %: % expected %',
          mode, has_query, ids, expected;
      END IF;

      paged := ARRAY[]::bigint[];
      after_score := NULL;
      after_id := NULL;
      LOOP
        page_count := 0;
        FOR row IN SELECT * FROM match_program_page(28, 'F', ARRAY['11','11620'], 'employee_office', 3, NULL,
          CASE WHEN has_query THEN q ELSE NULL END, 200, has_query,
          NULL, after_score, after_id, 2, 0, 0, mode)
        LOOP
          paged := array_append(paged, row.program_id);
          after_score := row.sort_score;
          after_id := row.program_id;
          page_count := page_count + 1;
          IF cardinality(paged) > 8 THEN RAISE EXCEPTION 'Cursor repeated candidates'; END IF;
        END LOOP;
        EXIT WHEN page_count = 0;
      END LOOP;
      IF paged IS DISTINCT FROM ids THEN
        RAISE EXCEPTION 'Cursor pages disagree for sort %, query %: %', mode, has_query, paged;
      END IF;
    END LOOP;
  END LOOP;
END;
$$;
ROLLBACK;
