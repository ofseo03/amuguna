import { CollectedProgram } from "../models";
import {
  Collector,
  CollectorError,
  firstOf,
  isRecord,
  PAGINATION_SAFETY_LIMIT,
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
  override readonly incrementalStrategy = "full_list_known_ids_detail_budget";
  readonly maxDetailCalls: number;

  constructor(options: CollectorOptions = {}) {
    super({ pageSize: 500, ...options });
    this.maxDetailCalls = options.maxDetailCalls ?? 90;
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
    const region = [firstOf(item, ["ctpvNm"]), firstOf(item, ["sggNm"])].filter(Boolean).join(" ");
    // 구조화된 시도·시군구는 eligibility_text 에 있어야 한다. body_text 에만 두면
    // eligibilitySourceText() 가 body 를 통째로 무시해 지역 한정 사업이 전국구가 된다.
    const eligibility = [region && `[지역] ${region}`, target, criteria]
      .filter(Boolean)
      .join("\n");
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
    const code = xmlText(xml, "resultCode");
    if (!/^0+$/u.test(code)) {
      throw new CollectorError(`${this.sourceKey}: ${xmlText(xml, "resultMessage") || "잘못된 XML 응답"}`, {
        code,
      });
    }
    const item = xmlRecord(xml, DETAIL_FIELDS);
    item.relatedUrl = xmlRecords(xml, "inqplHmpgReldList", ["wlfareInfoReldCn"])
      .map((entry) => String(entry.wlfareInfoReldCn || ""))
      .filter(Boolean)
      .find((value) => /^https?:\/\//u.test(value)) ?? "";
    return item;
  }

  override async fetch(options: FetchOptions = {}): Promise<CollectedProgram[]> {
    const { since, knownIds } = options;
    const maxPages = options.maxPages ?? PAGINATION_SAFETY_LIMIT;
    void since;
    if (this.useFixtures) return super.fetch({ maxPages });
    this.observedCount = 0;
    this.errors.length = 0;
    const collected: CollectedProgram[] = [];
    const seen = new Set<string>();
    let budget = this.maxDetailCalls;
    let skipped = 0;
    let complete = false;
    for (let page = 1; page <= maxPages; page++) {
      const { items, total } = await this.listPage(page);
      this.observedCount = total ?? (this.observedCount ?? 0) + items.length;
      for (const item of items) {
        const nativeId = firstOf(item, ["servId"]);
        if (!nativeId || seen.has(nativeId)) continue;
        if (knownIds?.has(this.externalId(nativeId))) continue;
        if (budget < this.retries + 1) {
          skipped++;
          continue;
        }
        const httpBefore = this.httpCalls;
        let detail: Record<string, unknown>;
        try {
          detail = await this.detail(nativeId);
        } catch (error) {
          budget -= this.httpCalls - httpBefore;
          const missing =
            error instanceof CollectorError &&
            (error.status === 404 ||
              error.status === 410 ||
              (error.code !== undefined && Number(error.code) === 3));
          if (missing) {
            seen.add(nativeId);
            console.warn(`${this.sourceKey}: 상세 조회 건너뜀 (${nativeId}: ${error.message})`);
            continue;
          }
          const message = error instanceof Error ? error.message : String(error);
          console.warn(
            `${this.sourceKey}: 상세 조회 중단 (${message}) — ${collected.length}건까지 저장하고 다음 회차에 이어받습니다`,
          );
          this.errors.push(`상세 조회 중단: ${message}`);
          return collected;
        }
        budget -= this.httpCalls - httpBefore;
        const program = this.mapItem({ ...item, ...detail });
        if (!program) continue;
        seen.add(nativeId);
        collected.push(program);
      }
      if (items.length < this.pageSize || (total !== null && page * this.pageSize >= total)) {
        complete = true;
        break;
      }
    }
    if (!complete && options.maxPages === undefined) {
      throw new CollectorError(`${this.sourceKey}: 페이지 안전 한도에 도달해 전량 수집 여부를 확인할 수 없음`);
    }
    if (skipped) {
      console.warn(
        `${this.sourceKey}: 일일 상세 호출 한도(${this.maxDetailCalls})로 ${skipped}건을 다음 회차로 미룹니다`,
      );
    }
    return collected;
  }

  override async listExternalIds(): Promise<Set<string>> {
    if (this.useFixtures) return super.listExternalIds();
    const ids = new Set<string>();
    let complete = false;
    for (let page = 1; page <= PAGINATION_SAFETY_LIMIT; page++) {
      const { items, total } = await this.listPage(page);
      for (const item of items) {
        const nativeId = firstOf(item, ["servId"]);
        if (nativeId) ids.add(this.externalId(nativeId));
      }
      if (items.length < this.pageSize || (total !== null && page * this.pageSize >= total)) {
        complete = true;
        break;
      }
    }
    if (!complete) throw new CollectorError(`${this.sourceKey}: ID 전량 대조 페이지 안전 한도 도달`);
    return ids;
  }
}
