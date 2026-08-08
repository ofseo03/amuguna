#!/usr/bin/env node
/**
 * 빌드 타임 계약 데이터 복사 스크립트.
 *
 * /shared/*.json 은 팀 공통 계약 데이터(행정구역 코드 · 직업 대분류 · 소득분위 라벨)이며
 * 원본은 절대 수정하지 않는다. 웹 번들이 저장소 루트 밖을 참조하지 않도록
 * dev/build 직전에 web/src/data/ 로 읽기 전용 복사본을 만든다.
 *
 * 복사본이 이미 있고 원본이 없으면(예: web/ 만 배포된 경우) 조용히 통과한다.
 */
import { readdirSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "..", "..", "shared");
const DEST = resolve(here, "..", "src", "data");

if (!existsSync(SRC)) {
  if (existsSync(DEST)) {
    console.log("[copy-shared] ../shared 없음 — 기존 src/data 복사본 사용");
    process.exit(0);
  }
  console.error("[copy-shared] ../shared 도, src/data 복사본도 없습니다.");
  process.exit(1);
}

mkdirSync(DEST, { recursive: true });
let n = 0;
for (const f of readdirSync(SRC)) {
  if (!f.endsWith(".json")) continue;
  copyFileSync(join(SRC, f), join(DEST, f));
  n++;
}
console.log(`[copy-shared] ${n}개 계약 데이터 파일 복사 → src/data/`);
