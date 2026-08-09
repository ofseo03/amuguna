-- =============================================================================
-- amuguna — 0003_privacy.sql
-- 익명 프로필 + 개인정보 보존기간 정리
--
-- 근거: SPEC §5 (profiles), §8 개인정보
--   * 이름·연락처·주민번호를 수집하지 않는다. 익명 세션(쿠키 uuid) 기반, 회원가입 없음
--   * 프로필 데이터 90일 후 자동 삭제
--   * 단 이메일이 등록된 프로필은 알림 유지를 위해 자동 삭제 대상에서 제외한다
--     — 이 예외를 두지 않으면 90일 뒤 알림이 조용히 죽는다
--   * 알림 해지 시 프로필까지 즉시 삭제 (DELETE FROM profiles WHERE id = $1)
--   * 자유입력("원하는 것")은 어디에도 저장하지 않는다 — 검색 시점에만 쓰고 영속화 없음.
--     그래서 이 테이블에 해당 컬럼이 없다. 추가하지 말 것.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- profiles — 익명 프로필 (SPEC §5)
-- -----------------------------------------------------------------------------
CREATE TABLE profiles (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  age           smallint    CHECK (age BETWEEN 0 AND 120),
  gender        text        CHECK (gender IN ('M','F')),
  occupation    text,
  region_code   text        CHECK (region_code ~ '^[0-9]{2}([0-9]{3})?$'),
  income_decile smallint    CHECK (income_decile BETWEEN 1 AND 10),

  created_at    timestamptz NOT NULL DEFAULT now(),
  email         text        CHECK (email IS NULL OR email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),

  -- 이메일 1클릭 해지 링크용 무작위 토큰. 세션 식별자(id)와 분리해 두는 이유:
  -- 메일로 나가는 값이라 전달·유출 가능성이 있는데, id 를 그대로 쓰면 프로필
  -- 기본키가 노출되고 재발급도 불가능하다. 토큰은 재구독 시 회전된다.
  -- 웹은 randomBytes(24).toString('base64url') = 32자 [A-Za-z0-9_-] 를 넣는다.
  unsubscribe_token text     UNIQUE CHECK (unsubscribe_token IS NULL OR unsubscribe_token ~ '^[A-Za-z0-9_-]{20,}$')
);

COMMENT ON TABLE  profiles IS
  '익명 프로필. 회원가입 없음, 세션 쿠키의 uuid 가 곧 id. 자유입력("원하는 것")은 저장하지 않는다. SPEC §5 / §8';
COMMENT ON COLUMN profiles.id IS
  '세션 쿠키에 담는 익명 식별자. 해지 링크에는 쓰지 않는다 — unsubscribe_token 참고. SPEC §9';
COMMENT ON COLUMN profiles.unsubscribe_token IS
  '이메일 해지 링크 토큰 (id 와 분리, 재구독 시 회전). /api/unsubscribe/:token 이 이 값으로 행을 DELETE 한다. SPEC §9';
COMMENT ON COLUMN profiles.gender IS
  'NULL = ''선택 안 함''. match_programs 에 그대로 넘기면 성별 조건 프로그램도 포함된다. SPEC §5';
COMMENT ON COLUMN profiles.occupation IS
  'shared/occupations.json 의 code 단일값.';
COMMENT ON COLUMN profiles.region_code IS
  '시도 2자리 또는 시군구 5자리 (shared/regions.json). 질의 시 region_prefixes(region_code) 로 배열화해 match_programs 에 넘긴다. SPEC §5';
COMMENT ON COLUMN profiles.income_decile IS
  '1..10 자가 입력. 화면에는 shared/income_deciles.json 의 소득 구간 라벨을 병기한다. SPEC §5';
COMMENT ON COLUMN profiles.email IS
  '알림 신청 시에만 별도 동의 후 수집. NULL 이면 90일 뒤 purge_stale_profiles() 로 자동 삭제되고, 값이 있으면 알림 유지를 위해 제외된다. 해지 시 행 자체를 삭제한다. SPEC §8';

-- purge_stale_profiles() 의 조건절과 정확히 일치하는 부분 인덱스.
-- 삭제 대상(이메일 미등록)만 색인하므로 알림 구독자가 늘어도 인덱스가 커지지 않는다.
CREATE INDEX profiles_purge_idx ON profiles (created_at) WHERE email IS NULL;

-- 해지·중복 구독 조회용. 대소문자 구분 없이 유일하게 둔다.
CREATE UNIQUE INDEX profiles_email_unique_idx ON profiles (lower(email)) WHERE email IS NOT NULL;


-- -----------------------------------------------------------------------------
-- purge_stale_profiles — 90일 경과 익명 프로필 삭제 (SPEC §8)
--   삭제 건수를 반환하므로 배치 로그에 그대로 남길 수 있다.
--   보존기간은 인자로 뺐지만 기본값 90 이라 purge_stale_profiles() 로 호출하면 된다.
-- -----------------------------------------------------------------------------
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
  WHERE email IS NULL                                  -- 알림 등록 프로필은 예외 (SPEC §8)
    AND created_at < now() - make_interval(days => p_retention_days);

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION purge_stale_profiles(int) IS
  '이메일 미등록 익명 프로필을 보존기간(기본 90일) 경과 시 삭제하고 삭제 건수를 반환한다. 이메일 등록 프로필은 알림 유지를 위해 제외 — 해지 시 즉시 DELETE 한다. SPEC §8';


-- -----------------------------------------------------------------------------
-- 스케줄링 — **수집 배치가 매 실행 호출한다 (기본 동작)**
--
--   `ingest/pipeline.py::Pipeline.purge_profiles` 가 live 실행마다
--   `SELECT purge_stale_profiles()` 를 호출하고, 삭제 건수를 수집 리포트에
--   남긴다 (§10 수집 상태 로깅과 같은 자리). 실패하면 리포트에 purge_error 로
--   드러나고 stderr 에 경고가 찍힌다. 끄려면 `python -m ingest --no-purge`.
--
--   이 파일에 pg_cron 스케줄을 심지 않는 이유: 확장 활성화가 요금제·대시보드
--   설정에 의존해 마이그레이션만으로 보장되지 않는다. 실제로 매일 도는 것이
--   확인된 실행 지점(심야 수집 배치)에 붙이는 편이 정책이 '문서에만 존재하는'
--   상태를 만들지 않는다.
--
--   DB 쪽에서도 이중으로 돌리고 싶으면 (수집 배치가 멈춰도 파기는 돌게):
--
--     CREATE EXTENSION IF NOT EXISTS pg_cron;
--     SELECT cron.schedule(
--       'purge-stale-profiles',
--       '20 18 * * *',                       -- 18:20 UTC = 03:20 KST
--       $cron$ SELECT public.purge_stale_profiles(); $cron$
--     );
--
--   함수가 멱등이라 두 경로가 겹쳐 돌아도 안전하다 (두 번째는 0건 삭제).
--   심사 구간(9/7~9/11) 중에도 동작해야 하는 항목이므로 W4 배포 점검에 포함할 것.
-- -----------------------------------------------------------------------------


-- -----------------------------------------------------------------------------
-- 접근 제어 — 0001 과 동일 정책. profiles 는 특히 브라우저에 노출되면 안 된다.
--   RLS 정책 없음 = 전부 거부. service_role(BYPASSRLS)만 서버에서 접근한다.
-- -----------------------------------------------------------------------------
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON FUNCTION purge_stale_profiles(int) FROM PUBLIC;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE profiles FROM %I', r);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION purge_stale_profiles(int) TO service_role';
  END IF;
END;
$$;

COMMIT;
