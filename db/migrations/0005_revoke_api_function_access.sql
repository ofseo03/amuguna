-- Supabase may grant EXECUTE directly to anon/authenticated through default
-- privileges. REVOKE FROM PUBLIC alone does not remove those role grants.
BEGIN;

REVOKE ALL ON FUNCTION match_programs(int, text, text[], text, int, vector, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION region_prefixes(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION purge_stale_profiles(int) FROM PUBLIC;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION match_programs(int, text, text[], text, int, vector, int) FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION region_prefixes(text) FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION purge_stale_profiles(int) FROM %I', r);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION match_programs(int, text, text[], text, int, vector, int) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION region_prefixes(text) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION purge_stale_profiles(int) TO service_role';
  END IF;
END;
$$;

COMMIT;
