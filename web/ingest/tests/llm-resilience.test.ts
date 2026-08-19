/**
 * 배치 LLM 장애 내성 (SPEC §8 신뢰성).
 *
 * 요청 경로에는 LLM 이 없으므로(§7.5) LLM 장애가 응답 실패로 전이되지는 않는다.
 * 문제는 조용한 쪽이다 — 배치가 멈추면 신규·수정 공고의 요약·신청절차가 생성되지 않고,
 * 예전 구현은 그 건들을 아예 비활성화해 **결과에서 사라지게** 만들었다.
 * 심사 구간(9/7~9/11)에 발현되면 치명적이므로 여기서 못 박아 둔다.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { InMemoryDatabase } from "../db";
import { Embedder } from "../embedder";
import { CollectedProgram, EligibilityRules } from "../models";
import { Pipeline } from "../pipeline";
import { settingsFromEnv } from "../config";
import { Collector, CollectorError } from "../collectors/base";
import {
  LLM_MAX_ATTEMPTS,
  LLMFallback,
  Summarizer,
  backoffMs,
  fallbackModels,
  LLM_MAX_BACKOFF_MS,
} from "../llm";

const settings = settingsFromEnv({ NODE_ENV: "test" });

/** 대기를 없앤다 — 백오프 로직은 별도로 검증하고, 여기서는 흐름만 본다 */
const noSleep = async () => {};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function toolCall(name: string, args: unknown) {
  return {
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          tool_calls: [{ type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  };
}

const VALID_CARD = toolCall("emit_card_copy", {
  summary: "청년에게 전월세 보증금을 저리로 대출",
  apply_steps: ["자격을 확인합니다.", "온라인으로 신청합니다.", "결과를 확인합니다."],
});

const PROGRAM = {
  title: "청년 전월세보증금 대출 지원",
  body_text: "청년의 전월세 보증금을 저리로 대출합니다. 무주택 세대주가 대상입니다.",
  apply_method: "온라인 신청",
  apply_url: "https://example.test/apply",
};

/* ------------------------------------------------------------------ 재시도 */

test("일시적 실패는 재시도로 넘긴다 (429 → 성공)", async () => {
  const models: string[] = [];
  let calls = 0;
  const summarizer = new Summarizer(
    { openrouterApiKey: "k", sleep: noSleep },
    async (_url, init) => {
      calls++;
      models.push(JSON.parse(String(init?.body)).model);
      return calls === 1
        ? jsonResponse({ error: "rate limited" }, 429, { "retry-after": "1" })
        : jsonResponse(VALID_CARD);
    },
  );

  const card = await summarizer.generate(PROGRAM);
  assert.equal(calls, 2);
  assert.equal(card.method, "llm");
  assert.equal(summarizer.failures, 0);
  // 같은 모델로 재시도해야 한다 — 첫 실패에 곧바로 모델을 갈아타면 폴백이 낭비된다
  assert.deepEqual(new Set(models).size, 1);
});

test("네트워크 오류도 재시도 대상이며, 소진되면 실패로 계상한다", async () => {
  let calls = 0;
  const summarizer = new Summarizer(
    { openrouterApiKey: "k", sleep: noSleep },
    async () => {
      calls++;
      throw new Error("ECONNRESET");
    },
  );

  const card = await summarizer.generate(PROGRAM);
  assert.equal(calls, LLM_MAX_ATTEMPTS);
  assert.equal(card.method, "mock");
  assert.equal(summarizer.failures, 1);
});

/* ------------------------------------------------------------- 모델 폴백 */

test("기본 모델이 소진되면 대체 모델로 넘어간다", async () => {
  const tried: string[] = [];
  const summarizer = new Summarizer(
    {
      openrouterApiKey: "k",
      model: "primary/free",
      fallbackModels: ["backup/paid"],
      sleep: noSleep,
    },
    async (_url, init) => {
      const model = JSON.parse(String(init?.body)).model as string;
      tried.push(model);
      // 무료 티어가 통째로 내려간 상황
      return model === "primary/free"
        ? jsonResponse({ error: "model unavailable" }, 503)
        : jsonResponse(VALID_CARD);
    },
  );

  const card = await summarizer.generate(PROGRAM);
  assert.deepEqual(tried, [
    "primary/free",
    "primary/free",
    "primary/free",
    "backup/paid",
  ]);
  assert.equal(card.method, "llm");
  assert.equal(summarizer.failures, 0);
});

test("인증·크레딧 오류는 폴백을 돌지 않고 즉시 포기한다", async () => {
  let calls = 0;
  const summarizer = new Summarizer(
    {
      openrouterApiKey: "bad",
      model: "primary/free",
      fallbackModels: ["backup/paid", "third/model"],
      sleep: noSleep,
    },
    async () => {
      calls++;
      return jsonResponse({ error: "no credits" }, 402);
    },
  );

  const card = await summarizer.generate(PROGRAM);
  // 모델을 바꿔도 결과가 같으므로 한 번만 시도한다 — 배치 시간을 낭비하지 않는다
  assert.equal(calls, 1);
  assert.equal(card.method, "mock");
  assert.equal(summarizer.failures, 1);
});

test("LLM_FALLBACK_MODELS 환경변수로 대체 모델을 지정한다", () => {
  assert.deepEqual(fallbackModels({ NODE_ENV: "test" }), []);
  assert.deepEqual(fallbackModels({ NODE_ENV: "test", LLM_FALLBACK_MODELS: "" }), []);
  assert.deepEqual(fallbackModels({ NODE_ENV: "test", LLM_FALLBACK_MODELS: " a/b , c/d ,, " }), ["a/b", "c/d"]);
});

/* ------------------------------------------------------------- 백오프 */

test("백오프는 지수적으로 늘고 상한을 넘지 않는다", () => {
  // 지터가 섞이므로 구간으로 확인한다
  assert.ok(backoffMs(0, null) >= 500 && backoffMs(0, null) < 1_000);
  assert.ok(backoffMs(1, null) >= 1_000 && backoffMs(1, null) < 1_500);
  assert.ok(backoffMs(2, null) >= 2_000 && backoffMs(2, null) < 2_500);
  assert.equal(backoffMs(20, null), LLM_MAX_BACKOFF_MS);
  // Retry-After 를 우선하되 상한은 지킨다 — 배치가 한 건 때문에 멈추지 않게
  assert.equal(backoffMs(0, 3), 3_000);
  assert.equal(backoffMs(0, 9_999), LLM_MAX_BACKOFF_MS);
});

/* ---------------------------------------------- 폴백 카드가 비지 않는다 */

test("LLM 이 완전히 죽어도 카드 문구는 비지 않는다", async () => {
  const summarizer = new Summarizer({ openrouterApiKey: "k", sleep: noSleep }, async () =>
    jsonResponse({ error: "down" }, 500),
  );
  const card = await summarizer.generate(PROGRAM);

  assert.equal(card.method, "mock");
  assert.ok(card.summary.length > 0, "요약이 비어 있으면 카드가 제목만 남는다");
  assert.equal(card.apply_steps.length, 3);
  assert.ok(card.apply_steps.every((step) => step.trim().length > 0));
});

/* ------------------------------------------- 파이프라인: 숨기지 않는다 */

class FakeCollector extends Collector {
  readonly sourceKey = "fake";
  readonly endpoint = "https://example.test";
  readonly idListEndpoint = this.endpoint;

  constructor(private readonly programs: CollectedProgram[]) {
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
    return this.programs;
  }

  override async listExternalIds(): Promise<Set<string>> {
    return new Set(this.programs.map((item) => item.external_id));
  }
}

function collected() {
  return new CollectedProgram({
    external_id: "fake:001",
    source_key: "fake",
    source_url: "https://example.test/1",
    title: "청년 전월세보증금 대출 지원",
    body_text: "청년의 전월세 보증금을 저리로 대출합니다.",
    // 정규식이 못 잡는 서술이라 LLM 보완 경로로 넘어간다
    eligibility_text: "관내에 실거주하며 신용도가 양호한 무주택자",
    form: "loan",
    issuer: "국토교통부",
    benefit_amount_text: "최대 1억원",
    benefit_amount_max: 100_000_000,
    apply_url: "https://example.test/apply",
    apply_method: "온라인 신청",
  });
}

test("LLM 보완이 실패해도 공고는 활성 상태로 남고 임베딩도 만들어진다", async () => {
  const db = new InMemoryDatabase();
  const llm = new LLMFallback({ openrouterApiKey: "k", sleep: noSleep }, async () =>
    jsonResponse({ error: "down" }, 500),
  );
  const summarizer = new Summarizer({ openrouterApiKey: "k", sleep: noSleep }, async () =>
    jsonResponse({ error: "down" }, 500),
  );
  const ingest = new Pipeline(db, {
    embedder: new Embedder(settings),
    llm,
    summarizer,
    dryRun: true,
  });

  await ingest.runSource(new FakeCollector([collected()]));

  const row = db.programs.get(1);
  assert.ok(row, "공고가 적재되지 않았다");
  // 핵심: 숨기지 않는다. 예전 구현은 여기서 status='needs_review' 로 비활성화했다.
  assert.equal(row.status, "active");
  // 벡터가 없으면 의도 축(집합 B)에서 영원히 안 잡혀 사실상 숨긴 것과 같다
  assert.ok(db.embeddings.get(1)?.length, "임베딩이 생성되지 않았다");

  // 제목·금액·마감일·원문 링크는 DB 값이므로 LLM 없이 렌더된다
  assert.equal(row.title, "청년 전월세보증금 대출 지원");
  assert.equal(row.benefit_amount_text, "최대 1억원");
  assert.equal(row.source_url, "https://example.test/1");
  assert.ok(row.summary.length > 0, "폴백 요약이 비었다");
  assert.equal(row.apply_steps.length, 3);

  // 운영자는 리포트와 rules.needs_review 로 알 수 있어야 한다
  assert.equal(db.rules.get(1)?.needsReview, true);
  assert.equal(ingest.report.parse.incomplete, 1);
  assert.ok(ingest.report.llmFailures > 0);
});

test("LLM 실패율이 임계치를 넘으면 리포트가 눈에 띄게 경고한다", async () => {
  const db = new InMemoryDatabase();
  const summarizer = new Summarizer({ openrouterApiKey: "k", sleep: noSleep }, async () =>
    jsonResponse({ error: "down" }, 500),
  );
  const ingest = new Pipeline(db, {
    embedder: new Embedder(settings),
    llm: null,
    summarizer,
    dryRun: true,
  });
  await ingest.runSource(new FakeCollector([collected()]));

  assert.equal(ingest.report.llmDegraded, true);
  const { renderReport, reportToJson } = await import("../pipeline");
  assert.match(renderReport(ingest.report), /경고: LLM 실패율/);
  assert.match(renderReport(ingest.report), /LLM_FALLBACK_MODELS/);
  const json = reportToJson(ingest.report) as { llm_failures: { degraded: boolean } };
  assert.equal(json.llm_failures.degraded, true);
});

test("불완전 추출은 노출을 막지 않는다 — 규칙 자체의 계약", () => {
  const failed = new EligibilityRules({ needs_review: true, review_reason: "llm_failed" });
  const rejected = new EligibilityRules({
    needs_review: true,
    review_reason: "llm_validation_rejected",
  });
  const clean = new EligibilityRules({ age_min: 19 });

  assert.equal(failed.incompleteExtraction, true);
  assert.equal(rejected.incompleteExtraction, true);
  assert.equal(clean.incompleteExtraction, false);
  // 거절된 값은 반영되지 않으므로 필드는 NULL 로 남는다 = §7.3 의 '조건 없음 = 통과'
  assert.equal(rejected.age_min, null);
  assert.equal(rejected.age_max, null);
});

test("수집기 장애는 여전히 직전 스냅샷을 유지한다 (회귀 방지)", async () => {
  const db = new InMemoryDatabase();
  class Broken extends FakeCollector {
    override async fetch(): Promise<CollectedProgram[]> {
      throw new CollectorError("소스 장애");
    }
  }
  const ingest = new Pipeline(db, {
    embedder: new Embedder(settings),
    llm: null,
    dryRun: true,
  });
  await ingest.runSource(new FakeCollector([collected()]));
  await ingest.runSource(new Broken([]));
  assert.equal(db.programs.get(1)?.status, "active");
});
