import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import postgres from "postgres";

import {
  InMemoryDatabase,
  PostgresDatabase,
  postgresOptions,
  type ProgramValues,
  type RuleValues,
} from "../db";
import { chunkText, Embedder } from "../embedder";
import { EMBEDDING_DIM, embedQuery, VOYAGE_MODEL } from "../../src/lib/embedding";
import { buildCardCopy } from "../card-copy";

const now = new Date("2026-08-10T00:00:00Z");

test("batch database verifies TLS with PGSSLROOTCERT", () => {
  const directory = mkdtempSync(join(tmpdir(), "amuguna-ca-"));
  const certificate = join(directory, "ca.crt");
  const original = process.env.PGSSLROOTCERT;
  writeFileSync(certificate, "TEST_CA", "utf8");
  try {
    process.env.PGSSLROOTCERT = certificate;
    assert.deepEqual(postgresOptions("postgresql://example.test/postgres").ssl, {
      ca: "TEST_CA",
      rejectUnauthorized: true,
    });
  } finally {
    if (original === undefined) delete process.env.PGSSLROOTCERT;
    else process.env.PGSSLROOTCERT = original;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("explicit sslmode in URL and keyword DSNs wins over PGSSLROOTCERT", async () => {
  const directory = mkdtempSync(join(tmpdir(), "amuguna-ca-"));
  const certificate = join(directory, "ca.crt");
  const original = process.env.PGSSLROOTCERT;
  writeFileSync(certificate, "TEST_CA", "utf8");
  try {
    process.env.PGSSLROOTCERT = certificate;
    for (const mode of ["disable", "allow", "prefer", "require", "verify-full"]) {
      const dsn = `postgresql://example.test/postgres?sslmode=${mode}`;
      assert.equal(postgresOptions(dsn).ssl, undefined);
      const sql = postgres(dsn, postgresOptions(dsn));
      assert.equal(sql.options.ssl, mode === "disable" ? false : mode);
      await sql.end();
    }
    assert.equal(
      postgresOptions("host=example.test dbname=postgres sslmode=disable").ssl,
      undefined,
    );
  } finally {
    if (original === undefined) delete process.env.PGSSLROOTCERT;
    else process.env.PGSSLROOTCERT = original;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("embedding replacement rolls back an incomplete chunk set", async () => {
  let rows = ["old"];
  let inserts = 0;
  const transaction = (async (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    if (query.includes("DELETE FROM program_embeddings")) rows = [];
    if (query.includes("INSERT INTO program_embeddings")) {
      if (++inserts === 2) throw new Error("insert failed");
      rows.push("new");
    }
    return [];
  }) as unknown as postgres.TransactionSql;
  const root = Object.assign(
    () => Promise.resolve([]),
    {
      begin: async <T>(fn: (sql: postgres.TransactionSql) => Promise<T>): Promise<T> => {
        const snapshot = [...rows];
        try {
          return await fn(transaction);
        } catch (error) {
          rows = snapshot;
          throw error;
        }
      },
    },
  ) as unknown as ReturnType<typeof postgres>;
  const db = new PostgresDatabase("", root);

  await assert.rejects(db.replaceEmbeddings(1, [[1], [2]], "mock"), /insert failed/);
  assert.deepEqual(rows, ["old"]);
});

function program(rawDocumentId: number, status: ProgramValues["status"] = "active"): ProgramValues {
  return {
    external_id: "fake:001",
    raw_document_id: rawDocumentId,
    title: "청년 주거 지원",
    body_text: "청년의 주거비를 지원합니다.",
    summary: "청년 주거비 지원",
    apply_steps: ["확인", "신청", "결과 확인"],
    form: "subsidy",
    issuer: "서울특별시",
    issuer_level: "metro",
    benefit_amount_text: "월 최대 20만원",
    benefit_amount_min: null,
    benefit_amount_max: 200_000,
    apply_url: "https://example.test/apply",
    apply_method: "온라인 신청",
    starts_at: "2026-01-01",
    ends_at: "2026-12-31",
    is_always_open: false,
    source_url: "https://example.test/1",
    fetched_at: now,
    status,
  };
}

const rule: RuleValues = {
  age_min: 19,
  age_max: 34,
  gender: null,
  regions: ["11"],
  occupations: null,
  income_decile_max: null,
  median_income_percent_max: null,
  extra_conditions: [],
  parse_method: "regex",
  parse_evidence: {},
  confidence: 1,
};

test("in-memory DB keeps raw versions, stable program IDs, and expiry state", async () => {
  const db = new InMemoryDatabase();
  const raw1 = await db.insertRawDocument({
    external_id: "fake:001",
    source_key: "fake",
    source_url: "https://example.test/1",
    content_hash: "v1",
    raw_body: { version: 1 },
    fetched_at: now,
  });
  const id = await db.upsertProgram(program(raw1));
  await db.replaceRules(id, rule);
  await db.replaceEmbeddings(id, [[1, 0], [0, 1]], "mock");
  assert.equal(await db.embeddingProvider(id), "mock");

  const later = new Date("2026-08-11T00:00:00Z");
  const raw2 = await db.insertRawDocument({
    external_id: "fake:001",
    source_key: "fake",
    source_url: "https://example.test/1",
    content_hash: "v2",
    raw_body: { version: 2 },
    fetched_at: later,
  });
  assert.equal(await db.upsertProgram({ ...program(raw2), fetched_at: later }), id);
  assert.equal(await db.latestContentHash("fake:001"), "v2");
  assert.equal(db.rawDocuments.length, 2);

  assert.equal(await db.expirePrograms(["fake:001"]), 1);
  assert.equal(db.embeddings.has(id), false);
  assert.deepEqual(await db.reactivateProgram("fake:001", later), [
    "청년 주거 지원",
    "청년 주거비 지원",
    "청년의 주거비를 지원합니다.",
  ]);
});

test("in-memory record transaction rolls failed writes back", async () => {
  const db = new InMemoryDatabase();
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.insertRawDocument({
        external_id: "fake:bad",
        source_key: "fake",
        source_url: "",
        content_hash: "bad",
        raw_body: {},
        fetched_at: now,
      });
      throw new Error("record failed");
    }),
  );
  assert.equal(db.rawDocuments.length, 0);
});

test("chunking prepends card context and mock embedding keeps 1024 dimensions", async () => {
  const chunks = chunkText("본문 문단입니다.", { title: "제목", summary: "요약" });
  assert.equal(chunks[0], "제목\n요약\n본문 문단입니다.");
  const result = await new Embedder({ mockEmbeddings: true }).embedProgram({
    title: "제목",
    summary: "요약",
    body: "본문 문단입니다.",
  });
  assert.equal(result.provider, "mock");
  assert.equal(result.vectors[0].length, 1024);
});

test("Voyage uses one 1024-dimensional model for documents and queries", async () => {
  const originalProvider = process.env.EMBEDDING_PROVIDER;
  const originalKey = process.env.EMBEDDING_API_KEY;
  const originalMock = process.env.MOCK_EMBEDDINGS;
  const originalFetch = globalThis.fetch;
  const requests: Record<string, unknown>[] = [];
  try {
    process.env.EMBEDDING_PROVIDER = "voyage";
    process.env.EMBEDDING_API_KEY = "test";
    delete process.env.MOCK_EMBEDDINGS;
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "https://api.voyageai.com/v1/embeddings");
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({
        data: [{ embedding: [1, ...new Array(EMBEDDING_DIM - 1).fill(0)] }],
      });
    };

    await new Embedder({ embeddingProvider: "voyage", embeddingApiKey: "test" }).embedTexts([
      "지원사업 문서",
    ]);
    await embedQuery("주거 지원");

    assert.deepEqual(
      requests.map(({ model, input_type, output_dimension }) => ({
        model,
        input_type,
        output_dimension,
      })),
      [
        { model: VOYAGE_MODEL, input_type: "document", output_dimension: EMBEDDING_DIM },
        { model: VOYAGE_MODEL, input_type: "query", output_dimension: EMBEDDING_DIM },
      ],
    );
  } finally {
    if (originalProvider === undefined) delete process.env.EMBEDDING_PROVIDER;
    else process.env.EMBEDDING_PROVIDER = originalProvider;
    if (originalKey === undefined) delete process.env.EMBEDDING_API_KEY;
    else process.env.EMBEDDING_API_KEY = originalKey;
    if (originalMock === undefined) delete process.env.MOCK_EMBEDDINGS;
    else process.env.MOCK_EMBEDDINGS = originalMock;
    globalThis.fetch = originalFetch;
  }
});

test("real embedding configuration fails instead of mixing in mock vectors", async () => {
  const embedder = new Embedder({
    embeddingProvider: "openai",
    embeddingApiKey: "",
    mockEmbeddings: false,
  });
  await assert.rejects(embedder.embedTexts(["본문"]), /EMBEDDING_API_KEY/);

  const sharedSettings = new Embedder({
    embedding_provider: "openai",
    embedding_api_key: "",
    mock_embeddings: true,
  });
  assert.equal(sharedSettings.provider, "openai");
  await assert.rejects(sharedSettings.embedTexts(["본문"]), /EMBEDDING_API_KEY/);
});

test("card copy is deterministic and bounded", () => {
  const card = buildCardCopy({
    title: "지원 사업",
    body_text: "청년의 주거비를 지원합니다. 자세한 내용은 공고를 확인하세요.",
    apply_method: "온라인 신청",
  });
  assert.deepEqual(card, {
    summary: "청년의 주거비를 지원합니다.",
    apply_steps: [
      "자격요건과 제출서류를 확인합니다.",
      "온라인 신청을 진행합니다.",
      "심사 결과와 지급 일정을 소관 기관에서 확인합니다.",
    ],
  });
  assert.ok(buildCardCopy({ body_text: "가".repeat(200) }).summary.length <= 40);
});
