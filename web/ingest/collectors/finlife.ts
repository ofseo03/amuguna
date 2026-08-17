import { CollectedProgram } from "../models";
import {
  Collector,
  CollectorError,
  firstOf,
  isRecord,
  PAGINATION_SAFETY_LIMIT,
  parseAmount,
  recordOrUndefined,
  type FetchOptions,
} from "./base";

export const TOP_FIN_GRP_NO = "020000";
export const FINLIFE_GROUPS = ["020000", "030200", "030300", "050000", "060000"] as const;

const PRODUCTS = [
  ["deposit", "depositProductsSearch", "예금", "product"],
  ["saving", "savingProductsSearch", "적금", "product"],
  ["annuity", "annuitySavingProductsSearch", "연금저축", "product"],
  ["mortgage", "mortgageLoanProductsSearch", "주택담보대출", "loan"],
  ["rent", "rentHouseLoanProductsSearch", "전세자금대출", "loan"],
  ["credit", "creditLoanProductsSearch", "개인신용대출", "loan"],
] as const;

export const FINLIFE_PRODUCTS = PRODUCTS.map(([, endpoint]) => endpoint);

const API_ROOT = "https://finlife.fss.or.kr/finlifeapi";
const SOURCE_URL = "https://finlife.fss.or.kr/finlife/main/contents.do?menuNo=700029";
const NO_ELIGIBILITY_INFO = "[자격요건 정보 없음]";

function formatRate(value: unknown): string {
  return typeof value === "number" && Number.isInteger(value) ? value.toFixed(1) : String(value ?? "");
}

function optionLine(option: Record<string, unknown>): string {
  if (option.intr_rate !== undefined || option.intr_rate2 !== undefined) {
    return `${String(option.save_trm ?? "")}개월 ${String(option.intr_rate_type_nm ?? "")} 기본 ${formatRate(option.intr_rate)}% / 최고 ${formatRate(option.intr_rate2)}%`.trim();
  }
  const labels: [string, string][] = [
    ["mrtg_type_nm", "담보유형"],
    ["rpay_type_nm", "상환방식"],
    ["lend_rate_type_nm", "대출금리유형"],
    ["lend_rate_min", "최저금리(%)"],
    ["lend_rate_max", "최고금리(%)"],
    ["lend_rate_avg", "평균금리(%)"],
    ["crdt_grad_avg", "평균금리(%)"],
    ["dcls_rate", "공시이율(%)"],
    ["guar_rate", "최저보증이율(%)"],
  ];
  return labels
    .flatMap(([key, label]) =>
      option[key] === null || option[key] === undefined || option[key] === ""
        ? []
        : [`${label} ${formatRate(option[key])}`],
    )
    .join(" · ");
}

export class FinlifeCollector extends Collector {
  readonly sourceKey = "finlife";
  readonly endpoint = `${API_ROOT}/depositProductsSearch.json`;
  readonly idListEndpoint = this.endpoint;
  override readonly defaultForm = "product";

  protected queryParams({ page }: { since: string | null; page: number }) {
    return {
      auth: this.requireApiKey("FINLIFE_API_KEY", this.settings.finlife_api_key),
      topFinGrpNo: TOP_FIN_GRP_NO,
      pageNo: page,
    };
  }

  protected items(payload: unknown): Record<string, unknown>[] {
    if (!isRecord(payload)) return [];
    const result = recordOrUndefined(payload.result) ?? {};
    const base = Array.isArray(result.baseList) ? result.baseList : [];
    const options = Array.isArray(result.optionList) ? result.optionList : [];
    const byProduct = new Map<string, Record<string, unknown>[]>();
    for (const option of options) {
      if (!isRecord(option)) continue;
      const code = String(option.fin_prdt_cd);
      byProduct.set(code, [...(byProduct.get(code) ?? []), option]);
    }
    return base.filter(isRecord).map((row) => ({
      ...row,
      _options: byProduct.get(String(row.fin_prdt_cd)) ?? [],
    }));
  }

