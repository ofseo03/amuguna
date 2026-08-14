-- Double opt-in email notifications. Free-text queries are intentionally absent:
-- notifications reuse only the stored eligibility profile (A).
BEGIN;

ALTER TABLE profiles
  ADD COLUMN confirmation_token text UNIQUE
    CHECK (confirmation_token IS NULL OR confirmation_token ~ '^[A-Za-z0-9_-]{20,}$'),
  ADD COLUMN email_confirmed_at timestamptz;

COMMENT ON COLUMN profiles.confirmation_token IS
  'Double opt-in 확인 링크 토큰. 확인 성공 시 NULL 로 비워 재사용을 막는다.';
COMMENT ON COLUMN profiles.email_confirmed_at IS
  'NULL 은 확인 전 또는 비구독 프로필. 알림 배치는 이 값이 있는 행만 읽는다.';

CREATE TABLE notification_outbox (
  id bigserial PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('confirm', 'digest')),
  delivery_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  covered_through_at timestamptz,
  payload jsonb,
  sent_at timestamptz,
  last_error text
);

CREATE INDEX notification_outbox_pending_idx
  ON notification_outbox (created_at) WHERE sent_at IS NULL;

COMMENT ON TABLE notification_outbox IS
  'Resend 발송 idempotency 기록. sent_at 전 실패는 같은 delivery_key 로 재시도한다.';

-- 확인하지 않은 이메일은 알림용 장기 보관 예외를 얻지 않는다.
CREATE OR REPLACE FUNCTION purge_stale_profiles(p_retention_days int DEFAULT 90)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_deleted int;
BEGIN
  IF p_retention_days IS NULL OR p_retention_days < 1 THEN
    RAISE EXCEPTION 'purge_stale_profiles: p_retention_days must be >= 1 (got %)', p_retention_days;
  END IF;

  DELETE FROM public.profiles
  WHERE (email IS NULL AND created_at < now() - make_interval(days => p_retention_days))
     OR (email IS NOT NULL AND email_confirmed_at IS NULL AND created_at < now() - interval '7 days');

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

ALTER TABLE notification_outbox ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE notification_outbox FROM PUBLIC;
REVOKE ALL ON SEQUENCE notification_outbox_id_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION purge_stale_profiles(int) FROM PUBLIC;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE notification_outbox FROM %I', r);
      EXECUTE format('REVOKE ALL ON SEQUENCE notification_outbox_id_seq FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION purge_stale_profiles(int) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION purge_stale_profiles(int) TO service_role';
  END IF;
END;
$$;

COMMIT;
