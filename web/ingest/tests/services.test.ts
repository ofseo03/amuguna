import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryDatabase, type ProgramValues, type RuleValues } from "../db";
import { chunkText, Embedder } from "../embedder";
import {
  applyFallback,
  LLMFallback,
  mockCardCopy,
  revalidate,
  Summarizer,
  type FallbackRules,
  type LlmClient,
} from "../llm";

const now = new Date("2026-08-10T00:00:00Z");

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
    parse_method: "regex",
    parse_evidence: {},
    confidence: 0,
    needs_review: false,
    review_reason: null,
  };
}

function stubClient(input: Record<string, unknown> | Error): LlmClient {
  return {
    messages: {
      create: async () => {
        if (input instanceof Error) throw input;
        return { content: [{ type: "tool_use", input }] };
      },
    },
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
      { anthropicApiKey: "test", model: "test-model" },
      stubClient({
        age_min: 99,
        income_decile_max: 5,
        evidence: { income_decile_max: "중위소득 100% 이하" },
      }),
    ),
  );
  assert.equal(rules.age_min, 19);
  assert.equal(rules.income_decile_max, 5);
  assert.equal(rules.parse_method, "llm");
});

test("missing LLM key is deterministic and does not block the whole service", async () => {
  const rules = emptyRules();
  await applyFallback(rules, "자격은 공고문 참고", new LLMFallback({ anthropicApiKey: "" }));
  assert.equal(rules.review_reason, "llm_unavailable");

  const card = await new Summarizer({ anthropicApiKey: "" }).generate({
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
    { anthropicApiKey: "test" },
    stubClient({ summary: "가".repeat(200), apply_steps: ["하나", "둘", "셋"] }),
  );
  const card = await summarizer.generate({ title: "제목", body_text: "본문" });
  assert.equal(card.method, "llm");
  assert.ok(card.summary.length <= 40);
});
