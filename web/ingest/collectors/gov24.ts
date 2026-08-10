import { CollectedProgram } from "../models";
import { Collector, firstOf, isRecord, parseAmount, type CollectorOptions } from "./base";

function applicationPeriod(value: string): [string | null, string | null, boolean] {
  const dates = [...value.matchAll(/(20\d{2})\D+(\d{1,2})\D+(\d{1,2})/gu)].map(
    ([, year, month, day]) => `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`,
  );
  if (dates.length >= 2) return [dates[0], dates[1], false];
  if (dates.length === 1) return [dates[0], null, false];
  return [null, null, /상시|연중|예산\s*소진/u.test(value)];
}

function issuerLevel(agency: string, type: string): "central" | "metro" | "local" {
  if (type.includes("중앙")) return "central";
  if (type.includes("지방")) {
    return /(특별시|광역시|특별자치시|특별자치도|도)$/u.test(agency) ? "metro" : "local";
  }
  return /(특별시|광역시|특별자치시|특별자치도|도)$/u.test(agency) ? "metro" : "central";
}

export class Gov24Collector extends Collector {
  readonly sourceKey = "gov24";
  readonly endpoint = "https://api.odcloud.kr/api/gov24/v3/serviceList";
  readonly idListEndpoint = this.endpoint;
  override readonly defaultForm = "subsidy";

  constructor(options: CollectorOptions = {}) {
    super({ pageSize: 1_000, ...options });
  }

  protected queryParams({ since, page }: { since: string | null; page: number }) {
    const params: Record<string, string | number> = {
      serviceKey: this.requireApiKey("DATA_GO_KR_API_KEY", this.settings.data_go_kr_api_key),
      page,
      perPage: this.pageSize,
      returnType: "JSON",
    };
    if (since) params["cond[수정일시::GTE]"] = since;
    return params;
  }

  protected items(payload: unknown): Record<string, unknown>[] {
    return isRecord(payload) && Array.isArray(payload.data) ? payload.data.filter(isRecord) : [];
  }

  protected mapItem(item: Record<string, unknown>): CollectedProgram | null {
    const nativeId = firstOf(item, ["서비스ID"]);
    const title = firstOf(item, ["서비스명"]);
    if (!nativeId || !title) return null;

    const summary = firstOf(item, ["서비스목적요약", "서비스목적"]);
    const target = firstOf(item, ["지원대상"]);
    const criteria = firstOf(item, ["선정기준"]);
    const benefit = firstOf(item, ["지원내용"]);
    const deadline = firstOf(item, ["신청기한"]);
    const eligibility = [target, criteria].filter(Boolean).join("\n");
    const bodyText = [
      summary,
      benefit && `[지원내용]\n${benefit}`,
      eligibility && `[지원대상·선정기준]\n${eligibility}`,
      deadline && `[신청기한] ${deadline}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const agency = firstOf(item, ["소관기관명"], "정부");
    const [startsAt, endsAt, alwaysOpen] = applicationPeriod(deadline);
    const [amountMin, amountMax] = parseAmount(benefit);

    return new CollectedProgram({
      external_id: this.externalId(nativeId),
      source_key: this.sourceKey,
      source_url: firstOf(item, ["상세조회URL"], "https://www.data.go.kr/data/15113968/openapi.do"),
      title,
      body_text: bodyText || title,
      eligibility_text: eligibility,
      form: this.defaultForm,
      issuer: agency,
      issuer_level: issuerLevel(agency, firstOf(item, ["소관기관유형"])),
      benefit_amount_text: benefit,
      benefit_amount_min: amountMin,
      benefit_amount_max: amountMax,
      apply_url: "",
      apply_method: firstOf(item, ["신청방법"]),
      starts_at: startsAt,
      ends_at: endsAt,
      is_always_open: alwaysOpen && endsAt === null,
      raw_body: item,
    });
  }
}
