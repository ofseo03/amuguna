BEGIN;

-- 새 벡터 공간은 staging 에 완성한 뒤 짧은 트랜잭션에서 이 pointer 와 활성 테이블을
-- 함께 교체한다. API/RPC 는 계속 program_embeddings (활성본)만 읽으므로 재색인 실패가
-- 서비스 검색 결과를 비우지 않는다.
CREATE TABLE ingest_embedding_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  active_vector_space text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (active_vector_space IS NULL OR active_vector_space ~ '^(mock|voyage|openai)(:.+)?$')
);

INSERT INTO ingest_embedding_state (singleton, active_vector_space)
SELECT true,
       CASE
         WHEN count(*) = 0 THEN NULL
         WHEN count(*) FILTER (WHERE provider IS NULL) = 0
              AND count(DISTINCT provider) = 1 THEN min(provider)
         ELSE NULL
       END
FROM program_embeddings;

-- 0004 이전의 provider=NULL 벡터는 질의 모델과의 호환성을 증명할 수 없다.
-- active pointer가 NULL인 상태에서는 벡터 검색을 막고 주간 재색인을 요구한다.
DELETE FROM program_embeddings
WHERE provider IS NULL
   OR provider IS DISTINCT FROM (
     SELECT active_vector_space FROM ingest_embedding_state WHERE singleton
   );

DELETE FROM program_embeddings AS e
USING programs AS p
WHERE p.id = e.program_id AND p.status <> 'active';

ALTER TABLE program_embeddings
  ALTER COLUMN provider SET NOT NULL;

CREATE TABLE program_embedding_staging (
  program_id bigint NOT NULL REFERENCES programs (id) ON DELETE CASCADE,
  vector_space text NOT NULL CHECK (vector_space ~ '^(mock|voyage|openai)(:.+)?$'),
  chunk_idx int NOT NULL CHECK (chunk_idx >= 0),
  embedding vector(1024) NOT NULL,
  embedded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (program_id, vector_space, chunk_idx)
);

COMMENT ON TABLE ingest_embedding_state IS
  '활성 벡터 공간 pointer. staging 전체 검증 뒤 program_embeddings 교체와 같은 트랜잭션에서만 변경한다.';
COMMENT ON TABLE program_embedding_staging IS
  '재색인 후보 벡터. 활성 검색 테이블과 분리되어 실패한 재색인이 기존 검색 결과를 지우지 않는다.';

ALTER TABLE eligibility_rules
  ADD COLUMN needs_review boolean NOT NULL DEFAULT false,
  ADD COLUMN review_reason text;

UPDATE eligibility_rules e
SET needs_review = true,
    review_reason = COALESCE(e.review_reason, 'legacy_unknown')
FROM programs p
WHERE p.id = e.program_id AND p.status = 'needs_review';

COMMENT ON COLUMN eligibility_rules.review_reason IS
  '재파싱 대상과 사유. blocking 사유는 programs.status=needs_review 로 서비스 노출을 막는다.';

-- needs_review도 검색 대상이 아니므로 HNSW top-k를 점유하지 않게 한다.
DROP TRIGGER programs_drop_embeddings_on_expire_trg ON programs;
CREATE TRIGGER programs_drop_embeddings_on_expire_trg
  AFTER UPDATE OF status ON programs
  FOR EACH ROW
  WHEN (NEW.status <> 'active' AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION programs_drop_embeddings_on_expire();
COMMENT ON FUNCTION programs_drop_embeddings_on_expire() IS
  'expired 또는 needs_review 전환 시 해당 프로그램의 활성 임베딩을 삭제한다.';

CREATE TABLE ingest_source_baselines (
  source_key text PRIMARY KEY,
  fetched_count integer NOT NULL CHECK (fetched_count >= 0),
  succeeded_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE ingest_source_baselines IS
  'source 별 마지막 오류 없는 수집의 fetched 건수. 다음 실행의 50% 이상 감소를 배치 실패로 감지한다.';

ALTER TABLE ingest_embedding_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE program_embedding_staging ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_source_baselines ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE ingest_embedding_state, program_embedding_staging, ingest_source_baselines FROM PUBLIC;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'REVOKE ALL ON TABLE ingest_embedding_state, program_embedding_staging, ingest_source_baselines FROM %I', r);
    END IF;
  END LOOP;
END;
$$;

COMMIT;
