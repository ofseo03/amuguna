/**
 * form 분류 (SPEC §5).
 *
 * 결과 화면의 탭에만 쓴다 — 검색 전 필터가 아니라 결과를 본 뒤 좁히는 용도다.
 * 서버 전용 모듈(db/matching)과 분리해 두어 클라이언트 컴포넌트에서도 안전하게 import 한다.
 */
import type { ProgramForm } from "./types";

export const FORMS: ProgramForm[] = ["subsidy", "loan", "tax", "product", "law"];

export const FORM_LABEL: Record<ProgramForm, string> = {
  subsidy: "지원금",
  loan: "대출",
  tax: "세금",
  product: "금융상품",
  law: "법령",
};

/**
 * 금융상품에 해당해 금융소비자보호법 고지가 필요한 분류.
 *
 * 이 서비스는 금감원 금융상품통합비교공시 데이터를 **비교·정보 제공** 형태로 보여줄 뿐
 * 특정 상품의 계약 체결을 권유하지 않는다. 다만 화면 문구가 "당신께 추천"처럼 읽히면
 * 금소법상 권유·광고로 해석될 여지가 생기므로, 해당 분류에는 그 사실을 명시한다.
 */
export const FINANCIAL_PRODUCT_FORMS: ProgramForm[] = ["loan", "product"];

export function isFinancialProduct(form: ProgramForm): boolean {
  return FINANCIAL_PRODUCT_FORMS.includes(form);
}
