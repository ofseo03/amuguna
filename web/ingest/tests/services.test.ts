import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemoryDatabase, postgresOptions, type ProgramValues, type RuleValues } from "../db";
import { chunkText, Embedder } from "../embedder";
import { EMBEDDING_DIM, embedQuery, VOYAGE_MODEL } from "../../src/lib/embedding";
import {
  applyFallback,
  LLMFallback,
  mockCardCopy,
  revalidate,
  Summarizer,
  type FallbackRules,
  type LlmFetch,
} from "../llm";
import { parseEligibility } from "../parser";

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

function emptyRules(): FallbackRules {
  return {
    age_min: null,
    age_max: null,
    gender: null,
    regions: null,
    occupations: null,
    income_decile_max: null,
    median_income_percent_max: null,
    parse_method: "regex",
    parse_evidence: {},
    confidence: 0,
    needs_review: false,
    review_reason: null,
  };
}

function stubFetch(
  input: Record<string, unknown> | string | Error,
  toolName = "emit_eligibility",
): LlmFetch {
  return async (url, init) => {
    assert.equal(String(url), "https://openrouter.ai/api/v1/chat/completions");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test");
    const request = JSON.parse(String(init?.body));
    assert.equal(request.tools[0].type, "function");
    assert.equal(request.tool_choice.function.name, toolName);
    if (input instanceof Error) throw input;
    return Response.json({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          tool_calls: [{
            type: "function",
            function: {
              name: toolName,
              arguments: typeof input === "string" ? input : JSON.stringify(input),
            },
          }],
        },
      }],
    });
  };
}

test("LLM fields are server-revalidated and regex values are not overwritten", async () => {
  assert.deepEqual(revalidate({ regions: ["11620"], occupations: ["self_employed"] }), {
    clean: { regions: ["11620"], occupations: ["self_employed"] },
    rejected: [],
  });
  assert.deepEqual(revalidate({ regions: ["99999"], occupations: ["astronaut"] }).rejected.sort(), [
    "occupations",
    "regions",
  ]);

  const rules = emptyRules();
  rules.age_min = 19;
  await applyFallback(
    rules,
    "만 19세 이상이며 소득 기준은 붙임 참조",
    new LLMFallback(
      { openrouterApiKey: "test", model: "test-model" },
      stubFetch({
        age_min: 99,
        median_income_percent_max: 100,
        evidence: { median_income_percent_max: "중위소득 100% 이하" },
      }),
    ),
  );
  assert.equal(rules.age_min, 19);
  assert.equal(rules.median_income_percent_max, 100);
  assert.equal(rules.parse_method, "llm");
});

test("LLM cannot restore parser-rejected hard filters", async () => {
  const rules = parseEligibility(
    "일반 농업인 또는 기초생활수급자 등 저소득 농업인 단체를 지원합니다.",
  );
  assert.equal(rules.income_decile_max, null);
  await applyFallback(
    rules,
    "일반 농업인 또는 기초생활수급자 등 저소득 농업인 단체",
    new LLMFallback(
      { openrouterApiKey: "test", model: "test-model" },
      stubFetch({
        income_decile_max: 2,
        median_income_percent_max: 50,
        evidence: { income_decile_max: "기초생활수급자" },
      }),
    ),
  );
  assert.equal(rules.income_decile_max, null);
  assert.equal(rules.median_income_percent_max, null);
});

test("missing LLM key is deterministic and does not block the whole service", async () => {
  const rules = emptyRules();
  await applyFallback(rules, "자격은 공고문 참고", new LLMFallback({ openrouterApiKey: "" }));
  assert.equal(rules.review_reason, "llm_unavailable");

  const card = await new Summarizer({ openrouterApiKey: "" }).generate({
    title: "지원 사업",
    body_text: "청년의 주거비를 지원합니다. 자세한 내용은 공고를 확인하세요.",
    apply_method: "온라인 신청",
  });
  assert.deepEqual(card, mockCardCopy({
    title: "지원 사업",
    body_text: "청년의 주거비를 지원합니다. 자세한 내용은 공고를 확인하세요.",
    apply_method: "온라인 신청",
  }));
  assert.equal(card.apply_steps.length, 3);
});

test("summarizer revalidates tool output and truncates overlong copy", async () => {
  const summarizer = new Summarizer(
    { openrouterApiKey: "test" },
    stubFetch(
      { summary: "가".repeat(200), apply_steps: ["하나", "둘", "셋"] },
      "emit_card_copy",
    ),
  );
  const card = await summarizer.generate({ title: "제목", body_text: "본문" });
  assert.equal(card.method, "llm");
  assert.ok(card.summary.length <= 40);
});

test("invalid or failed OpenRouter responses fall back safely", async () => {
  const rules = emptyRules();
  await applyFallback(
    rules,
    "자격은 공고문 참고",
    new LLMFallback({ openrouterApiKey: "test" }, stubFetch("{bad json")),
  );
  assert.equal(rules.review_reason, "llm_failed");

  const program = { title: "지원 사업", body_text: "청년의 주거비를 지원합니다." };
  const card = await new Summarizer(
    { openrouterApiKey: "test" },
    stubFetch(new Error("network"), "emit_card_copy"),
  ).generate(program);
  assert.deepEqual(card, mockCardCopy(program));
});

test("OpenRouter transient failures are retried once", async () => {
  let calls = 0;
  const success = stubFetch(
    { summary: "청년 주거비 지원", apply_steps: ["확인", "신청", "결과 확인"] },
    "emit_card_copy",
  );
  const transient: LlmFetch = async (url, init) => {
    calls++;
    return calls === 1 ? new Response(null, { status: 503 }) : success(url, init);
  };
  const card = await new Summarizer({ openrouterApiKey: "test" }, transient).generate({
    title: "지원 사업",
    body_text: "청년의 주거비를 지원합니다.",
  });
  assert.equal(calls, 2);
  assert.equal(card.method, "llm");
});
