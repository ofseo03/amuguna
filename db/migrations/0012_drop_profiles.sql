-- 프로필을 서버에 저장하지 않는다 (SPEC §8 개인정보 최소화).
--
-- 매칭은 서명한 httpOnly 쿠키의 프로필만으로 동작하므로 profiles 행이 필요 없었다.
-- 유일한 저장 이유였던 이메일 알림을 MVP 범위에서 뺐으므로(SPEC §11) 테이블째 제거한다.
-- 이제 DB 에 남는 개인정보는 없고, 공공 API 에서 수집한 지원사업 데이터만 보관한다.
--
-- 되돌릴 때는 0003 을 다시 적용한 뒤 0006 의 median_income_percent 컬럼을 추가한다.
BEGIN;

-- profiles 에만 걸려 있던 인덱스·정책·트리거는 테이블과 함께 사라진다.
DROP TABLE IF EXISTS profiles;

-- 삭제할 대상이 없어졌다. 0003 이 안내한 pg_cron / GitHub Actions 스케줄도 함께 걷어낸다.
DROP FUNCTION IF EXISTS purge_stale_profiles(int);

COMMIT;
