import { CollectedProgram } from "../models";
import { Collector, firstOf, isRecord, parseAmount, recordOrUndefined } from "./base";

function ymd(value: string): string | null {
  const digits = [...value].filter((character) => /\d/.test(character)).join("");
  return digits.length === 8
    ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
    : null;
}

export class SocialSecurityCollector extends Collector {
  readonly sourceKey = "social_security";
  readonly endpoint =
    "https://apis.data.go.kr/B554287/NationalWelfareInformationsV001/NationalWelfarelistV001";
  readonly idListEndpoint = this.endpoint;
  override readonly defaultForm = "subsidy";

  protected queryParams({ since, page }: { since: string | null; page: number }) {
    const params: Record<string, string | number> = {
      serviceKey: this.apiKey,
      callTp: "L",
      pageNo: page,
      numOfRows: this.pageSize,
      srchKeyCode: "001",
      _type: "json",
    };
    if (since) params.srchModDt = since.replaceAll("-", "");
    return params;
  }

  protected items(payload: unknown): Record<string, unknown>[] {
    if (!isRecord(payload)) return [];
    const response = recordOrUndefined(payload.response);
    const body = recordOrUndefined(response?.body) ?? recordOrUndefined(payload.body);
    let items: unknown = body?.items ?? {};
    if (isRecord(items)) items = items.item ?? [];
    if (isRecord(items)) items = [items];
    return Array.isArray(items) ? items.filter(isRecord) : [];
  }

  protected mapItem(item: Record<string, unknown>): CollectedProgram | null {
    const nativeId = firstOf(item, ["servId", "servid", "SERV_ID"]);
    const title = firstOf(item, ["servNm", "servnm", "SERV_NM"]);
    if (!nativeId || !title) return null;

    const outline = firstOf(item, ["wlfareInfoOutlCn", "servDgst", "servDtlLink"]);
    const target = firstOf(item, ["sprtTrgtCn", "trgterIndvdlArray"]);
    const criteria = firstOf(item, ["slctCritCn"]);
    const benefit = firstOf(item, ["alwServCn"]);
    const eligibility = [target, criteria].filter(Boolean).join("\n");
    const bodyText = [
      outline,
      benefit && `[지원내용]\n${benefit}`,
      eligibility && `[지원대상]\n${eligibility}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const issuer = firstOf(item, ["jurOrgNm", "jurMnofNm"], "정부");
    const issuerLevel = ["부", "청", "처", "위원회", "공단"].some((key) => issuer.includes(key))
      ? "central"
      : ["특별시", "광역시", "도", "특별자치시", "특별자치도"].some((key) =>
            issuer.endsWith(key),
          )
        ? "metro"
        : "local";
    const amountText = firstOf(item, ["sprtAmtCn", "alwServCn"]);
    const [amountMin, amountMax] = parseAmount(amountText);
    const startsAt = ymd(firstOf(item, ["enfcBgngYmd"]));
    const endsAt = ymd(firstOf(item, ["enfcEndYmd"]));

    return new CollectedProgram({
      external_id: this.externalId(nativeId),
      source_key: this.sourceKey,
      source_url: firstOf(
        item,
        ["servDtlLink", "servUrl"],
        `https://www.bokjiro.go.kr/ssis-tbu/twataa/wlfareInfo/moveTWAT52011M.do?wlfareInfoId=${nativeId}`,
      ),
      title,
      body_text: bodyText || title,
      eligibility_text: eligibility,
      form: this.defaultForm,
      issuer,
      issuer_level: issuerLevel,
      benefit_amount_text: amountText,
      benefit_amount_min: amountMin,
      benefit_amount_max: amountMax,
      apply_url: firstOf(item, ["applmetUrl", "onapPsbltYn"]),
      apply_method: firstOf(item, ["applmetCn", "srvPvsnNm"]),
      starts_at: startsAt,
      ends_at: endsAt,
      is_always_open: endsAt === null,
      raw_body: item,
    });
  }
}
