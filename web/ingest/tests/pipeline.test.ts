import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { COLLECTORS } from "../collectors";
import { Collector, CollectorError } from "../collectors/base";
import { settingsFromEnv } from "../config";
import { InMemoryDatabase } from "../db";
import { Embedder, OPENAI_MODEL } from "../embedder";
import { CollectedProgram, EligibilityRules } from "../models";
import { checkVolumeDrop, Pipeline, reportToJson, SourceStats } from "../pipeline";

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
  readonly sourceKey: string = "fake";
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

class FinlifeFakeCollector extends FakeCollector {
  override readonly sourceKey = "finlife";
}

function pipeline(db: InMemoryDatabase, embedder = new Embedder(settings), today = "2025-01-01") {
  return new Pipeline(db, { embedder, dryRun: true, today });
}

const LABEL_FIELDS = [
  "age_min",
  "age_max",
  "gender",
  "regions",
  "occupations",
  "income_decile_max",
  "median_income_percent_max",
] as const;
type FixtureLabel = Pick<EligibilityRules, (typeof LABEL_FIELDS)[number]>;
const label = (overrides: Partial<FixtureLabel> = {}): FixtureLabel => ({
  age_min: null,
  age_max: null,
  gender: null,
  regions: null,
  occupations: null,
  income_decile_max: null,
  median_income_percent_max: null,
  ...overrides,
});

const FIXTURE_LABELS: Record<string, FixtureLabel> = {
  "bizinfo:PBLN_000000000098431": label({ occupations: ["self_employed"] }),
  "bizinfo:PBLN_000000000099022": label({
    regions: ["26350"],
    occupations: ["self_employed"],
  }),
  "bizinfo:PBLN_000000000097355": label({ occupations: ["self_employed"] }),
  "bizinfo:PBLN_000000000098770": label(),
  "bizinfo:PBLN_000000000099410": label({ occupations: ["self_employed"] }),
  "bizinfo:PBLN_000000000096001": label(),
  "bizinfo:PBLN_000000000099880": label({ occupations: ["self_employed"] }),
  "bizinfo:PBLN_000000000095220": label(),
  "finlife:0010001-KB-YOUTH-01": label({
    age_min: 19,
    age_max: 34,
    median_income_percent_max: 180,
  }),
  "finlife:0010002-IBK-BOSS-02": label({ occupations: ["self_employed"] }),
  "finlife:0010003-SHB-EDEP-05": label(),
  "finlife:0010004-NH-SENIOR-03": label({ age_min: 60 }),
  "finlife:0010005-HANA-FREE-07": label({ age_min: 19, age_max: 34 }),
  "finlife:0010006-WOORI-HOUSE-09": label(),
  "finlife:0010007-KAKAO-PARK-11": label(),
  "gov24:GOV24-DEMO-001": label({
    age_min: 19,
    age_max: 34,
    median_income_percent_max: 150,
  }),
  "kstartup:KSTARTUP-DEMO-001": label({ age_min: 20, age_max: 39 }),
  "local_welfare:LOCAL-DEMO-001": label({
    age_min: 19,
    age_max: 39,
    regions: ["11620"],
    median_income_percent_max: 150,
  }),
  "social_security:WII0000345": label({ age_min: 19, age_max: 34 }),
  "social_security:WII0000112": label({ median_income_percent_max: 48 }),
  "social_security:WII0000001": label({ age_min: 65 }),
  "social_security:WII0000078": label({ median_income_percent_max: 75 }),
  "social_security:WII0000254": label({ age_min: 65 }),
  "social_security:WII0000411": label(),
  "social_security:WII0000633": label({
    regions: ["46150"],
    occupations: ["farmer_fisher"],
  }),
  "social_security:WII0000702": label({
    age_min: 19,
    age_max: 39,
    regions: ["11"],
    median_income_percent_max: 150,
  }),
  "social_security:WII0000188": label({ median_income_percent_max: 150 }),
  "social_security:WII0000520": label({ age_min: 19, age_max: 34 }),
  "social_security:WII0000861": label({
    regions: ["26350"],
    median_income_percent_max: 60,
  }),
  "social_security:WII0000970": label({
    age_min: 15,
    age_max: 69,
    occupations: ["jobseeker"],
    median_income_percent_max: 60,
  }),
};

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

test("past deadlines are expired or skipped before ingestion", async () => {
  const db = new InMemoryDatabase();
  await pipeline(db, undefined, "2026-08-31").runSource(
    new FakeCollector([program({ ends_at: "2026-08-31" })]),
  );

  const ingest = pipeline(db, undefined, "2026-09-01");
  await ingest.runSource(
    new FakeCollector([
      program({ external_id: "fake:old", ends_at: "2026-08-31" }),
      program({ external_id: "fake:today", ends_at: "2026-09-01" }),
      program({ external_id: "fake:open", ends_at: null, is_always_open: true }),
    ]),
  );
  await ingest.run([], { reconcile: true });

  assert.equal(db.programs.get(1)?.status, "expired");
  assert.equal(db.embeddings.has(1), false);
  assert.equal(await db.getProgramId("fake:old"), null);
  assert.notEqual(await db.getProgramId("fake:today"), null);
  assert.notEqual(await db.getProgramId("fake:open"), null);
});

