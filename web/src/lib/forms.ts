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
