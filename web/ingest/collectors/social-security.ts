import { CollectedProgram } from "../models";
import {
  Collector,
  CollectorError,
  firstOf,
  isRecord,
  parseAmount,
  recordOrUndefined,
  type CollectorOptions,
  type FetchOptions,
} from "./base";

const LIST_FIELDS = [
  "inqNum",
  "intrsThemaArray",
  "jurMnofNm",
  "jurOrgNm",
  "lifeArray",
  "onapPsbltYn",
  "rprsCtadr",
  "servDgst",
  "servDtlLink",
  "servId",
  "servNm",
  "sprtCycNm",
  "srvPvsnNm",
  "trgterIndvdlArray",
] as const;

const DETAIL_FIELDS = [
  "alwServCn",
  "crtrYr",
  "jurMnofNm",
  "rprsCtadr",
  "servId",
  "servNm",
  "slctCritCn",
  "tgtrDtlCn",
  "wlfareInfoOutlCn",
] as const;

function decodeXml(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"',
  };
  return value
    .replace(/&#(?:x([\da-f]+)|(\d+));/giu, (entity, hex: string, decimal: string) => {
      const codePoint = Number.parseInt(hex || decimal, hex ? 16 : 10);
      return codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
    })
    .replace(/&(amp|apos|gt|lt|quot);/gu, (_, name: string) => named[name])
    .replace(/\r\n?/gu, "\n")
    .trim();
}

function xmlText(xml: string, tag: string): string {
  return decodeXml(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "u").exec(xml)?.[1] ?? "");
}

function xmlRecord(xml: string, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field, xmlText(xml, field)]));
}

function xmlRecords(xml: string, tag: string, fields: readonly string[]): Record<string, unknown>[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "gu"))].map(
    (match) => xmlRecord(match[1], fields),
  );
}

function requireXmlSuccess(xml: string, sourceKey: string): void {
  if (xmlText(xml, "resultCode") !== "0") {
    throw new CollectorError(`${sourceKey}: ${xmlText(xml, "resultMessage") || "잘못된 XML 응답"}`);
  }
}

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
  readonly detailEndpoint =
    "https://apis.data.go.kr/B554287/NationalWelfareInformationsV001/NationalWelfaredetailedV001";
  readonly idListEndpoint = this.endpoint;
  override readonly defaultForm = "subsidy";

  constructor(options: CollectorOptions = {}) {
    super({ pageSize: 500, ...options });
  }

  protected queryParams({ page }: { since: string | null; page: number }) {
    return {
      serviceKey: this.requireApiKey("DATA_GO_KR_API_KEY", this.settings.data_go_kr_api_key),
      callTp: "L",
      pageNo: page,
      numOfRows: this.pageSize,
      srchKeyCode: "001",
    };
  }

  protected items(payload: unknown): Record<string, unknown>[] {
    if (typeof payload === "string") return xmlRecords(payload, "servList", LIST_FIELDS);
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
    const target = firstOf(item, ["tgtrDtlCn", "sprtTrgtCn"]);
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

    const issuer = firstOf(item, ["jurMnofNm", "jurOrgNm"], "정부");
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
      apply_url: firstOf(item, ["applmetUrl"]),
      apply_method: firstOf(item, ["applmetCn", "srvPvsnNm"]),
      starts_at: startsAt,
      ends_at: endsAt,
      is_always_open: endsAt === null,
      raw_body: item,
    });
  }

  private async listPage(
    page: number,
  ): Promise<{ items: Record<string, unknown>[]; totalCount: number | null }> {
    const payload = await this.getXml(this.queryParams({ since: null, page }));
    requireXmlSuccess(payload, this.sourceKey);
    const totalCountText = xmlText(payload, "totalCount");
    const totalCount = totalCountText ? Number(totalCountText) : null;
    return {
      items: this.items(payload),
      totalCount:
        totalCount !== null && Number.isInteger(totalCount) && totalCount >= 0 ? totalCount : null,
    };
  }

  private async getXml(
    params: Record<string, string | number>,
    endpoint = this.endpoint,
  ): Promise<string> {
    return this.request(
      params,
      async (response) => {
        const xml = await response.text();
        if (!response.headers.get("content-type")?.includes("xml") && !xml.trimStart().startsWith("<")) {
          throw new CollectorError(`${this.sourceKey}: 잘못된 XML 응답 형식`);
        }
        return xml;
      },
      endpoint,
    );
  }

  private async detail(nativeId: string): Promise<Record<string, unknown>> {
    const payload = await this.getXml(
      {
        serviceKey: this.requireApiKey("DATA_GO_KR_API_KEY", this.settings.data_go_kr_api_key),
        callTp: "D",
        servId: nativeId,
      },
      this.detailEndpoint,
    );
    requireXmlSuccess(payload, this.sourceKey);
    const item = xmlRecord(payload, DETAIL_FIELDS);
    item.applmetCn = xmlRecords(payload, "applmetList", ["servSeDetailLink"])
      .map((entry) => String(entry.servSeDetailLink || ""))
      .filter(Boolean)
      .join("\n");
    return item;
  }

  override async fetch({ maxPages = 5 }: FetchOptions = {}): Promise<CollectedProgram[]> {
    if (this.useFixtures) return super.fetch({ maxPages });

    const collected: CollectedProgram[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= maxPages; page++) {
      const { items, totalCount } = await this.listPage(page);
      for (const item of items) {
        const nativeId = firstOf(item, ["servId"]);
        if (!nativeId || seen.has(nativeId)) continue;
        const program = this.mapItem({ ...item, ...(await this.detail(nativeId)) });
        if (!program) continue;
        seen.add(nativeId);
        collected.push(program);
      }
      if (items.length < this.pageSize || (totalCount !== null && page * this.pageSize >= totalCount)) break;
    }
    return collected;
  }

  override async listExternalIds(): Promise<Set<string>> {
    if (this.useFixtures) return super.listExternalIds();
    const ids = new Set<string>();
    for (let page = 1; page <= 50; page++) {
      const { items, totalCount } = await this.listPage(page);
      for (const item of items) {
        const nativeId = firstOf(item, ["servId"]);
        if (nativeId) ids.add(this.externalId(nativeId));
      }
      if (items.length < this.pageSize || (totalCount !== null && page * this.pageSize >= totalCount)) break;
    }
    return ids;
  }
}
