/**
 * 전면(full-bleed) 타일 — 이 사이트의 구획 단위.
 *
 * 타일끼리는 간격 없이 맞붙고, 테두리도 그림자도 두지 않는다.
 * 밝은 면 ↔ 어두운 면으로 색이 바뀌는 것 자체가 구분선이다.
 *
 * tone 이 dark 계열이면 .on-dark 를 함께 붙인다 — 어두운 면에서는 포커스 링 색이
 * 밝은 파랑으로 바뀌어야 보인다 (globals.css).
 */

export type TileTone = "canvas" | "parchment" | "dark" | "dark-2" | "dark-3";

const TONE: Record<TileTone, string> = {
  canvas: "bg-bg text-ink",
  parchment: "bg-bg-soft text-ink",
  dark: "on-dark bg-tile-1 text-on-dark",
  "dark-2": "on-dark bg-tile-2 text-on-dark",
  "dark-3": "on-dark bg-tile-3 text-on-dark",
};

export function isDark(tone: TileTone) {
  return tone.startsWith("dark");
}

export default function Tile({
  tone = "canvas",
  className = "",
  innerClassName = "",
  children,
  ...rest
}: {
  tone?: TileTone;
  className?: string;
  innerClassName?: string;
  children: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLElement>, "className" | "children">) {
  return (
    <section className={`${TONE[tone]} ${className}`} {...rest}>
      {/* 세로 여백은 rem — 글자를 키우면 여백도 함께 커져야 밀도가 유지된다 */}
      <div
        className={`mx-auto max-w-[68rem] px-5 py-14 sm:px-8 sm:py-20 lg:py-[5rem] ${innerClassName}`}
      >
        {children}
      </div>
    </section>
  );
}

/**
 * 타일 머리 — 헤드라인 → 한 줄 태그라인 → CTA 한 쌍.
 * 가운데 정렬 스택이 기본이고, 글 위아래로 넉넉히 비운다.
 */
export function TileHead({
  headline,
  tagline,
  align = "center",
  children,
}: {
  headline: React.ReactNode;
  tagline?: React.ReactNode;
  align?: "center" | "start";
  children?: React.ReactNode;
}) {
  const a = align === "center" ? "text-center items-center" : "text-left items-start";
  return (
    <div className={`flex flex-col ${a}`}>
      <h2 className="t-display max-w-[24ch]">{headline}</h2>
      {tagline && (
        <p className="t-lead mt-4 max-w-[46ch] opacity-90">{tagline}</p>
      )}
      {children && (
        <div
          className={`mt-7 flex flex-wrap gap-4 ${align === "center" ? "justify-center" : ""}`}
        >
          {children}
        </div>
      )}
    </div>
  );
}
