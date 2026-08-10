import { CollectedProgram } from "../models";
import { Collector, firstOf, isRecord, type CollectorOptions } from "./base";

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
    const eligibility = [
      target && `[신청대상]\n${target}`,
      excludedTarget && `[신청제외대상]\n${excludedTarget}`,
      firstOf(item, ["aply_trgt"]) &&
        `[대상구분] ${firstOf(item, ["aply_trgt"])}`,
      firstOf(item, ["biz_enyy"]) &&
        `[창업기간] ${firstOf(item, ["biz_enyy"])}`,
      firstOf(item, ["biz_trgt_age"]) &&
        `[대상연령] ${firstOf(item, ["biz_trgt_age"])}`,
      firstOf(item, ["prfn_matr"]) &&
        `[우대사항] ${firstOf(item, ["prfn_matr"])}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const bodyText = [
      firstOf(item, ["pbanc_ctnt"]),
      firstOf(item, ["supt_biz_clsfc"]) &&
        `[지원분야] ${firstOf(item, ["supt_biz_clsfc"])}`,
      firstOf(item, ["supt_regin"]) &&
        `[지원지역] ${firstOf(item, ["supt_regin"])}`,
      eligibility,
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
