import { CollectedProgram } from "../models";
import { Collector, firstOf, isRecord, parseAmount, recordOrUndefined } from "./base";

function splitPeriod(text: string): [string | null, string | null, boolean] {
  if (!text) return [null, null, false];
  const dates = [...text.matchAll(/(\d{4})[./-]?(\d{2})[./-]?(\d{2})/g)].map(
    (match) => `${match[1]}-${match[2]}-${match[3]}`,
  );
  const always = /예산\s*소진|상시|연중/.test(text);
  if (dates.length >= 2) return [dates[0], dates[1], false];
  if (dates.length === 1) return [dates[0], null, true];
  return [null, null, always];
}

export class BizinfoCollector extends Collector {
  readonly sourceKey = "bizinfo";
  readonly endpoint = "https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do";
  readonly idListEndpoint = this.endpoint;
  override readonly defaultForm = "loan";

  protected queryParams({ since, page }: { since: string | null; page: number }) {
    const params: Record<string, string | number> = {
      crtfcKey: this.settings.data_go_kr_api_key,
      dataType: "json",
      pageUnit: this.pageSize,
      pageIndex: page,
    };
    if (since) params.searchBgnDe = since.replaceAll("-", "");
    return params;
  }

  protected items(payload: unknown): Record<string, unknown>[] {
    if (!isRecord(payload)) return [];
    const response = recordOrUndefined(payload.response);
    const body = recordOrUndefined(response?.body);
    let items: unknown = payload.jsonArray ?? body?.items;
    if (isRecord(items)) items = [items];
    return Array.isArray(items) ? items.filter(isRecord) : [];
  }

  protected mapItem(item: Record<string, unknown>): CollectedProgram | null {
    const nativeId = firstOf(item, ["pblancId", "pblance_id"]);
    const title = firstOf(item, ["pblancNm", "pblanc_nm"]);
    if (!nativeId || !title) return null;

    const summary = firstOf(item, ["bsnsSumryCn", "bsns_sumry_cn"]);
    const target = firstOf(item, ["trgetNm", "trget_nm"]);
    const realm = firstOf(item, ["pldirSportRealmLclasCodeNm"]);
    const bodyText = [
      summary,
      realm && `[지원분야] ${realm}`,
      target && `[지원대상]\n${target}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const issuer = firstOf(item, ["jrsdInsttNm", "excInsttNm"], "중소벤처기업부");
    const issuerLevel = [
      "서울",
      "부산",
      "대구",
      "인천",
      "광주",
      "대전",
      "울산",
      "세종",
      "경기",
      "강원",
      "충청",
      "전라",
      "경상",
      "제주",
      "전북",
      "전남",
      "경북",
      "경남",
      "충북",
      "충남",
    ].some((prefix) => issuer.startsWith(prefix))
      ? "metro"
      : "central";
    const benefitText = firstOf(item, ["sportScvlNm", "sportAmtCn"]);
    const [amountMin, amountMax] = parseAmount(benefitText || summary);
    const [startsAt, endsAt, always] = splitPeriod(firstOf(item, ["reqstBeginEndDe"]));

    return new CollectedProgram({
      external_id: this.externalId(nativeId),
      source_key: this.sourceKey,
      source_url: firstOf(
        item,
        ["pblancUrl", "rceptEngnHmpgUrl"],
        `https://www.bizinfo.go.kr/web/lay1/bbs/S1T122C128/AS/74/view.do?pblancId=${nativeId}`,
      ),
      title,
      body_text: bodyText || title,
      eligibility_text: target,
      form: this.defaultForm,
      issuer,
      issuer_level: issuerLevel,
      benefit_amount_text: benefitText,
      benefit_amount_min: amountMin,
      benefit_amount_max: amountMax,
      apply_url: firstOf(item, ["rceptEngnHmpgUrl", "pblancUrl"]),
      apply_method: firstOf(item, ["reqstMthPapersCn", "rceptMthNm"], "온라인 신청"),
      starts_at: startsAt,
      ends_at: endsAt,
      is_always_open: always && endsAt === null,
      raw_body: item,
    });
  }
}