test("MVP sources keep at most 100 active programs", async () => {
  const db = new InMemoryDatabase();
  await db.recordSourceBaseline("finlife", 1_000);
  const programs = Array.from({ length: 101 }, (_, index) =>
    program({
      external_id: `finlife:${index}`,
      source_key: "finlife",
      title: `공고 ${index}`,
    }),
  );

  const ingest = pipeline(db);
  await ingest.runSource(new FinlifeFakeCollector(programs));

  assert.equal((await db.activeExternalIds("finlife")).size, 100);
  assert.equal(db.programs.get(1)?.status, "expired");
  assert.deepEqual(checkVolumeDrop(ingest.report), []);
});

test("a parser version bump reparses identical stored content once", async () => {
  const db = new InMemoryDatabase();
  const original = program();
  await pipeline(db).runSource(new FakeCollector([original]));
  const programId = await db.getProgramId(original.external_id);
  assert.notEqual(programId, null);

  // 배포 전 해시에는 parser-vN 접두사가 없다. 호출 제한 수집기도 이 ID를 다시
  // 상세 조회할 수 있어야 하고, 동일 원문이어도 규칙을 새 파서로 교체해야 한다.
  db.rawDocuments[0].content_hash = db.rawDocuments[0].content_hash.split(":").at(-1)!;
  db.rules.get(programId!)!.age_min = 99;
  assert.deepEqual(await db.knownExternalIds("fake"), new Set());

  const ingest = pipeline(db);
  await ingest.runSource(new FakeCollector([original]));
  assert.equal(db.rawDocuments.length, 2);
  assert.equal(db.rules.get(programId!)?.age_min, 19);
  assert.deepEqual(
    [ingest.report.totals.created, ingest.report.totals.updated, ingest.report.totals.unchanged],
    [0, 1, 0],
  );
  assert.deepEqual(await db.knownExternalIds("fake"), new Set([original.external_id]));

  await ingest.runSource(new FakeCollector([original]));
  assert.equal(db.rawDocuments.length, 2);
  assert.equal(ingest.report.totals.unchanged, 1);
});

