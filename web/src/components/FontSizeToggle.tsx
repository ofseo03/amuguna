"use client";

/**
 * 글자 크기 조절 슬라이더 (SPEC §8 접근성 — 고령층).
 * 전역 적용, localStorage 에 보존. 루트 font-size 를 바꾸므로 여백·행간도 함께 커진다.
 *
 * 16px ~ 22px 를 0.5px 씩 움직인다. 양 끝의 "가" 는 크기가 다르다 — 어느 쪽으로 밀어야
 * 커지는지가 글자 자체로 보인다. 손잡이는 24px 로 WCAG 2.5.8 최소 터치 크기를 지킨다.
 * 검은 전역 내비 위에 얹히므로 레일은 흐릿한 흰 선, 손잡이만 파랗게 채운다.
 *
 * 자기 자신을 조절하는 컨트롤이라 두 군데서 되먹임이 생긴다. 둘 다 막아야 안 떨린다.
 *
 *  1. 크기 — 이 컴포넌트만 rem 이 아니라 px 로 짠다(사이트에서 유일한 예외다).
 *     rem 이면 끌어서 루트 font-size 를 키우는 순간 레일도 같이 커진다.
 *  2. 위치 — 헤더 컨테이너 폭·여백이 rem 이라 글자가 커지면 레일이 화면에서 옆으로
 *     밀린다. 네이티브 range 는 매 이동마다 "포인터의 절대 위치 ÷ 요소 박스" 로 값을
 *     다시 재므로, 레일이 밀리면 손가락은 가만히 있어도 값이 튄다. 그래서 드래그는
 *     직접 처리한다 — 누른 순간의 값과 x 를 기억해 두고 그 뒤로는 "움직인 거리" 만
 *     더한다. 도중에 화면이 아무리 리플로우돼도 값에 영향이 없다.
 *
 * range 자체는 남겨 둔다. 키보드·스크린리더는 네이티브가 제일 낫고, 포인터만
 * 가로채면 되기 때문이다.
 */
import { useRef } from "react";
import { useSyncExternalStore } from "react";
import Icon from "./visual/Icon";
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  FONT_SIZE_STEP,
  getFontSize,
  getServerFontSize,
  setFontSize,
  subscribeFontSize,
} from "@/lib/font-size-store";

/** 레일과 손잡이 폭(px). CSS 의 ::-webkit-slider-thumb 폭과 반드시 같아야 정렬이 맞는다. */
const RAIL = 88;
const THUMB = 24;
const TRAVEL = RAIL - THUMB;
const RANGE = FONT_SIZE_MAX - FONT_SIZE_MIN;

const snap = (v: number) =>
  Math.round(v / FONT_SIZE_STEP) * FONT_SIZE_STEP;

export default function FontSizeToggle() {
  const size = useSyncExternalStore(
    subscribeFontSize,
    getFontSize,
    getServerFontSize,
  );
  const progress = (size - FONT_SIZE_MIN) / RANGE;

  const inputRef = useRef<HTMLInputElement>(null);
  /** 누른 순간의 포인터 x 와 값. 이후 값은 전부 여기서부터의 상대 이동으로 잰다. */
  const drag = useRef<{ x: number; value: number } | null>(null);

  function onPointerDown(e: React.PointerEvent<HTMLSpanElement>) {
    // 레일 아무 데나 눌러도 그 지점으로 옮겨 간다. 박스를 재는 건 이때 한 번뿐이다.
    const rect = e.currentTarget.getBoundingClientRect();
    const p = (e.clientX - rect.left - THUMB / 2) / TRAVEL;
    const value = snap(FONT_SIZE_MIN + Math.min(1, Math.max(0, p)) * RANGE);

    drag.current = { x: e.clientX, value };
    e.currentTarget.setPointerCapture(e.pointerId);
    inputRef.current?.focus();
    setFontSize(value);
  }

  function onPointerMove(e: React.PointerEvent<HTMLSpanElement>) {
    const d = drag.current;
    if (!d) return;
    setFontSize(snap(d.value + ((e.clientX - d.x) / TRAVEL) * RANGE));
  }

  return (
    <div className="fontsize-track flex select-none items-center gap-[8px] rounded-full py-[4px]">
      <span aria-hidden="true" className="text-on-dark">
        <Icon name="search" className="h-[17px] w-[17px]" />
      </span>

      <span
        aria-hidden="true"
        className="leading-none text-on-dark"
        style={{ fontSize: "13px" }}
      >
        가
      </span>

      <span
        className="relative flex h-[28px] cursor-pointer touch-none items-center"
        style={{ width: `${RAIL}px` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        {/* 레일과 손잡이는 장식이다. 상태는 아래 range 가 말한다. */}
        <span
          aria-hidden="true"
          className="absolute inset-x-0 h-[3px] rounded-full bg-white/25"
        />
        <span
          aria-hidden="true"
          className="absolute left-0 rounded-full bg-brand"
          style={{
            width: `${THUMB}px`,
            height: `${THUMB}px`,
            transform: `translateX(${progress * TRAVEL}px)`,
          }}
        />
        <input
          ref={inputRef}
          type="range"
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step={FONT_SIZE_STEP}
          value={size}
          onChange={(e) => setFontSize(Number(e.target.value))}
          aria-label="글자 크기 조절"
          aria-valuetext={`${Math.round((size / FONT_SIZE_MIN) * 100)}%`}
          className="fontsize-slider pointer-events-none absolute inset-0 h-full w-full opacity-0"
        />
      </span>

      <span
        aria-hidden="true"
        className="leading-none text-on-dark"
        style={{ fontSize: "19px" }}
      >
        가
      </span>
    </div>
  );
}
