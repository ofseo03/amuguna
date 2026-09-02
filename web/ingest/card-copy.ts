type CardCopy = {
  summary: string;
  apply_steps: string[];
};

type SummarizableProgram = {
  title?: string | null;
  body_text?: string | null;
  apply_method?: string | null;
  apply_url?: string | null;
  form?: "subsidy" | "loan" | "tax" | "product" | "law";
};

function truncate(text: string, limit: number): string {
  const normalized = text.trim().replace(/\s+/gu, " ");
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1).trimEnd()}…`;
}

export function buildCardCopy(program: SummarizableProgram): CardCopy {
  const body = (program.body_text ?? "").trim().replace(/\s+/gu, " ");
  const sentence = body.match(/^(.{5,}?[.!?])(?:\s|$)/u)?.[1] ?? body;
  const channel = program.apply_method?.trim() || (program.apply_url ? "온라인 신청" : "소관 기관 문의");
  const applySteps = program.form === "product"
    ? [
        "가입 대상과 금리·기간을 확인합니다.",
        `${channel}을 통해 가입 방법을 확인합니다.`,
        "최종 금리와 만기 조건을 금융회사에서 확인합니다.",
      ]
    : program.form === "loan"
      ? [
          "대출 대상과 한도·금리를 확인합니다.",
          `${channel}을 통해 상담 또는 신청을 진행합니다.`,
          "심사 결과와 상환 조건을 취급 기관에서 확인합니다.",
        ]
      : [
          "자격요건과 제출서류를 확인합니다.",
          /신청$|접수$/u.test(channel) ? `${channel}을 진행합니다.` : `${channel}을 통해 신청서를 접수합니다.`,
          "심사 결과와 지급 일정을 소관 기관에서 확인합니다.",
        ];
  return {
    summary: truncate(sentence || program.title || "", 40),
    apply_steps: applySteps.map((step) => truncate(step, 60)),
  };
}
