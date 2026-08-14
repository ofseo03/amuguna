import assert from "node:assert/strict";
import test from "node:test";

import {
  BizinfoCollector,
  CollectorError,
  FinlifeCollector,
  Gov24Collector,
  KstartupCollector,
  LocalWelfareCollector,
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

  const [program] = await collector.fetch({ since: "2026-08-01", maxPages: 1 });
  assert.equal(requests.length, 2);
  assert.match(requests[0].pathname, /NationalWelfarelistV001$/);
  assert.equal(requests[0].searchParams.has("since"), false);
  assert.match(requests[1].pathname, /NationalWelfaredetailedV001$/);
  assert.equal(requests[1].searchParams.get("servId"), "WLF00001076");
  assert.equal(program.source_url, "https://example.test/detail?a=1&b=2");
  assert.equal(program.apply_url, "");
  assert.match(program.eligibility_text, /추가 심사를 진행합니다\./);
  assert.equal(collector.incrementalStrategy, "full_list_known_ids_detail_budget");
  assert.doesNotMatch(program.eligibility_text, /&#13;/);

  const rules = parseProgram(program);
  assert.deepEqual([rules.age_min, rules.age_max], [19, 34]);
  assert.equal(rules.occupations, null);
  assert(rules.extra_conditions.some(({ kind }) => kind === "alternative_constraints"));
  const kinds = new Set(rules.extra_conditions.map(({ kind }) => kind));
  assert(["income_amount", "employment_period", "business_history"].every((kind) => kinds.has(kind)));
});

test("central welfare detail calls stay inside the daily quota and checkpoint on failure", async () => {
  const ids = ["WLF00000001", "WLF00000002", "WLF00000003"];
  const list = `<?xml version="1.0" encoding="UTF-8"?><wantedList>${ids
    .map(
      (id) =>
        `<servList><servId>${id}</servId><servNm>서비스 ${id}</servNm><servDgst>요약</servDgst></servList>`,
    )
    .join("")}<totalCount>${ids.length}</totalCount><resultCode>0</resultCode><resultMessage>SUCCESS</resultMessage></wantedList>`;
  const detailOf = (id: string) =>
    `<?xml version="1.0" encoding="UTF-8"?><wantedDtl><servId>${id}</servId><servNm>서비스 ${id}</servNm>` +
    `<tgtrDtlCn>만 19세 이상</tgtrDtlCn><resultCode>0</resultCode><resultMessage>SUCCESS</resultMessage></wantedDtl>`;

  const build = (options: { failOn?: string; failStatus?: number; maxDetailCalls?: number }) => {
    const detailIds: string[] = [];
    const collector = new SocialSecurityCollector({
      settings: settingsFromEnv({ NODE_ENV: "test", DATA_GO_KR_API_KEY: "test-key" }),
      pageSize: ids.length,
      retries: 0,
      maxDetailCalls: options.maxDetailCalls ?? 90,
      fetchImpl: async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (!url.pathname.endsWith("NationalWelfaredetailedV001")) {
          return new Response(list, { headers: { "Content-Type": "application/xml" } });
        }
        const id = url.searchParams.get("servId")!;
        detailIds.push(id);
        // 한도 초과 시 포털이 실제로 돌려주는 응답.
        if (id === options.failOn) return new Response("", { status: options.failStatus ?? 429 });
        return new Response(detailOf(id), { headers: { "Content-Type": "application/xml" } });
      },
    });
    return { collector, detailIds };
  };

  // 한도를 넘겨 통째로 실패하는 대신, 남은 건은 다음 회차로 미룬다.
  const capped = build({ maxDetailCalls: 2 });
  assert.equal((await capped.collector.fetch({ maxPages: 1 })).length, 2);
  assert.equal(capped.detailIds.length, 2);

  // 이미 적재된 건은 상세를 쓰지 않는다 — 한도가 신규 건으로 간다.
  const known = build({ maxDetailCalls: 2 });
  const collected = await known.collector.fetch({
    maxPages: 1,
    knownIds: new Set([`social_security:${ids[0]}`]),
  });
  assert.deepEqual(known.detailIds, [ids[1], ids[2]]);
  assert.equal(collected.length, 2);

  // 중간에 429가 나도 던지지 않고 여기까지 모은 것을 반환한다(체크포인트).
  const failing = build({ failOn: ids[1] });
  const partial = await failing.collector.fetch({ maxPages: 1 });
  assert.equal(partial.length, 1);
  assert.equal(partial[0].external_id, `social_security:${ids[0]}`);
  assert.deepEqual(failing.detailIds, ids.slice(0, 2));

  // 영구적으로 사라진 상세 한 건은 건너뛰고 뒤의 서비스를 계속 수집한다.
  const missing = build({ failOn: ids[1], failStatus: 404 });
  const afterMissing = await missing.collector.fetch({ maxPages: 1 });
  assert.deepEqual(missing.detailIds, ids);
  assert.deepEqual(
    afterMissing.map(({ external_id }) => external_id),
    [`social_security:${ids[0]}`, `social_security:${ids[2]}`],
  );

  // 포털은 논리적 호출이 아니라 HTTP 요청 수로 한도를 센다. 각 건이 1회 재시도 후
  // 성공하면 건당 2요청이므로, 예산 3으로는 두 건이 아니라 한 건만 처리해야 한다.
  let detailRequests = 0;
  const attempts = new Map<string, number>();
  const retrying = new SocialSecurityCollector({
    settings: settingsFromEnv({ NODE_ENV: "test", DATA_GO_KR_API_KEY: "test-key" }),
    pageSize: ids.length,
    retries: 1,
    maxDetailCalls: 3,
    fetchImpl: async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!url.pathname.endsWith("NationalWelfaredetailedV001")) {
        return new Response(list, { headers: { "Content-Type": "application/xml" } });
      }
      detailRequests++;
      const id = url.searchParams.get("servId")!;
      const seen = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, seen);
      if (seen === 1) return new Response("", { status: 503 }); // 재시도 대상
      return new Response(detailOf(id), { headers: { "Content-Type": "application/xml" } });
    },
  });
  const throttled = await retrying.fetch({ maxPages: 1 });
  assert.equal(detailRequests, 2, "재시도까지 포함해 예산 안에서만 요청해야 한다");
  assert.ok(detailRequests <= 3, "어떤 경우에도 maxDetailCalls 를 넘으면 안 된다");
  assert.equal(throttled.length, 1);
});

