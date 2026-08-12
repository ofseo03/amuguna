import assert from "node:assert/strict";
import test from "node:test";

import {
  BizinfoCollector,
  CollectorError,
  type FetchLike,
  FinlifeCollector,
  SocialSecurityCollector,
} from "../collectors";
import { settingsFromEnv, type Settings } from "../config";

test("three fixture envelopes map all 27 unique records", async () => {
  const collectors = [
    new SocialSecurityCollector({ useFixtures: true }),
    new BizinfoCollector({ useFixtures: true }),
    new FinlifeCollector({ useFixtures: true }),
  ];
  const programs = (await Promise.all(collectors.map((collector) => collector.fetch()))).flat();

  assert.equal(programs.length, 27);
  assert.equal(new Set(programs.map((program) => program.external_id)).size, 27);
  assert.ok(programs.every((program) => program.title && program.source_url));
  const fixedRate = programs.find(
    (program) => program.external_id === "finlife:0010001-KB-YOUTH-01",
  );
  assert.match(fixedRate?.body_text ?? "", /최고 5\.0%/);
});

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    database_url: "",
    data_go_kr_api_key: "",
    bizinfo_api_key: "",
    finlife_api_key: "",
    anthropic_api_key: "",
    embedding_provider: "mock",
    embedding_api_key: "",
    mock_embeddings: true,
    ...overrides,
  };
}

test("settings read canonical issuer-key environment variables", () => {
  const configured = settingsFromEnv({
    NODE_ENV: "test",
    BIZINFO_API_KEY: "bizinfo-test-key",
    FINLIFE_API_KEY: "finlife-test-key",
  });

  assert.equal(configured.bizinfo_api_key, "bizinfo-test-key");
  assert.equal(configured.finlife_api_key, "finlife-test-key");
});

test("an empty malformed envelope is an error, not a successful last page", async () => {
  const collector = new SocialSecurityCollector({
    settings: settings({ data_go_kr_api_key: "test-key" }),
    retries: 0,
    fetchImpl: async () => Response.json({ response: { body: { items: {} } } }),
  });

  await assert.rejects(collector.fetch(), CollectorError);
});

// 세 소스의 인증키 발급처는 서로 다르다 (SPEC §3.5). 포털 키 하나로 전부 부르면
// 기업마당·금감원은 남의 키를 보내게 되고, 실패는 인증 오류로만 드러나 원인을 찾기 어렵다.
test("each collector demands the key from its own issuer", async () => {
  const portalOnly = settings({ data_go_kr_api_key: "portal-key" });
  const notCalled: FetchLike = async () => {
    throw new Error("인증키 미설정인데 호출이 나갔다");
  };

  for (const [Collector, envName] of [
    [BizinfoCollector, "BIZINFO_API_KEY"],
    [FinlifeCollector, "FINLIFE_API_KEY"],
  ] as const) {
    await assert.rejects(
      new Collector({ settings: portalOnly, fetchImpl: notCalled }).fetch(),
      (error: unknown) =>
        error instanceof CollectorError && new RegExp(`${envName} 미설정`).test(error.message),
      `${envName} 를 요구해야 한다`,
    );
  }

  // 반대 방향 — 자체 창구 키만 있고 포털 키가 없으면 포털 소스가 멈춘다
  await assert.rejects(
    new SocialSecurityCollector({
      settings: settings({ bizinfo_api_key: "b", finlife_api_key: "f" }),
      fetchImpl: notCalled,
    }).fetch(),
    /DATA_GO_KR_API_KEY 미설정/,
  );
});
