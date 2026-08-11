import assert from "node:assert/strict";
import test from "node:test";

import { CollectorError } from "../collectors/base";
import { settingsFromEnv } from "../config";
import { KstartupCollector } from "../collectors/kstartup";
import { parseProgram } from "../parser";

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
  assert.match(program.body_text, /신청제외대상/);
  assert.doesNotMatch(program.eligibility_text, /신청제외대상/);
  assert.equal(program.apply_url, "https://www.k-startup.go.kr/apply/123456");
  assert.equal(program.apply_method, "K-Startup에서 온라인 신청");
});

test("K-Startup exclusion and preference text never becomes a positive requirement", async () => {
  const collector = new KstartupCollector({
    settings: settingsFromEnv({ NODE_ENV: "test", DATA_GO_KR_API_KEY: "test-key" }),
    retries: 0,
    fetchImpl: async () =>
      Response.json({
        data: [
          {
            pbanc_sn: "1",
            biz_pbanc_nm: "청년창업 지원",
            aply_trgt_ctnt: "예비창업자",
            // 쉼표·세미콜론으로 이어진 값. 절 단위 표지로는 뒷조각을 지킬 수 없다.
            aply_excl_trgt_ctnt: "만 19세 이상, 만 39세 이하",
            prfn_matr: "서울특별시; 경기도, 매출 1,000만원 이상",
          },
          // 양성 조건이 하나도 없는 건. eligibility_text 가 비면 파서가 body_text 로
          // 폴백해 제외·우대 텍스트를 다시 읽으므로, 이 경로도 함께 막혀야 한다.
          {
            pbanc_sn: "2",
            biz_pbanc_nm: "제외 조건만 있는 공고",
            aply_excl_trgt_ctnt: "만 19세 이상, 만 39세 이하",
            prfn_matr: "서울특별시; 경기도",
          },
        ],
      }),
  });

  const programs = await collector.fetch({ maxPages: 1 });
  assert.equal(programs.length, 2);
  for (const program of programs) {
    const rules = parseProgram(program);
    assert.equal(rules.age_min, null, program.external_id);
    assert.equal(rules.age_max, null, program.external_id);
    assert.equal(rules.regions, null, program.external_id);
  }
  // 본문에는 원문이 한 글자도 깨지지 않고 남아야 한다.
  assert.match(programs[0].body_text, /만 19세 이상, 만 39세 이하/);
  assert.match(programs[0].body_text, /매출 1,000만원 이상/);
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