test("JSON report records a source incremental strategy", () => {
  const ingest = pipeline(new InMemoryDatabase());
  const stats = new SourceStats("social_security");
  stats.incrementalStrategy = "full_list_known_ids_detail_budget";
  ingest.report.sources.set(stats.sourceKey, stats);
  const sources = reportToJson(ingest.report).sources as Record<string, Record<string, unknown>>;
  assert.equal(sources.social_security?.incremental_strategy, "full_list_known_ids_detail_budget");
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
    // provider 가 아니라 provider:model 로 저장돼야 같은 provider 안의 모델 교체도 재색인된다.
    assert.equal(await db.embeddingProvider(1), `openai:${OPENAI_MODEL}`);
    assert.equal(db.rawDocuments.length, 1);

    await reindex.runSource(collector);
    assert.equal(reindex.report.totals.unchanged, 2);
    assert.equal(embedder.apiCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a vector-space change reindexes every stored program, not just the collected ones", async () => {
  const db = new InMemoryDatabase();
  // 두 소스를 적재해 둔다.
  await pipeline(db).runSource(new FakeCollector([program()]));
  await pipeline(db).runSource(
    new FakeCollector([program({ external_id: "other:001", source_key: "other" })]),
  );
  assert.equal((await db.programIds()).length, 2);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: [{ embedding: [1, ...new Array(1023).fill(0)] }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  try {
    const embedder = new Embedder({
      embedding_provider: "openai",
      embedding_api_key: "test",
      mock_embeddings: false,
    });
    // 한 소스만 골라 돌려도(--source 상당) 나머지 소스가 임베딩 없이 남으면 안 된다.
    await pipeline(db, embedder).run([new FakeCollector([program()])], { reconcile: true });
    for (const programId of await db.programIds()) {
      assert.equal(await db.embeddingProvider(programId), `openai:${OPENAI_MODEL}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("failed reindex keeps the prior active vector space until a complete retry", async () => {
  const db = new InMemoryDatabase();
  await pipeline(db).runSource(new FakeCollector([program()]));
  await pipeline(db).runSource(
    new FakeCollector([program({ external_id: "other:001", source_key: "other" })]),
  );
  db.activeVectorSpace = "mock";

  let fail = true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    fail
      ? new Response("upstream failed", { status: 500 })
      : new Response(JSON.stringify({ data: [{ embedding: [1, ...new Array(1023).fill(0)] }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
  try {
    const reindex = pipeline(
      db,
      new Embedder({ embedding_provider: "openai", embedding_api_key: "test", mock_embeddings: false }),
    );
    await assert.rejects(reindex.run([], { reconcile: true }), /embedding API 500/);
    assert.equal(await db.activeEmbeddingSpace(), "mock");
    assert.equal(await db.embeddingProvider(1), "mock");
    assert.equal(await db.embeddingProvider(2), "mock");

    fail = false;
    await reindex.run([], { reconcile: true });
    assert.equal(await db.activeEmbeddingSpace(), `openai:${OPENAI_MODEL}`);
    assert.equal(await db.embeddingProvider(1), `openai:${OPENAI_MODEL}`);
    assert.equal(await db.embeddingProvider(2), `openai:${OPENAI_MODEL}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reconciliation expires active records but preserves needs_review records", async () => {
  const db = new InMemoryDatabase();
  const ingest = pipeline(db);
  await ingest.runSource(new FakeCollector([program()]));
  db.programs.get(1)!.status = "needs_review";

  await ingest.runSource(new FakeCollector([], new Set()), { reconcile: true });
  assert.equal(db.programs.get(1)?.status, "needs_review");
});

test("source baselines are retained and flag a drop of 50% or more", async () => {
  const db = new InMemoryDatabase();
  const initial = Array.from({ length: 10 }, (_, index) =>
    program({ external_id: `fake:${String(index).padStart(3, "0")}` }),
  );
  await pipeline(db).runSource(new FakeCollector(initial));
  assert.equal(await db.sourceBaseline("fake"), 10);

  const second = pipeline(db);
  await second.runSource(new FakeCollector(initial.slice(0, 5)), { reconcile: true });
  assert.deepEqual(checkVolumeDrop(second.report), ["fake: 기준 10건 → 금일 5건 (50% 이상 감소)"]);
  assert.equal(await db.sourceBaseline("fake"), 10);
  assert.equal(db.programs.get(10)?.status, "active", "급감한 목록으로 기존 공고를 만료하면 안 된다");
});

test("atomic reindex rejects a staged id set that differs from active programs", async () => {
  const db = new InMemoryDatabase();
  await pipeline(db).runSource(new FakeCollector([program()]));
  await db.stageEmbeddings(1, [[1]], "openai:test");
  await db.stageEmbeddings(999, [[1]], "openai:test");
  await assert.rejects(db.activateEmbeddingSpace("openai:test"), /완전하지/);
  assert.equal(await db.embeddingProvider(1), "mock");
});

test("expired programs are not resurrected by a reindex", async () => {
  const db = new InMemoryDatabase();
  await pipeline(db).runSource(new FakeCollector([program()]));
  await db.expirePrograms(["fake:001"]);
  assert.deepEqual(await db.programIds(), []);
  assert.deepEqual(await db.programIdsWithoutEmbeddings(), []);
});

test("CLI exits non-zero when every fetched record rolls back", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "ingest/cli.ts", "--fixtures", "--dry-run"],
    {
      cwd: webRoot,
      env: {
        ...process.env,
        EMBEDDING_PROVIDER: "openai",
        EMBEDDING_API_KEY: "",
        MOCK_EMBEDDINGS: "",
        DATABASE_URL: "",
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 1, result.stdout + result.stderr);
});

test("CLI exits non-zero on a source volume drop", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "ingest/cli.ts",
      "--fixtures",
      "--dry-run",
      "--source",
      "bizinfo",
      "--previous-counts",
      '{"bizinfo":20}',
    ],
    { cwd: webRoot, env: { ...process.env, DATABASE_URL: "" }, encoding: "utf8" },
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
  const actualByExternalId = new Map(
    [...db.programs].map(([id, stored]) => [stored.external_id, db.rules.get(id)]),
  );
  assert.deepEqual([...actualByExternalId.keys()].sort(), Object.keys(FIXTURE_LABELS).sort());
  for (const field of LABEL_FIELDS) {
    const correct = Object.entries(FIXTURE_LABELS).filter(([externalId, expected]) =>
      isDeepStrictEqual(actualByExternalId.get(externalId)?.[field], expected[field]),
    ).length;
    assert.ok(correct / 30 >= 0.9, `${field}: ${correct}/30`);
  }

  const alternativeAge = actualByExternalId.get("bizinfo:PBLN_000000000098770");
  assert.deepEqual([alternativeAge?.age_min, alternativeAge?.age_max], [null, null]);
  const scopedIncome = actualByExternalId.get("social_security:WII0000345");
  assert.equal(scopedIncome?.median_income_percent_max, null);
  assert(
    scopedIncome?.extra_conditions.some(({ kind }) => kind === "household_income_scopes"),
  );
  assert.deepEqual(ingest.report.parse.fieldHits, {
    age_min: 12,
    age_max: 9,
    regions: 5,
    occupations: 8,
    median_income_percent_max: 9,
  });
  assert.equal(ingest.report.parse.withExtraConditions, 14);
  assert.equal(Number(ingest.report.parse.meanConfidence.toFixed(3)), 0.684);

  await ingest.run(collectors);
  assert.equal(ingest.report.totals.updated, 0);
  assert.equal(ingest.report.totals.unchanged, 30);
  assert.equal(db.rawDocuments.length, 30);
});
