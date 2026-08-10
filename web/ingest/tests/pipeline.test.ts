import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { COLLECTORS } from "../collectors";
import { Collector, CollectorError } from "../collectors/base";
import { settingsFromEnv } from "../config";
import { InMemoryDatabase } from "../db";
import { Embedder } from "../embedder";
import { CollectedProgram } from "../models";
import { Pipeline } from "../pipeline";

const settings = settingsFromEnv({ NODE_ENV: "test" });
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function program(overrides: Partial<ConstructorParameters<typeof CollectedProgram>[0]> = {}) {
  return new CollectedProgram({
    external_id: "fake:001",
    source_key: "fake",
    source_url: "https://example.test/1",
    title: "청년 전월세보증금 대출 지원",
    body_text: "청년의 전월세 보증금을 저리로 대출합니다.",
    eligibility_text: "만 19세 이상 및 만 34세 이하 무주택 세대주로 기준 중위소득 150% 이하인 자",
    form: "loan",
    issuer: "국토교통부",
    benefit_amount_text: "최대 1억원",
    benefit_amount_max: 100_000_000,
    apply_url: "https://example.test/apply",
    apply_method: "온라인 신청",
    ...overrides,
  });
}

class FakeCollector extends Collector {
  readonly sourceKey = "fake";
  readonly endpoint = "https://example.test";
  readonly idListEndpoint = this.endpoint;

  constructor(
    private readonly programs: CollectedProgram[],
    private readonly sourceIds = new Set(programs.map((item) => item.external_id)),
    private readonly fail = false,
  ) {
    super({ settings });
  }

  protected queryParams(): Record<string, string> {
    return {};
  }

  protected items(): Record<string, unknown>[] {
    return [];
  }

  protected mapItem(): CollectedProgram | null {
    return null;
  }

  override async fetch(): Promise<CollectedProgram[]> {
    if (this.fail) throw new CollectorError("소스 장애");
    return this.programs;
  }

  override async listExternalIds(): Promise<Set<string>> {
    return this.sourceIds;
  }
}

function pipeline(db: InMemoryDatabase, embedder = new Embedder(settings)) {
  return new Pipeline(db, { embedder, llm: null, dryRun: true });
}

test("new, unchanged, update, and reconciliation preserve the state-machine contract", async () => {
  const db = new InMemoryDatabase();
  const ingest = pipeline(db);
  const original = program();

  await ingest.runSource(new FakeCollector([original]));
  await ingest.runSource(new FakeCollector([original]));
  assert.equal(db.rawDocuments.length, 1);
  assert.deepEqual(
    [ingest.report.totals.created, ingest.report.totals.updated, ingest.report.totals.unchanged],
    [1, 0, 1],
  );
  assert.deepEqual([db.rules.get(1)?.age_min, db.rules.get(1)?.age_max], [19, 34]);

  await ingest.runSource(new FakeCollector([program({ ends_at: "2027-01-31" })]));
  assert.equal(db.rawDocuments.length, 2);
  assert.equal(db.programs.size, 1);
  assert.equal(ingest.report.totals.updated, 1);

  await ingest.runSource(new FakeCollector([], new Set(["fake:other"])), { reconcile: true });
  assert.equal(db.programs.get(1)?.status, "expired");
  assert.equal(db.embeddings.has(1), false);
});

test("source and real-embedding failures keep the previous snapshot or roll back the record", async () => {
  const db = new InMemoryDatabase();
  const ingest = pipeline(db);
  await ingest.runSource(new FakeCollector([program()]));
  await ingest.runSource(new FakeCollector([], new Set(), true));
  assert.equal(db.programs.get(1)?.status, "active");

  const failedDb = new InMemoryDatabase();
  const realEmbedder = new Embedder({
    embedding_provider: "openai",
    embedding_api_key: "",
    mock_embeddings: false,
  });
  const failed = pipeline(failedDb, realEmbedder);
  const stats = await failed.runSource(new FakeCollector([program()]));
  assert.equal(stats.errors.length, 1);
  assert.equal(failedDb.rawDocuments.length, 0);
  assert.equal(failedDb.programs.size, 0);
});

test("changing embedding provider reindexes once and never mixes vector spaces", async () => {
  const db = new InMemoryDatabase();
  await pipeline(db).runSource(new FakeCollector([program()]));
  assert.equal(await db.embeddingProvider(1), "mock");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ data: [{ embedding: [1, ...new Array(1023).fill(0)] }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  try {
    const embedder = new Embedder({
      embedding_provider: "openai",
      embedding_api_key: "test",
      mock_embeddings: false,
    });
    const reindex = pipeline(db, embedder);
    const collector = new FakeCollector([program()]);
    await assert.rejects(reindex.run([collector]), /weekly-reconcile/);
    assert.equal(await db.embeddingProvider(1), "mock");

    await reindex.run([collector], { reconcile: true });
    const stats = reindex.report.totals;
    assert.equal(stats.unchanged, 1);
    assert.equal(await db.embeddingProvider(1), "openai");
    assert.equal(db.rawDocuments.length, 1);

    await reindex.runSource(collector);
    assert.equal(reindex.report.totals.unchanged, 2);
    assert.equal(embedder.apiCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CLI exits non-zero when every fetched record rolls back", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "ingest/cli.ts", "--fixtures", "--dry-run", "--no-llm"],
    {
      cwd: webRoot,
      env: {
        ...process.env,
        EMBEDDING_PROVIDER: "openai",
        EMBEDDING_API_KEY: "",
        MOCK_EMBEDDINGS: "",
        OPENROUTER_API_KEY: "",
        DATABASE_URL: "",
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 1, result.stdout + result.stderr);
});

test("all 30 fixtures match the established coverage baseline and are idempotent", async () => {
  const db = new InMemoryDatabase();
  const ingest = pipeline(db);
  const collectors = Object.keys(COLLECTORS)
    .sort()
    .map((key) => new COLLECTORS[key]({ settings, useFixtures: true }));

  await ingest.run(collectors);
  assert.deepEqual(
    Object.fromEntries([...ingest.report.sources].map(([key, value]) => [key, value.fetched])),
    { bizinfo: 8, finlife: 7, gov24: 1, kstartup: 1, local_welfare: 1, social_security: 12 },
  );
  assert.equal(ingest.report.totals.created, 30);
  assert.deepEqual(ingest.report.parse.fieldHits, {
    age_min: 12,
    age_max: 9,
    regions: 5,
    occupations: 8,
    income_decile_max: 11,
  });
  assert.equal(ingest.report.parse.withExtraConditions, 13);
  assert.equal(Number(ingest.report.parse.meanConfidence.toFixed(3)), 0.707);

  await ingest.run(collectors);
  assert.equal(ingest.report.totals.updated, 0);
  assert.equal(ingest.report.totals.unchanged, 30);
  assert.equal(db.rawDocuments.length, 30);
});
