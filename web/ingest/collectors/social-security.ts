import { CollectedProgram } from "../models";
import {
  Collector,
  CollectorError,
  firstOf,
  isRecord,
  PAGINATION_SAFETY_LIMIT,
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
  const code = xmlText(xml, "resultCode");
  if (code !== "0") {
    throw new CollectorError(`${sourceKey}: ${xmlText(xml, "resultMessage") || "잘못된 XML 응답"}`, {
      code,
    });
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
  override readonly incrementalStrategy = "full_list_known_ids_detail_budget";

  /**
   * 상세조회 개발계정 한도는 100회/일 (SPEC §3.2). 목록 호출분과 재시도 여유를
   * 남기고 그 아래에서 끊는다. 초과하면 429 가 나면서 그 회차 전체가 버려진다.
   */
  readonly maxDetailCalls: number;

  constructor(options: CollectorOptions = {}) {
    super({ pageSize: 500, ...options });
    this.maxDetailCalls = options.maxDetailCalls ?? 90;
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

  /**
   * 건당 상세 조회가 필요한데 개발계정 한도가 100회/일이라, 전량(수백 건)을 한 번에
   * 받을 수 없다. 세 가지로 나눠 처리한다.
   *   1. 이미 적재된 건은 상세를 건너뛴다 — 한도를 신규 건에 몰아준다
   *   2. 한 회차의 상세 호출을 maxDetailCalls 로 끊는다
   *   3. 그래도 실패하면 던지지 않고 여기까지 모은 것을 반환한다
   * 3이 핵심이다. 예전에는 중간에 429가 나면 CollectorError 로 그 회차 전체가
   * 버려져, 매일 처음부터 다시 시작하며 초기 적재가 영영 끝나지 않았다.
   *
   * ponytail: 적재된 건은 다시 안 보므로 원본 수정(마감 연장·자격 완화)을 놓친다.
   * 한도가 풀리면(운영계정) knownIds 스킵을 빼고 content_hash 비교로 되돌린다.
   */
  override async fetch(options: FetchOptions = {}): Promise<CollectedProgram[]> {
    const { since, knownIds } = options;
    const maxPages = options.maxPages ?? PAGINATION_SAFETY_LIMIT;
    // 이 공식 목록 API에는 날짜 필터가 없다. --since 는 요청 파라미터로 보내지 않고,
    // 전체 목록을 훑은 뒤 knownIds 로 기존 건을 건너뛰고 상세조회 예산을 신규 건에 쓴다.
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
      const { items, totalCount } = await this.listPage(page);
      this.observedCount = totalCount ?? (this.observedCount ?? 0) + items.length;
      for (const item of items) {
        const nativeId = firstOf(item, ["servId"]);
        if (!nativeId || seen.has(nativeId)) continue;
        if (knownIds?.has(this.externalId(nativeId))) continue;
        // 포털은 논리적 호출이 아니라 HTTP 요청 수로 한도를 센다. detail() 한 번이
        // 재시도까지 최대 retries+1 회 나갈 수 있으므로, 그만큼 남아 있을 때만
        // 시작하고 실제 나간 요청 수만큼 깎는다. 남은 예산만 보고 시작하면
        // 마지막 한 건이 재시도로 한도를 넘겨버린다.
        if (budget < this.retries + 1) {
          skipped++;
          continue;
        }

        const httpBefore = this.httpCalls;
        let detail: Record<string, unknown>;
        try {
          detail = await this.detail(nativeId);
          budget -= this.httpCalls - httpBefore;
        } catch (error) {
          budget -= this.httpCalls - httpBefore;
          const message = error instanceof Error ? error.message : String(error);
          const missingDetail =
            error instanceof CollectorError &&
            (error.status === 404 ||
              error.status === 410 ||
              (error.code !== undefined && Number(error.code) === 3));
          if (missingDetail) {
            seen.add(nativeId);
            console.warn(`${this.sourceKey}: 상세 조회 건너뜀 (${nativeId}: ${message})`);
            continue;
          }
          console.warn(
            `${this.sourceKey}: 상세 조회 중단 (${message}) — ${collected.length}건까지 저장하고 다음 회차에 이어받습니다`,
          );
          this.errors.push(`상세 조회 중단: ${message}`);
          return collected;
        }

        const program = this.mapItem({ ...item, ...detail });
        if (!program) continue;
        seen.add(nativeId);
        collected.push(program);
      }
      if (items.length < this.pageSize || (totalCount !== null && page * this.pageSize >= totalCount)) {
        complete = true;
        break;
      }
    }
    if (!complete && options.maxPages === undefined) {
      throw new CollectorError(`${this.sourceKey}: 페이지 안전 한도에 도달해 전량 목록 여부를 확인할 수 없음`);
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
      const { items, totalCount } = await this.listPage(page);
      for (const item of items) {
        const nativeId = firstOf(item, ["servId"]);
        if (nativeId) ids.add(this.externalId(nativeId));
      }
      if (items.length < this.pageSize || (totalCount !== null && page * this.pageSize >= totalCount)) {
        complete = true;
        break;
      }
    }
    if (!complete) throw new CollectorError(`${this.sourceKey}: ID 전량 대조 페이지 안전 한도 도달`);
    return ids;
  }
}
