import assert from "node:assert/strict";
import test from "node:test";

import {
  BizinfoCollector,
  CollectorError,
  FinlifeCollector,
  SocialSecurityCollector,
} from "../collectors";

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

test("an empty malformed envelope is an error, not a successful last page", async () => {
  const collector = new SocialSecurityCollector({
    settings: {
      database_url: "",
      data_go_kr_api_key: "test-key",
      anthropic_api_key: "",
      embedding_provider: "mock",
      embedding_api_key: "",
      mock_embeddings: true,
    },
    retries: 0,
    fetchImpl: async () => Response.json({ response: { body: { items: {} } } }),
  });

  await assert.rejects(collector.fetch(), CollectorError);
});
