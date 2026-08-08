/**
 * 행정용어 툴팁 (SPEC §8 접근성).
 *
 * <abbr> + title 은 키보드·스크린리더 지원이 들쭉날쭉하므로
 * 보이는 설명을 details 없이 <span> + aria-describedby 로 붙이고,
 * 화면에는 hover/focus 시 노출한다.
 */
import type { ReactNode } from "react";

/** 자주 나오는 행정용어 사전. 필요할 때 여기에 추가한다. */
export const GLOSSARY: Record<string, string> = {
  소득분위:
    "전체 가구를 소득 순으로 10등분한 순위입니다. 1분위가 가장 소득이 낮습니다.",
  중위소득:
    "전 국민을 소득 순으로 줄 세웠을 때 정확히 가운데 있는 가구의 소득입니다. 복지 기준선으로 쓰입니다.",
  무주택세대주:
    "본인과 같이 사는 세대원 모두가 집을 소유하지 않은 경우의 세대주를 말합니다.",
  근접탈락:
    "자격 조건 중 딱 하나만 어긋나 대상에서 빠진 경우입니다. 조건이 바뀌면 받을 수 있습니다.",
  상시: "정해진 마감일 없이 예산이 있는 동안 계속 신청받는 사업입니다.",
  소상공인:
    "상시근로자 5인 미만(제조·건설·운수·광업은 10인 미만)의 소규모 사업자입니다.",
  차상위계층:
    "기초생활수급자는 아니지만 소득이 그 바로 위 수준이어서 지원이 필요한 계층입니다.",
  소득인정액:
    "실제 벌어들인 소득에 재산을 소득으로 환산한 금액을 더한 값입니다. 복지 자격 판정에 씁니다.",
};

interface TermProps {
  /** GLOSSARY 키. 생략하면 children 텍스트를 키로 쓴다 */
  name?: string;
  desc?: string;
  children: ReactNode;
}

let seq = 0;

export default function Term({ name, desc, children }: TermProps) {
  const key = name ?? (typeof children === "string" ? children : "");
  const text = desc ?? GLOSSARY[key];
  if (!text) return <>{children}</>;

  const id = `term-${key.replace(/\s/g, "")}-${seq++}`;
  return (
    <span className="relative inline-block group">
      <span className="term" tabIndex={0} aria-describedby={id}>
        {children}
      </span>
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none absolute left-0 top-full z-20 mt-1 hidden w-64 rounded-lg border border-line bg-white p-3 text-sm font-normal leading-relaxed text-ink-2 shadow-lg group-hover:block group-focus-within:block"
      >
        {text}
      </span>
    </span>
  );
}
