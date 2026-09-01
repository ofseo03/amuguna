"use client";

/**
 * 화면 크기 조절 (SPEC §8 접근성 — 고령층).
 * 전역 적용, localStorage 에 보존. 루트 font-size 를 바꾸므로 여백·행간도 함께 커진다.
 *
 * 돋보기 버튼을 누르면 슬라이더가 열리고, 그 하나로 화면을 키우고 줄인다.
 * 단계 버튼("가 가 가")과 달리 지금 어디쯤인지가 눈에 보이고, 되돌리는 길도 같은 자리에 있다.
 *
 * 돋보기 안에 "가" 를 넣어 둔다 — 예전 버튼을 기억하는 사람이 같은 기능임을 바로 알아본다.
 *
 * 크기 관련 치수를 여기서만 px 로 잡는다. 슬라이더가 자기가 키운 배율을 따라 같이 커지면
 * 드는 손가락 밑에서 손잡이가 달아난다. 조절 도구는 제자리에 있어야 조절이 된다.
 */
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import {
  DEFAULT_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEP,
  getServerZoom,
  getZoom,
  setZoom,
  subscribeZoom,
} from "@/lib/font-size-store";

/** 돋보기 안에 "가" — 이 버튼이 글자를 키운다는 뜻을 그림만으로 전한다 */
function MagnifierGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="24"
      height="24"
    >
      <circle cx="10.5" cy="10.5" r="7" />
      <path d="m15.6 15.6 4.9 4.9" />
      <text
        x="10.5"
        y="14"
        textAnchor="middle"
        stroke="none"
        fill="currentColor"
        fontSize="9.5"
        fontWeight="600"
      >
        가
      </text>
    </svg>
  );
}

export default function ScreenZoomControl() {
  const zoom = useSyncExternalStore(subscribeZoom, getZoom, getServerZoom);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const panelId = useId();

  // 열면 바로 슬라이더에 초점을 준다 — 키보드만 쓰는 사람은 그 자리에서 좌우키로 조절한다
  useEffect(() => {
    if (open) sliderRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const atMin = zoom <= MIN_ZOOM;
  const atMax = zoom >= MAX_ZOOM;

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        className={`press flex min-h-[44px] items-center gap-[6px] rounded-full px-[10px] leading-none transition-colors ${
          open ? "bg-brand text-white" : "text-on-dark hover:bg-white/15"
        }`}
      >
        <MagnifierGlyph />
        <span className="text-[15px] font-medium">화면 크기</span>
        {zoom !== DEFAULT_ZOOM && (
          <span
            aria-hidden="true"
            className={`rounded-full px-[6px] py-[2px] text-[12px] font-semibold tabular-nums ${
              open ? "bg-white/25 text-white" : "bg-white/20 text-on-dark"
            }`}
          >
            {zoom}%
          </span>
        )}
        <span className="sr-only">
          현재 {zoom}퍼센트. 누르면 조절 슬라이더가 열립니다
        </span>
      </button>

      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="화면 크기 조절"
          className="absolute right-0 top-full z-50 mt-[8px] w-[328px] max-w-[calc(100vw-24px)] rounded-[18px] border border-line bg-bg p-[16px] text-ink shadow-product"
        >
          <div className="flex items-baseline justify-between">
            <p className="text-[16px] font-semibold">화면 크기</p>
            <p aria-hidden="true" className="text-[17px] font-semibold tabular-nums text-brand">
              {zoom}%
            </p>
          </div>

          <div className="mt-[10px] flex items-center gap-[8px]">
            <button
              type="button"
              onClick={() => setZoom(zoom - ZOOM_STEP)}
              disabled={atMin}
              className="press flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full border border-line bg-surface-pearl text-[20px] font-semibold leading-none disabled:opacity-40"
            >
              <span aria-hidden="true">−</span>
              <span className="sr-only">화면 작게</span>
            </button>

            <input
              ref={sliderRef}
              type="range"
              className="zoom-slider min-w-0 flex-1"
              /*
               * 지나온 트랙을 채운다. 단순 퍼센트로는 손잡이(28px) 폭만큼 어긋나므로
               * 손잡이가 실제로 움직이는 구간(전체 - 28px)에 비례시키고 반지름을 더한다.
               */
              style={
                {
                  "--fill": `calc(14px + (100% - 28px) * ${
                    (zoom - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM)
                  })`,
                } as React.CSSProperties
              }
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={ZOOM_STEP}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              aria-label="화면 크기"
              aria-valuetext={`${zoom}퍼센트`}
            />

            <button
              type="button"
              onClick={() => setZoom(zoom + ZOOM_STEP)}
              disabled={atMax}
              className="press flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full border border-line bg-surface-pearl text-[20px] font-semibold leading-none disabled:opacity-40"
            >
              <span aria-hidden="true">+</span>
              <span className="sr-only">화면 크게</span>
            </button>
          </div>

          <div
            aria-hidden="true"
            className="mt-[2px] flex justify-between px-[52px] text-[14px] text-ink-3"
          >
            <span>작게</span>
            <span>크게</span>
          </div>

          <button
            type="button"
            onClick={() => setZoom(DEFAULT_ZOOM)}
            disabled={zoom === DEFAULT_ZOOM}
            className="press mt-[10px] flex min-h-[44px] w-full items-center justify-center rounded-[11px] border border-line bg-surface-pearl text-[16px] font-medium disabled:opacity-40"
          >
            기본 크기로 되돌리기
          </button>
        </div>
      )}
    </div>
  );
}
