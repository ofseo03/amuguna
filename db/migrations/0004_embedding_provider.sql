BEGIN;

ALTER TABLE program_embeddings
  ADD COLUMN provider text
  CHECK (provider IN ('mock', 'voyage', 'openai'));

COMMENT ON COLUMN program_embeddings.provider IS
  '벡터 공간 식별자. 기존 행은 NULL(unknown)로 두고 다음 수집 때 한 번 재색인해 과거 provider를 오표기하지 않는다.';

COMMIT;
