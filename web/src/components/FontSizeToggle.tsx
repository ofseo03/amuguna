"use client";

/**
 * 글자 크기 조절 토글 (SPEC §8 접근성 — 고령층).
 * 전역 적용, localStorage 에 보존. 루트 font-size 를 바꾸므로 여백·행간도 함께 커진다.
 */
import { useEffect, useState } from "react";

const SIZES = [
  { key: "normal", label: "가", title: "보통 크기" },
  { key: "large", label: "가", title: "크게" },
  { key: "xlarge", label: "가", title: "아주 크게" },
] as const;

type SizeKey = (typeof SIZES)[number]["key"];
const STORAGE_KEY = "amuguna.fontsize";

export default function FontSizeToggle() {
  const [size, setSize] = useState<SizeKey>("normal");

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY) as SizeKey | null;
    if (saved && SIZES.some((s) => s.key === saved)) setSize(saved);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.fontsize = size;
    window.localStorage.setItem(STORAGE_KEY, size);
  }, [size]);

  return (
    <div
      role="group"
      aria-label="글자 크기 조절"
      className="flex items-center gap-1 rounded-lg border border-line bg-white p-1"
    >
      {SIZES.map((s, i) => (
        <button
          key={s.key}
          type="button"
          onClick={() => setSize(s.key)}
          aria-pressed={size === s.key}
          title={s.title}
          className={`rounded px-2 py-1 leading-none transition-colors ${
            size === s.key
              ? "bg-brand text-white"
              : "text-ink-2 hover:bg-bg-sunken"
          }`}
          style={{ fontSize: `${0.8 + i * 0.22}rem` }}
        >
          <span aria-hidden="true">{s.label}</span>
          <span className="sr-only">{s.title}</span>
        </button>
      ))}
    </div>
  );
}
