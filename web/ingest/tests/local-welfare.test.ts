import assert from "node:assert/strict";
import test from "node:test";

import { LocalWelfareCollector } from "../collectors/local-welfare";
import { settingsFromEnv } from "../config";

test("local welfare XML joins detail, preserves region, and sends required parameters", async () => {
  const list = `<?xml version="1.0" encoding="UTF-8"?>
    <wantedList><servList>
      <ctpvNm>서울특별시</ctpvNm><sggNm>관악구</sggNm>
      <bizChrDeptNm>관악구청 청년정책과</bizChrDeptNm><servDgst>청년 주거비 지원</servDgst>
      <servDtlLink>https://example.test/detail?a=1&amp;b=2</servDtlLink>
      <servId>LOCAL-100</servId><servNm>청년 월세 지원</servNm><srvPvsnNm>현금</srvPvsnNm>
    </servList><totalCount>1</totalCount><resultCode>00</resultCode><resultMessage>SUCCESS</resultMessage></wantedList>`;
  const detail = `<?xml version="1.0" encoding="UTF-8"?>
    <wantedDtl><servId>LOCAL-100</servId><servNm>청년 월세 지원</servNm>
      <ctpvNm>서울특별시</ctpvNm><sggNm>관악구</sggNm><bizChrDeptNm>관악구청 청년정책과</bizChrDeptNm>
      <servDgst>관악구 청년의 주거 부담을 덜어드립니다.</servDgst>
      <sprtTrgtCn>관악구에 거주하는 만 19세 이상 39세 이하 청년&#13;1인 가구</sprtTrgtCn>
      <slctCritCn>기준 중위소득 150% 이하</slctCritCn><alwServCn>월 최대 20만원 지원</alwServCn>
      <applmetUrl>https://apply-direct.example.test</applmetUrl>
      <aplyMtdCn>관악구청 방문 또는 온라인 신청</aplyMtdCn><enfcBgngYmd>20260101</enfcBgngYmd><enfcEndYmd>20261231</enfcEndYmd>
      <inqplHmpgReldList><wlfareInfoReldCn>https://apply.example.test</wlfareInfoReldCn></inqplHmpgReldList>
      <resultCode>0</resultCode><resultMessage>SUCCESS</resultMessage>
    </wantedDtl>`;
  const requests: URL[] = [];
  const collector = new LocalWelfareCollector({
    settings: settingsFromEnv({
      NODE_ENV: "test",
      DATA_GO_KR_API_KEY: "local-key",
    }),
    pageSize: 1,
    retries: 0,
    fetchImpl: async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(url);
      return new Response(
        url.pathname.endsWith("LcgvWelfaredetailed") ? detail : list,
        {
          headers: { "Content-Type": "application/xml" },
        },
      );
    },
  });

  const [program] = await collector.fetch({ maxPages: 1 });
  assert.equal(requests.length, 2);
  assert.match(requests[0].pathname, /LcgvWelfarelist$/);
  assert.equal(requests[0].searchParams.get("serviceKey"), "local-key");
  assert.equal(requests[0].searchParams.has("callTp"), false);
  assert.equal(requests[0].searchParams.get("pageNo"), "1");
  assert.equal(requests[0].searchParams.get("numOfRows"), "1");
  assert.match(requests[1].pathname, /LcgvWelfaredetailed$/);
  assert.equal(requests[1].searchParams.has("callTp"), false);
  assert.equal(requests[1].searchParams.get("servId"), "LOCAL-100");
  assert.equal(program.external_id, "local_welfare:LOCAL-100");
  assert.equal(program.issuer, "관악구청 청년정책과");
  assert.equal(program.issuer_level, "local");
  assert.match(program.body_text, /\[지역\] 서울특별시 관악구/);
  assert.match(program.eligibility_text, /1인 가구/);
  assert.doesNotMatch(program.eligibility_text, /&#13;/);
  assert.equal(program.source_url, "https://example.test/detail?a=1&b=2");
  assert.equal(program.apply_url, "https://apply-direct.example.test");
  assert.match(program.apply_method, /관악구청 방문/);
  assert.deepEqual(
    [program.starts_at, program.ends_at],
    ["2026-01-01", "2026-12-31"],
  );

  assert.deepEqual(
    await collector.listExternalIds(),
    new Set(["local_welfare:LOCAL-100"]),
  );
  assert.equal(requests.length, 3);
  assert.match(requests[2].pathname, /LcgvWelfarelist$/);
});

test("local welfare skips missing details but aborts on transient failures", async () => {
  const ids = ["LOCAL-1", "LOCAL-2", "LOCAL-3"];
  const list = `<?xml version="1.0" encoding="UTF-8"?><wantedList>${ids
    .map((id) => `<servList><servId>${id}</servId><servNm>서비스 ${id}</servNm></servList>`)
    .join("")}<totalCount>3</totalCount><resultCode>00</resultCode></wantedList>`;
  const detailOf = (id: string) =>
    `<?xml version="1.0" encoding="UTF-8"?><wantedDtl><servId>${id}</servId>` +
    `<servNm>서비스 ${id}</servNm><sprtTrgtCn>만 19세 이상</sprtTrgtCn>` +
    `<resultCode>0</resultCode><resultMessage>SUCCESS</resultMessage></wantedDtl>`;

  const build = (failure: number | "no-data") => {
    const detailIds: string[] = [];
    const collector = new LocalWelfareCollector({
      settings: settingsFromEnv({ NODE_ENV: "test", DATA_GO_KR_API_KEY: "local-key" }),
      pageSize: 3,
      retries: 0,
      fetchImpl: async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (!url.pathname.endsWith("LcgvWelfaredetailed")) {
          return new Response(list, { headers: { "Content-Type": "application/xml" } });
        }
        const id = url.searchParams.get("servId")!;
        detailIds.push(id);
        if (id === ids[1]) {
          if (failure === "no-data") {
            return new Response(
              `<?xml version="1.0"?><wantedDtl><resultCode>03</resultCode>` +
                `<resultMessage>NO_DATA</resultMessage></wantedDtl>`,
              { headers: { "Content-Type": "application/xml" } },
            );
          }
          return new Response("", { status: failure });
        }
        return new Response(detailOf(id), { headers: { "Content-Type": "application/xml" } });
      },
    });
    return { collector, detailIds };
  };

  const missing = build(404);
  assert.deepEqual(
    (await missing.collector.fetch({ maxPages: 1 })).map(({ external_id }) => external_id),
    ["local_welfare:LOCAL-1", "local_welfare:LOCAL-3"],
  );
  assert.deepEqual(missing.detailIds, ids);

  const missingEnvelope = build("no-data");
  assert.deepEqual(
    (await missingEnvelope.collector.fetch({ maxPages: 1 })).map(({ external_id }) => external_id),
    ["local_welfare:LOCAL-1", "local_welfare:LOCAL-3"],
  );

  const transient = build(503);
  await assert.rejects(transient.collector.fetch({ maxPages: 1 }), /HTTP 503/);
  assert.deepEqual(transient.detailIds, ids.slice(0, 2));
});
