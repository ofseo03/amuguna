import assert from "node:assert/strict";
import test from "node:test";

import {
  BizinfoCollector,
  CollectorError,
  FinlifeCollector,
  SocialSecurityCollector,
} from "../collectors";
import { USER_AGENT } from "../collectors/base";
import { settingsFromEnv } from "../config";
import { parseProgram } from "../parser";

test("collector User-Agent is a valid ASCII HTTP header", () => {
  assert.match(USER_AGENT, /^[\x20-\x7e]+$/);
});

test("central welfare XML joins detail eligibility before regex parsing", async () => {
  const list = `<?xml version="1.0" encoding="UTF-8"?>
    <wantedList><servList>
      <jurMnofNm>금융위원회</jurMnofNm><jurOrgNm>서민금융과</jurOrgNm>
      <onapPsbltYn>N</onapPsbltYn><servDgst>청년 금융 지원</servDgst>
      <servDtlLink>https://example.test/detail?a=1&amp;b=2</servDtlLink>
      <servId>WLF00001076</servId><servNm>햇살론 youth 보증사업</servNm>
      <srvPvsnNm>대여</srvPvsnNm>
    </servList><totalCount>1</totalCount><resultCode>0</resultCode><resultMessage>SUCCESS</resultMessage></wantedList>`;
  const detail = `<?xml version="1.0" encoding="UTF-8"?>
    <wantedDtl><servId>WLF00001076</servId><servNm>햇살론 youth 보증사업</servNm>
      <jurMnofNm>금융위원회 서민금융과</jurMnofNm>
      <tgtrDtlCn>만 19세 이상 ~ 34세 이하이면서 연소득 3,500만원 이하인 대학생, 청년에게 지원합니다.&#13;추가 심사를 진행합니다.</tgtrDtlCn>
      <slctCritCn>만 34세 이하의 취업준비생 또는 중소기업 1년 이하 재직자 또는 개인사업자(창업 1년 인내인 자)를 지원합니다.</slctCritCn>
      <alwServCn>보증한도 내에서 대출을 지원합니다.</alwServCn>
      <applmetList><servSeDetailLink>서민금융진흥원에서 신청</servSeDetailLink></applmetList>
      <resultCode>0</resultCode><resultMessage>SUCCESS</resultMessage>
    </wantedDtl>`;
  const requests: URL[] = [];
  const collector = new SocialSecurityCollector({
    settings: settingsFromEnv({ NODE_ENV: "test", DATA_GO_KR_API_KEY: "test-key" }),
    pageSize: 1,
    retries: 0,
    fetchImpl: async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(url);
      return new Response(url.pathname.endsWith("NationalWelfaredetailedV001") ? detail : list, {
        headers: { "Content-Type": "application/xml" },
      });
    },
  });

  const [program] = await collector.fetch({ maxPages: 1 });
  assert.equal(requests.length, 2);
  assert.match(requests[0].pathname, /NationalWelfarelistV001$/);
  assert.match(requests[1].pathname, /NationalWelfaredetailedV001$/);
  assert.equal(requests[1].searchParams.get("servId"), "WLF00001076");
  assert.equal(program.source_url, "https://example.test/detail?a=1&b=2");
  assert.equal(program.apply_url, "");
  assert.match(program.eligibility_text, /추가 심사를 진행합니다\./);
  assert.doesNotMatch(program.eligibility_text, /&#13;/);

  const rules = parseProgram(program);
  assert.deepEqual([rules.age_min, rules.age_max], [19, 34]);
  assert.equal(rules.occupations, null);
  assert(rules.extra_conditions.some(({ kind }) => kind === "alternative_constraints"));
  const kinds = new Set(rules.extra_conditions.map(({ kind }) => kind));
  assert(["income_amount", "employment_period", "business_history"].every((kind) => kinds.has(kind)));
});

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
      bizinfo_api_key: "",
      finlife_api_key: "",
      openrouter_api_key: "",
      embedding_provider: "mock",
      embedding_api_key: "",
      mock_embeddings: true,
    },
    retries: 0,
    fetchImpl: async () => Response.json({ response: { body: { items: {} } } }),
  });

  await assert.rejects(collector.fetch(), CollectorError);
});

test("JSON collectors retry a malformed successful response", async () => {
  let calls = 0;
  const collector = new BizinfoCollector({
    settings: settingsFromEnv({ NODE_ENV: "test", BIZINFO_API_KEY: "test-key" }),
    retries: 1,
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? new Response("{", { headers: { "Content-Type": "application/json" } })
        : Response.json({ resultCode: "0000", jsonArray: [] });
    },
  });
  await collector.fetch({ maxPages: 1 });
  assert.equal(calls, 2);
});

test("live collectors send each source its own API key", async () => {
  const settings = settingsFromEnv({
    NODE_ENV: "test",
    DATA_GO_KR_API_KEY: "social-key",
    BIZINFO_API_KEY: "bizinfo-key",
    FINLIFE_API_KEY: "finlife-key",
  });
  const cases = [
    {
      collector: SocialSecurityCollector,
      parameter: "serviceKey",
      key: "social-key",
      payload: "<wantedList><resultCode>0</resultCode><resultMessage>SUCCESS</resultMessage></wantedList>",
    },
    {
      collector: BizinfoCollector,
      parameter: "crtfcKey",
      key: "bizinfo-key",
      payload: { resultCode: "0000", jsonArray: [] },
    },
    {
      collector: FinlifeCollector,
      parameter: "auth",
      key: "finlife-key",
      payload: { result: { err_cd: "000", baseList: [] } },
    },
  ];

  for (const testCase of cases) {
    const requests: URL[] = [];
    const collector = new testCase.collector({
      settings,
      retries: 0,
      fetchImpl: async (input) => {
        requests.push(new URL(input instanceof Request ? input.url : String(input)));
        return typeof testCase.payload === "string"
          ? new Response(testCase.payload, { headers: { "Content-Type": "application/xml" } })
          : Response.json(testCase.payload);
      },
    });
    await collector.fetch({ maxPages: 1 });
    assert.equal(requests[0]?.searchParams.get(testCase.parameter), testCase.key);
  }
});
