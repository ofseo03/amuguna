import { CollectedProgram } from "../models";
import {
  Collector,
  CollectorError,
  firstOf,
  isRecord,
  parseAmount,
  type CollectorOptions,
  type FetchOptions,
} from "./base";

const LIST_FIELDS = [
  "ctpvNm",
  "sggNm",
  "bizChrDeptNm",
  "servDgst",
  "servDtlLink",
  "servId",
  "servNm",
  "srvPvsnNm",
] as const;

const DETAIL_FIELDS = [
  "alwServCn",
  "applmetUrl",
  "ctpvNm",
  "sggNm",
  "bizChrDeptNm",
  "servId",
  "servNm",
  "slctCritCn",
  "sprtTrgtCn",
  "servDgst",
  "aplyMtdCn",
  "enfcBgngYmd",
  "enfcEndYmd",
] as const;

function decodeXml(value: string): string {
  const named: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' };
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
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "gu"))].map((match) =>
    xmlRecord(match[1], fields),
  );
}

function ymd(value: string): string | null {
  const digits = [...value].filter((character) => /\d/.test(character)).join("");
  return digits.length === 8 ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}` : null;
}

export class LocalWelfareCollector extends Collector {
  readonly sourceKey = "local_welfare";
  readonly endpoint = "https://apis.data.go.kr/B554287/LocalGovernmentWelfareInformations/LcgvWelfarelist";
  readonly detailEndpoint =
    "https://apis.data.go.kr/B554287/LocalGovernmentWelfareInformations/LcgvWelfaredetailed";
  readonly idListEndpoint = this.endpoint;
  override readonly defaultForm = "subsidy";

  constructor(options: CollectorOptions = {}) {
    super({ pageSize: 500, ...options });
  }

  protected queryParams({ page }: { since: string | null; page: number }) {
    return {
      serviceKey: this.requireApiKey("DATA_GO_KR_API_KEY", this.settings.data_go_kr_api_key),
      pageNo: page,
      numOfRows: this.pageSize,
    };
  }

  protected items(payload: unknown): Record<string, unknown>[] {
    if (typeof payload === "string") return xmlRecords(payload, "servList", LIST_FIELDS);
    return isRecord(payload) && Array.isArray(payload.items) ? payload.items.filter(isRecord) : [];
  }

  protected mapItem(item: Record<string, unknown>): CollectedProgram | null {
    const nativeId = firstOf(item, ["servId"]);
    const title = firstOf(item, ["servNm"]);
    if (!nativeId || !title) return null;

    const target = firstOf(item, ["sprtTrgtCn"]);
    const criteria = firstOf(item, ["slctCritCn"]);
    const benefit = firstOf(item, ["alwServCn"]);
    const eligibility = [target, criteria].filter(Boolean).join("\n");
    const region = [firstOf(item, ["ctpvNm"]), firstOf(item, ["sggNm"])].filter(Boolean).join(" ");
    const bodyText = [
      firstOf(item, ["servDgst"]),
      region && `[지역] ${region}`,
      benefit && `[지원내용]\n${benefit}`,
      eligibility && `[지원대상]\n${eligibility}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const amountText = firstOf(item, ["sprtAmtCn", "alwServCn"]);
    const [amountMin, amountMax] = parseAmount(amountText);
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
      issuer: firstOf(item, ["bizChrDeptNm"], region || "지자체"),
      issuer_level: "local",
      benefit_amount_text: amountText,
      benefit_amount_min: amountMin,
      benefit_amount_max: amountMax,
      apply_url: firstOf(item, ["applmetUrl", "relatedUrl"]),
      apply_method: firstOf(item, ["aplyMtdCn", "srvPvsnNm"]),
      starts_at: ymd(firstOf(item, ["enfcBgngYmd"])),
      ends_at: endsAt,
      is_always_open: endsAt === null,
      raw_body: item,
    });
  }

  private async getXml(params: Record<string, string | number>, endpoint = this.endpoint): Promise<string> {
    return this.request(params, async (response) => {
      const xml = await response.text();
      if (!response.headers.get("content-type")?.includes("xml") && !xml.trimStart().startsWith("<")) {
        throw new CollectorError(`${this.sourceKey}: 잘못된 XML 응답 형식`);
      }
      return xml;
    }, endpoint);
  }

  private async listPage(page: number): Promise<{ items: Record<string, unknown>[]; total: number | null }> {
    const xml = await this.getXml(this.queryParams({ since: null, page }));
    if (!/^0+$/u.test(xmlText(xml, "resultCode"))) {
      throw new CollectorError(`${this.sourceKey}: ${xmlText(xml, "resultMessage") || "잘못된 XML 응답"}`);
    }
    const totalText = xmlText(xml, "totalCount");
    const total = totalText ? Number(totalText) : null;
    return {
      items: this.items(xml),
      total: total !== null && Number.isInteger(total) && total >= 0 ? total : null,
    };
  }

  private async detail(nativeId: string): Promise<Record<string, unknown>> {
    const xml = await this.getXml(
      {
        serviceKey: this.requireApiKey("DATA_GO_KR_API_KEY", this.settings.data_go_kr_api_key),
        servId: nativeId,
      },
      this.detailEndpoint,
    );
    if (!/^0+$/u.test(xmlText(xml, "resultCode"))) {
      throw new CollectorError(`${this.sourceKey}: ${xmlText(xml, "resultMessage") || "잘못된 XML 응답"}`);
    }
    const item = xmlRecord(xml, DETAIL_FIELDS);
    item.relatedUrl = xmlRecords(xml, "inqplHmpgReldList", ["wlfareInfoReldCn"])
      .map((entry) => String(entry.wlfareInfoReldCn || ""))
      .filter(Boolean)
      .find((value) => /^https?:\/\//u.test(value)) ?? "";
    return item;
  }

  override async fetch({ maxPages = 5 }: FetchOptions = {}): Promise<CollectedProgram[]> {
    if (this.useFixtures) return super.fetch({ maxPages });
    const collected: CollectedProgram[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= maxPages; page++) {
      const { items, total } = await this.listPage(page);
      for (const item of items) {
        const nativeId = firstOf(item, ["servId"]);
        if (!nativeId || seen.has(nativeId)) continue;
        const program = this.mapItem({ ...item, ...(await this.detail(nativeId)) });
        if (!program) continue;
        seen.add(nativeId);
        collected.push(program);
      }
      if (items.length < this.pageSize || (total !== null && page * this.pageSize >= total)) break;
    }
    return collected;
  }

  override async listExternalIds(): Promise<Set<string>> {
    if (this.useFixtures) return super.listExternalIds();
    const ids = new Set<string>();
    for (let page = 1; page <= 50; page++) {
      const { items, total } = await this.listPage(page);
      for (const item of items) {
        const nativeId = firstOf(item, ["servId"]);
        if (nativeId) ids.add(this.externalId(nativeId));
      }
      if (items.length < this.pageSize || (total !== null && page * this.pageSize >= total)) break;
    }
    return ids;
  }
}
