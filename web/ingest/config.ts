import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(PACKAGE_DIR, "../..");
export const SHARED_DIR = resolve(REPO_ROOT, "shared");
export const FIXTURES_DIR = resolve(REPO_ROOT, "ingest/fixtures");

export const EMBEDDING_DIM = 1024;
export const LLM_MODEL = "claude-sonnet-5";

export interface Settings {
  database_url: string;
  data_go_kr_api_key: string;
  anthropic_api_key: string;
  embedding_provider: string;
  embedding_api_key: string;
  mock_embeddings: boolean;
}

function envValue(env: NodeJS.ProcessEnv, name: string, fallback = ""): string {
  return (env[name] || fallback).trim();
}

export function settingsFromEnv(env: NodeJS.ProcessEnv = process.env): Settings {
  const provider = envValue(env, "EMBEDDING_PROVIDER", "mock").toLowerCase() || "mock";
  const forcedMock = envValue(env, "MOCK_EMBEDDINGS") === "1";
  const embeddingKey = envValue(env, "EMBEDDING_API_KEY");

  return {
    database_url: envValue(env, "DATABASE_URL"),
    data_go_kr_api_key: envValue(env, "DATA_GO_KR_API_KEY"),
    anthropic_api_key: envValue(env, "ANTHROPIC_API_KEY"),
    embedding_provider: forcedMock ? "mock" : provider,
    embedding_api_key: embeddingKey,
    mock_embeddings: forcedMock || provider === "mock" || !embeddingKey,
  };
}

export const loadSettings = settingsFromEnv;
