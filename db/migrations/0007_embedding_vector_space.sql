BEGIN;

-- provider 만 저장하면 같은 provider 안에서의 모델 교체(voyage-3 → voyage-4-large)를
-- 감지하지 못한다. 옛 벡터 공간의 문서가 새 모델의 질의 벡터와 비교되어 유사도가
-- 조용히 망가지므로, 식별자에 모델명을 포함해 재색인이 트리거되게 한다.
ALTER TABLE program_embeddings
  DROP CONSTRAINT program_embeddings_provider_check;

ALTER TABLE program_embeddings
  ADD CONSTRAINT program_embeddings_provider_check
  CHECK (provider ~ '^(mock|voyage|openai)(:.+)?$');

COMMENT ON COLUMN program_embeddings.provider IS
  '벡터 공간 식별자 provider[:model] (예: voyage:voyage-4-large). mock 은 모델이 없어 provider 만 쓴다. 값이 바뀌면 전량 재색인 대상이다.';

COMMIT;