  override async fetch(options: FetchOptions = {}): Promise<CollectedProgram[]> {
    if (this.useFixtures) return super.fetch(options);
    this.observedCount = 0;
    this.errors.length = 0;
    const maxPages = options.maxPages ?? PAGINATION_SAFETY_LIMIT;
    const collected: CollectedProgram[] = [];
    const seen = new Set<string>();
    const auth = this.requireApiKey("FINLIFE_API_KEY", this.settings.finlife_api_key);

    for (const [kind, endpointName, label, form] of PRODUCTS) {
      for (const group of FINLIFE_GROUPS) {
        let complete = false;
        for (let page = 1; page <= maxPages; page++) {
          const payload = await this.request(
            { auth, topFinGrpNo: group, pageNo: page },
            async (response) => (await response.json()) as unknown,
            `${API_ROOT}/${endpointName}.json`,
          );
          const result = isRecord(payload) ? recordOrUndefined(payload.result) : undefined;
          if (!result || String(result.err_cd) !== "000" || !Array.isArray(result.baseList)) {
            throw new CollectorError(
              `${this.sourceKey}: ${endpointName}/${group} 오류 또는 잘못된 응답 봉투${result?.err_msg ? `: ${String(result.err_msg)}` : ""}`,
            );
          }
          const rows = this.items(payload).map((row) => ({
            ...row,
            _productKind: kind,
            _productLabel: label,
            _productForm: form,
            _topFinGrpNo: group,
          }));
          this.observedCount = (this.observedCount ?? 0) + rows.length;
          for (const row of rows) {
            const program = this.mapItem(row);
            if (!program || seen.has(program.external_id)) continue;
            seen.add(program.external_id);
            collected.push(program);
          }

          const hasLastPage = result.max_page_no !== undefined &&
            result.max_page_no !== null && result.max_page_no !== "";
          const lastPage = Number(result.max_page_no);
          if ((hasLastPage && Number.isInteger(lastPage) && lastPage >= 0)
            ? page >= lastPage
            : rows.length < this.pageSize) {
            complete = true;
            break;
          }
        }
        if (!complete && options.maxPages === undefined) {
          throw new CollectorError(`${this.sourceKey}: ${endpointName}/${group} 페이지 안전 한도 도달`);
        }
      }
    }
    return collected;
  }

  protected mapItem(item: Record<string, unknown>): CollectedProgram | null {
    const productCode = firstOf(item, ["fin_prdt_cd"]);
    const companyCode = firstOf(item, ["fin_co_no"]);
    const productName = firstOf(item, ["fin_prdt_nm"]);
    if (!productCode || !productName) return null;

    const kind = firstOf(item, ["_productKind"], "deposit");
    const productLabel = firstOf(item, ["_productLabel"], "예금");
    const group = firstOf(item, ["_topFinGrpNo"], TOP_FIN_GRP_NO);
    const company = firstOf(item, ["kor_co_nm"], "금융회사");
    const joinWay = firstOf(item, ["join_way"]);
    const joinMember = firstOf(item, ["join_member"]);
    const special = firstOf(item, ["spcl_cnd"]);
    const note = firstOf(item, ["etc_note"]);
    const deny = firstOf(item, ["join_deny"]);
    const options = Array.isArray(item._options) ? item._options.filter(isRecord) : [];
    const optionLines = options.map(optionLine).filter(Boolean).map((line) => `- ${line}`);
    const bodyText = [
      `${company}의 ${productLabel} 상품 ${productName}입니다.`,
      joinWay && `[가입방법] ${joinWay}`,
      optionLines.length && `[금리·조건]\n${optionLines.join("\n")}`,
      special && `[우대조건]\n${special}`,
      note && `[유의사항]\n${note}`,
      joinMember && `[가입대상]\n${joinMember}`,
      deny && `[가입제한]\n${deny}`,
      firstOf(item, ["loan_inci_expn"]) && `[부대비용] ${firstOf(item, ["loan_inci_expn"])}`,
      firstOf(item, ["erly_rpay_fee"]) && `[중도상환수수료] ${firstOf(item, ["erly_rpay_fee"])}`,
      firstOf(item, ["dly_rate"]) && `[연체이율] ${firstOf(item, ["dly_rate"])}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const limitText = firstOf(item, ["max_limit", "loan_lmt"]);
    let [amountMin, amountMax] = parseAmount(/^\d+$/.test(limitText) ? `${limitText}원` : limitText);
    if (/^\d+$/.test(limitText)) {
      amountMin = null;
      amountMax = Number.parseInt(limitText, 10);
    }
    const nativeId = kind === "deposit"
      ? `${companyCode}-${productCode}`
      : `${kind}-${group}-${companyCode}-${productCode}`;

    return new CollectedProgram({
      external_id: this.externalId(nativeId),
      source_key: this.sourceKey,
      source_url: SOURCE_URL,
      title: `[${company}] ${productName}`,
      body_text: bodyText,
      eligibility_text: joinMember || NO_ELIGIBILITY_INFO,
      form: firstOf(item, ["_productForm"], this.defaultForm) === "loan" ? "loan" : "product",
      issuer: company,
      issuer_level: "central",
      benefit_amount_text: limitText ? `최고한도 ${limitText}${/^\d+$/.test(limitText) ? "원" : ""}` : "",
      benefit_amount_min: amountMin,
      benefit_amount_max: amountMax,
      apply_url: "https://finlife.fss.or.kr/",
      apply_method: joinWay || "금융회사 확인",
      starts_at: null,
      ends_at: null,
      is_always_open: true,
      raw_body: item,
    });
  }
}
