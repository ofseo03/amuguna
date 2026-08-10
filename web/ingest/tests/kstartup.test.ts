import assert from "node:assert/strict";
import test from "node:test";

import { CollectorError } from "../collectors/base";
import { settingsFromEnv } from "../config";
import { KstartupCollector } from "../collectors/kstartup";

test("K-Startup collector maps the official JSON announcement envelope", async () => {
  const requests: URL[] = [];
  const collector = new KstartupCollector({
    settings: settingsFromEnv({
      NODE_ENV: "test",
      DATA_GO_KR_API_KEY: "test-key",
    }),
    pageSize: 10,
    retries: 0,
    fetchImpl: async (input) => {
      requests.push(
        new URL(input instanceof Request ? input.url : String(input)),
      );
      return Response.json({
        data: [
          {
            pbanc_sn: "123456",
            biz_pbanc_nm: "2026년 예비창업자 사업화 지원",
            pbanc_ctnt: "예비창업자의 사업화를 지원합니다.",
            aply_trgt_ctnt: "예비창업자",
            aply_excl_trgt_ctnt: "금융기관 채무불이행자",
            aply_trgt: "일반인",
            biz_enyy: "예비창업자",
            biz_trgt_age: "만 20세 이상 ~ 만 39세 이하",
            prfn_matr: "청년",
            supt_biz_clsfc: "사업화",
            supt_regin: "전국",
            pbanc_rcpt_bgng_dt: "20260801",
            pbanc_rcpt_end_dt: "20260831",
            pbanc_ntrp_nm: "창업진흥원",
            detl_pg_url:
              "https://www.k-startup.go.kr/web/contents/bizPbanc-123456.do",
            biz_aply_url: "https://www.k-startup.go.kr/apply/123456",
            aply_mthd_onli_rcpt_istc: "K-Startup에서 온라인 신청",
          },
        ],
      });
    },
  });

  const [program] = await collector.fetch({ since: "2026-08-01", maxPages: 1 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.origin, "https://apis.data.go.kr");
  assert.equal(
    requests[0]?.pathname,
    "/B552735/kisedKstartupService01/getAnnouncementInformation01",
  );
  assert.equal(requests[0]?.searchParams.get("serviceKey"), "test-key");
  assert.equal(requests[0]?.searchParams.get("returnType"), "json");
  assert.equal(
    requests[0]?.searchParams.has("cond[pbanc_rcpt_bgng_dt::GTE]"),
    false,
  );
  assert.equal(program.external_id, "kstartup:123456");
  assert.equal(program.starts_at, "2026-08-01");
  assert.equal(program.ends_at, "2026-08-31");
  assert.match(program.eligibility_text, /신청제외대상/);
  assert.equal(program.apply_url, "https://www.k-startup.go.kr/apply/123456");
  assert.equal(program.apply_method, "K-Startup에서 온라인 신청");
});

test("K-Startup rejects an empty malformed envelope", async () => {
  const collector = new KstartupCollector({
    settings: settingsFromEnv({
      NODE_ENV: "test",
      DATA_GO_KR_API_KEY: "test-key",
    }),
    retries: 0,
    fetchImpl: async () => Response.json({ error: "bad response" }),
  });
  await assert.rejects(collector.fetch({ maxPages: 1 }), CollectorError);
});
