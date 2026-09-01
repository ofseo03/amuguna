type CardCopy = {
  summary: string;
  apply_steps: string[];
};

type SummarizableProgram = {
  title?: string | null;
  body_text?: string | null;
  apply_method?: string | null;
  apply_url?: string | null;
};

function truncate(text: string, limit: number): string {
  const normalized = text.trim().replace(/\s+/gu, " ");
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1).trimEnd()}…`;
}

export function buildCardCopy(program: SummarizableProgram): CardCopy {
  const body = (program.body_text ?? "").trim().replace(/\s+/gu, " ");
  const sentence = body.match(/^(.{5,}?[.!?])(?:\s|$)/u)?.[1] ?? body;
  const channel = program.apply_method?.trim() || (program.apply_url ? "온라인 신청" : "소관 기관 문의");
  return {
    summary: truncate(sentence || program.title || "", 40),
    apply_steps: [
      "자격요건과 제출서류를 확인합니다.",
      /신청$|접수$/u.test(channel) ? `${channel}을 진행합니다.` : `${channel}을 통해 신청서를 접수합니다.`,
      "심사 결과와 지급 일정을 소관 기관에서 확인합니다.",
    ].map((step) => truncate(step, 60)),
  };
}
