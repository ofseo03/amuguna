"use client";

/**
 * 글자 크기 조절 토글 (SPEC §8 접근성 — 고령층).
 * 전역 적용, localStorage 에 보존. 루트 font-size 를 바꾸므로 여백·행간도 함께 커진다.
 */
import { useSyncExternalStore } from "react";
import {
  getFontSize,
  getServerFontSize,
  setFontSize,
  subscribeFontSize,
  type FontSize,
} from "@/lib/font-size-store";

const SIZES: { key: FontSize; title: string; scale: number }[] = [
  { key: "normal", title: "보통 크기", scale: 0.8 },
  { key: "large", title: "크게", scale: 1.0 },
  { key: "xlarge", title: "아주 크게", scale: 1.22 },
];

export default function FontSizeToggle() {
  const size = useSyncExternalStore(
    subscribeFontSize,
    getFontSize,
    getServerFontSize,
  );

  return (
    <div
      role="group"
      aria-label="글자 크기 조절"
      className="flex items-center gap-1 rounded-lg border border-line bg-white p-1"
    >
      {SIZES.map((s) => (
        <button
          key={s.key}
          type="button"
          onClick={() => setFontSize(s.key)}
          aria-pressed={size === s.key}
          className={`rounded px-2 py-1 leading-none transition-colors ${
            size === s.key ? "bg-brand text-white" : "text-ink-2 hover:bg-bg-sunken"
          }`}
          style={{ fontSize: `${s.scale}rem` }}
        >
          <span aria-hidden="true">가</span>
          <span className="sr-only">{s.title}</span>
        </button>
      ))}
    </div>
  );
}