test("six fixture envelopes map all 30 unique records", async () => {
  const collectors = [
    new SocialSecurityCollector({ useFixtures: true }),
    new BizinfoCollector({ useFixtures: true }),
    new FinlifeCollector({ useFixtures: true }),
    new Gov24Collector({ useFixtures: true }),
    new KstartupCollector({ useFixtures: true }),
    new LocalWelfareCollector({ useFixtures: true }),
  ];
  const programs = (await Promise.all(collectors.map((collector) => collector.fetch()))).flat();

  assert.equal(programs.length, 30);
  assert.equal(new Set(programs.map((program) => program.external_id)).size, 30);
  assert.ok(programs.every((program) => program.title && program.source_url));
  const fixedRate = programs.find(
    (program) => program.external_id === "finlife:0010001-KB-YOUTH-01",
  );
  assert.match(fixedRate?.body_text ?? "", /최고 5\.0%/);
});

test("Finlife keeps denial text out of positive eligibility", async () => {
  const collector = new FinlifeCollector({
    settings: settingsFromEnv({ NODE_ENV: "test", FINLIFE_API_KEY: "finlife-key" }),
    retries: 0,
    fetchImpl: async () => Response.json({
      result: {
        baseList: [{
          fin_prdt_cd: "DENY-1",
          fin_co_no: "001",
          fin_prdt_nm: "가입제한 회귀 상품",
          kor_co_nm: "테스트은행",
          join_member: "",
          join_deny: "만 19세 미만은 가입 불가",
          spcl_cnd: "서울특별시 거주 고객 우대",
        }],
        optionList: [],
      },
    }),
  });

  const [program] = await collector.fetch({ maxPages: 1 });
  assert.match(program.body_text, /가입제한/);
  assert.match(program.body_text, /서울특별시 거주 고객 우대/);
  assert.doesNotMatch(program.eligibility_text, /19세|서울특별시/);
  const rules = parseProgram(program);
  assert.deepEqual([rules.age_min, rules.age_max, rules.regions], [null, null, null]);
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
