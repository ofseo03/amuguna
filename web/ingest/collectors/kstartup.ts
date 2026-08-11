import { CollectedProgram } from "../models";
import { Collector, firstOf, isRecord, type CollectorOptions } from "./base";

const NO_ELIGIBILITY_INFO = "[자격요건 정보 없음]";

function ymd(value: string): string | null {
  const digits = [...value]
    .filter((character) => /\d/.test(character))
    .join("");
  return digits.length >= 8
    ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
    : null;
}

export class KstartupCollector extends Collector {
  readonly sourceKey = "kstartup";
  readonly endpoint =
    "https://apis.data.go.kr/B552735/kisedKstartupService01/getAnnouncementInformation01";
  readonly idListEndpoint = this.endpoint;
  override readonly defaultForm = "subsidy";

  constructor(options: CollectorOptions = {}) {
    super({ pageSize: 1_000, ...options });
  }

  protected queryParams({ page }: { since: string | null; page: number }) {
    return {
      serviceKey: this.requireApiKey(
        "DATA_GO_KR_API_KEY",
        this.settings.data_go_kr_api_key,
      ),
      page,
      perPage: this.pageSize,
      returnType: "json",
    };
  }

  protected items(payload: unknown): Record<string, unknown>[] {
    return isRecord(payload) && Array.isArray(payload.data)
      ? payload.data.filter(isRecord)
      : [];
  }

  protected mapItem(item: Record<string, unknown>): CollectedProgram | null {
    const nativeId = firstOf(item, ["pbanc_sn"]);
    const title = firstOf(item, ["biz_pbanc_nm"]);
    if (!nativeId || !title) return null;

    const target = firstOf(item, ["aply_trgt_ctnt"]);
    const excludedTarget = firstOf(item, ["aply_excl_trgt_ctnt"]);
    // 제외 대상·우대 사항은 eligibility_text 에 넣지 않는다. 자격 파서는 절 단위로
    // "제외"·"우대" 표지를 찾는데, 값이 쉼표·세미콜론·줄바꿈으로 이어지면 뒷절이
    // 표지를 잃고 배제 조건이 필수 조건으로 뒤집힌다. 라벨을 절마다 덧붙여 막으려면
    // 파서의 구분자로 값을 쪼개야 하고, 그 과정에서 `매출 1,000만원` 같은 원문이
    // 깨진다. 애초에 파서가 이 텍스트로 할 수 있는 일이 없으므로 - 조건을 만들지도,
    // 걸러내지도 못한다 - 하드 필터 입력에서 빼고 본문에만 원문 그대로 남긴다.
    const preference = firstOf(item, ["prfn_matr"]);
    const positives = [
      target && `[신청대상]\n${target}`,
      firstOf(item, ["aply_trgt"]) &&
        `[대상구분] ${firstOf(item, ["aply_trgt"])}`,
      firstOf(item, ["biz_enyy"]) &&
        `[창업기간] ${firstOf(item, ["biz_enyy"])}`,
      firstOf(item, ["biz_trgt_age"]) &&
        `[대상연령] ${firstOf(item, ["biz_trgt_age"])}`,
      // 구조화된 지원지역은 eligibility_text 에 있어야 한다. body_text 에만 두면
      // eligibilitySourceText() 가 body 를 통째로 무시해 지역 한정 사업이 전국구가 된다.
      firstOf(item, ["supt_regin"]) &&
        `[지원지역] ${firstOf(item, ["supt_regin"])}`,
    ].filter(Boolean);
    // eligibility_text 가 비면 eligibilitySourceText() 가 body_text 로 폴백하는데,
    // 본문에는 제외·우대 원문이 들어 있어 그 순간 위 방어가 통째로 무력해진다.
    // 양성 조건이 하나도 없으면 파싱해서 얻을 것도 없으므로, 폴백을 막는 표지를 남긴다.
    const eligibility = positives.length ? positives.join("\n\n") : NO_ELIGIBILITY_INFO;
    const bodyText = [
      firstOf(item, ["pbanc_ctnt"]),
      firstOf(item, ["supt_biz_clsfc"]) &&
        `[지원분야] ${firstOf(item, ["supt_biz_clsfc"])}`,
      firstOf(item, ["supt_regin"]) &&
        `[지원지역] ${firstOf(item, ["supt_regin"])}`,
      positives.join("\n\n"),
      excludedTarget && `[신청제외대상]\n${excludedTarget}`,
      preference && `[우대사항]\n${preference}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const issuer = firstOf(item, ["pbanc_ntrp_nm", "sprv_inst"], "창업진흥원");
    const applyMethod = [
      firstOf(item, ["aply_mthd_onli_rcpt_istc"]),
      firstOf(item, ["aply_mthd_vst_rcpt_istc"]),
      firstOf(item, ["aply_mthd_pssr_rcpt_istc"]),
      firstOf(item, ["aply_mthd_fax_rcpt_istc"]),
      firstOf(item, ["aply_mthd_etc_istc"]),
    ]
      .filter(Boolean)
      .join("\n");

    return new CollectedProgram({
      external_id: this.externalId(nativeId),
      source_key: this.sourceKey,
      source_url: firstOf(
        item,
        ["detl_pg_url", "biz_gdnc_url"],
        "https://www.k-startup.go.kr/",
      ),
      title,
      body_text: bodyText || title,
      eligibility_text: eligibility,
      form: this.defaultForm,
      issuer,
      issuer_level: "central",
      apply_url: firstOf(item, ["biz_aply_url", "detl_pg_url"]),
      apply_method: applyMethod,
      starts_at: ymd(firstOf(item, ["pbanc_rcpt_bgng_dt"])),
      ends_at: ymd(firstOf(item, ["pbanc_rcpt_end_dt"])),
      is_always_open: false,
      raw_body: item,
    });
  }
}
