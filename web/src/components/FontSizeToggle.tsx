"use client";

/**
 * 글자 크기 조절 토글 (SPEC §8 접근성 — 고령층).
 * 전역 적용, localStorage 에 보존. 루트 font-size 를 바꾸므로 여백·행간도 함께 커진다.
 *
 * 버튼 안의 "가" 는 일부러 크기가 다르다 — 누르면 어떤 크기가 되는지 미리 보여준다.
 * 다만 글자만 작을 뿐 버튼 자체는 최소 터치 영역(44px)을 지킨다. 글자 크기를 못 읽어서
 * 키우려는 사람이 정작 그 버튼을 못 누르면 앞뒤가 안 맞는다.
 *
 * 검은 전역 내비 위에 얹히므로 배경 없이 흰 글자로 두고, 선택된 것만 파란 알약으로 채운다.
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
  { key: "normal", title: "보통 크기", scale: 0.875 },
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
      className="flex items-center gap-0.5"
    >
      {SIZES.map((s) => (
        <button
          key={s.key}
          type="button"
          onClick={() => setFontSize(s.key)}
          aria-pressed={size === s.key}
          className={`press flex min-h-[2.75rem] min-w-[2.75rem] items-center justify-center rounded-full leading-none transition-colors ${
            size === s.key
              ? "bg-brand text-white"
              : "text-on-dark hover:bg-white/15"
          }`}
        >
          <span aria-hidden="true" style={{ fontSize: `${s.scale}rem` }}>
            가
          </span>
          <span className="sr-only">{s.title}</span>
        </button>
      ))}
    </div>
  );
}
