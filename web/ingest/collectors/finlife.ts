import { CollectedProgram } from "../models";
import { Collector, firstOf, isRecord, parseAmount, recordOrUndefined } from "./base";

export const TOP_FIN_GRP_NO = "020000";

function formatRate(value: unknown): string {
  return typeof value === "number" && Number.isInteger(value) ? value.toFixed(1) : String(value ?? "");
}

export class FinlifeCollector extends Collector {
  readonly sourceKey = "finlife";
  readonly endpoint = "https://finlife.fss.or.kr/finlifeapi/depositProductsSearch.json";
  readonly idListEndpoint = this.endpoint;
  override readonly defaultForm = "product";

  protected queryParams({ page }: { since: string | null; page: number }) {
    return {
      auth: this.settings.data_go_kr_api_key,
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

  protected mapItem(item: Record<string, unknown>): CollectedProgram | null {
    const productCode = firstOf(item, ["fin_prdt_cd"]);
    const companyCode = firstOf(item, ["fin_co_no"]);
    const productName = firstOf(item, ["fin_prdt_nm"]);
    if (!productCode || !productName) return null;

    const company = firstOf(item, ["kor_co_nm"], "금융회사");
    const joinWay = firstOf(item, ["join_way"]);
    const joinMember = firstOf(item, ["join_member"]);
    const special = firstOf(item, ["spcl_cnd"]);
    const note = firstOf(item, ["etc_note"]);
    const deny = firstOf(item, ["join_deny"]);
    const options = Array.isArray(item._options) ? item._options.filter(isRecord) : [];
    const rateLines = options.map(
      (option) =>
        `- ${String(option.save_trm)}개월 ${String(option.intr_rate_type_nm ?? "")} 기본 ${formatRate(option.intr_rate)}% / 최고 ${formatRate(option.intr_rate2)}%`,
    );
    const bodyText = [
      `${company}의 ${productName} 상품입니다.`,
      joinWay && `[가입방법] ${joinWay}`,
      rateLines.length && `[금리]\n${rateLines.join("\n")}`,
      special && `[우대조건]\n${special}`,
      note && `[유의사항]\n${note}`,
      joinMember && `[가입대상]\n${joinMember}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const limitText = firstOf(item, ["max_limit"]);
    let [amountMin, amountMax] = parseAmount(/^\d+$/.test(limitText) ? `${limitText}원` : limitText);
    if (/^\d+$/.test(limitText)) {
      amountMin = null;
      amountMax = Number.parseInt(limitText, 10);
    }

    return new CollectedProgram({
      external_id: this.externalId(`${companyCode}-${productCode}`),
      source_key: this.sourceKey,
      source_url: "https://finlife.fss.or.kr/finlife/svings/fdrmDpst/list.do?menuId=2000100",
      title: `[${company}] ${productName}`,
      body_text: bodyText,
      eligibility_text: joinMember || deny,
      form: this.defaultForm,
      issuer: company,
      issuer_level: "central",
      benefit_amount_text: limitText ? `최고한도 ${limitText}원` : "",
      benefit_amount_min: amountMin,
      benefit_amount_max: amountMax,
      apply_url: "https://finlife.fss.or.kr/",
      apply_method: joinWay || "영업점·인터넷뱅킹",
      starts_at: null,
      ends_at: null,
      is_always_open: true,
      raw_body: item,
    });
  }
}
