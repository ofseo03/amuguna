import Link from "next/link";

/**
 * 버튼 문법은 두 가지뿐이다.
 *
 *  1. pill / pill-ghost — "행동"을 뜻하는 알약. 파랑 하나만 쓴다.
 *  2. utility — 내비·도구용 각진 사각(8px). 작고 조용하다.
 *
 * 눌림은 시스템 전체가 같은 동작(scale 0.95)을 쓴다 — .press 클래스.
 *
 * 접근성: 최소 터치 영역 44px 를 min-h 로 보장한다. 알약 모양이라 실제로 눌리는 폭은
 * 라벨보다 넓다. 크기는 rem 이라 글자 크기 토글을 따라 함께 커진다 (§8).
 */

export type ButtonVariant = "pill" | "pill-ghost" | "pill-on-dark" | "utility";

const BASE =
  "press inline-flex min-h-[2.75rem] items-center justify-center no-underline transition-colors";

const VARIANT: Record<ButtonVariant, string> = {
  // 알약 + 파랑 = 이 사이트에서 "누를 수 있는 것"의 신호
  pill: "rounded-full bg-brand px-[1.375rem] py-[0.7rem] font-normal text-white hover:bg-brand-dark",
  // 두 CTA 가 나란히 설 때의 두 번째. 유령 알약
  "pill-ghost":
    "rounded-full border border-brand px-[1.375rem] py-[0.7rem] font-normal text-brand hover:bg-brand-soft",
  // 어두운 면 위의 두 번째 CTA — 테두리·글자를 밝은 파랑으로 (진한 파랑은 어두운 면에서 2.7:1 로 묻힌다)
  "pill-on-dark":
    "rounded-full border border-brand-on-dark px-[1.375rem] py-[0.7rem] font-normal text-brand-on-dark hover:bg-white/10",
  // 내비 도구 버튼
  utility:
    "rounded-sm bg-ink px-[0.9375rem] py-[0.5rem] text-sm text-white hover:bg-ink-2",
};

type Props = {
  variant?: ButtonVariant;
  className?: string;
  children: React.ReactNode;
};

export function ActionLink({
  href,
  variant = "pill",
  className = "",
  children,
}: Props & { href: string }) {
  return (
    <Link href={href} className={`${BASE} ${VARIANT[variant]} ${className}`}>
      {children}
    </Link>
  );
}

export default function ActionButton({
  variant = "pill",
  className = "",
  children,
  ...rest
}: Props & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children">) {
  return (
    <button className={`${BASE} ${VARIANT[variant]} ${className}`} {...rest}>
      {children}
    </button>
  );
}
