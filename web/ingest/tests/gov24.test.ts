import assert from "node:assert/strict";
import test from "node:test";

import { Gov24Collector } from "../collectors/gov24";
import { CollectorError } from "../collectors/base";
import { settingsFromEnv } from "../config";

test("Gov24 list envelope maps public Swagger fields with one request per page", async () => {
  const requests: URL[] = [];
  const collector = new Gov24Collector({
    settings: settingsFromEnv({ NODE_ENV: "test", DATA_GO_KR_API_KEY: "gov24-key" }),
    pageSize: 1,
    retries: 0,
    fetchImpl: async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(url);
      return Response.json({
        page: 1,
        perPage: 1,
        totalCount: 1,
        currentCount: 1,
        matchCount: 1,
        data: [
          {
            서비스ID: "GOV24-001",
            서비스명: "청년 주거비 지원",
            서비스목적요약: "청년의 주거비 부담을 줄입니다.",
            지원대상: "만 19세 이상 34세 이하 청년",
            선정기준: "기준 중위소득 150% 이하",
            지원내용: "월 최대 20만원을 지원합니다.",
            신청방법: "온라인 신청",
            신청기한: "2026. 01. 01. ~ 2026. 12. 31.",
            상세조회URL: "https://www.gov.kr/portal/rcmndSvc/123",
            소관기관명: "국토교통부",
            소관기관유형: "중앙행정기관",
            등록일시: "2025-12-01",
            수정일시: "2026-01-01",
          },
        ],
      });
    },
  });

  const [program] = await collector.fetch({ since: "2026-01-01", maxPages: 1 });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.pathname, "/api/gov24/v3/serviceList");
  assert.equal(requests[0]?.searchParams.get("serviceKey"), "gov24-key");
  assert.equal(requests[0]?.searchParams.get("page"), "1");
  assert.equal(requests[0]?.searchParams.get("perPage"), "1");
  assert.equal(requests[0]?.searchParams.get("returnType"), "JSON");
  assert.equal(requests[0]?.searchParams.get("cond[수정일시::GTE]"), "2026-01-01");
  assert.equal(program.external_id, "gov24:GOV24-001");
  assert.equal(program.source_url, "https://www.gov.kr/portal/rcmndSvc/123");
  assert.equal(program.issuer, "국토교통부");
  assert.equal(program.issuer_level, "central");
  assert.deepEqual([program.starts_at, program.ends_at], ["2026-01-01", "2026-12-31"]);
  assert.equal(program.benefit_amount_max, 200_000);
  assert.match(program.eligibility_text, /만 19세 이상 34세 이하 청년/);
  assert.match(program.eligibility_text, /기준 중위소득 150% 이하/);
  assert.match(program.body_text, /월 최대 20만원을 지원합니다/);
  assert.equal(program.raw_body.서비스ID, "GOV24-001");
  assert.equal(program.raw_body.수정일시, "2026-01-01");
});

test("Gov24 rejects an empty malformed envelope", async () => {
  const collector = new Gov24Collector({
    settings: settingsFromEnv({ NODE_ENV: "test", DATA_GO_KR_API_KEY: "gov24-key" }),
    retries: 0,
    fetchImpl: async () => Response.json({ error: "bad response" }),
  });
  await assert.rejects(collector.fetch({ maxPages: 1 }), CollectorError);
});
