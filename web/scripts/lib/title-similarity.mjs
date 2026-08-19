/**
 * 공고 제목 유사도 (SPEC §3.3 중복 측정).
 *
 * `scripts/measure-duplicates.mjs` 가 쓰는 순수 함수만 모아 둔다. 스크립트 본문은
 * 실행형(top-level await + DB 접속)이라 테스트에서 import 할 수 없기 때문이다.
 * 이 측정 결과가 "병합 로직을 넣을지 소스를 줄일지"를 정하는 근거이므로,
 * 정규화가 조용히 no-op 이 되는 일이 없도록 테스트로 고정한다.
 */

/**
 * 제목에서 걷어낼 상투어. 어느 소스가 붙였는지에 따라 있기도 없기도 하다.
 *
 * **`\b` 로 감싸면 안 된다.** JS 의 `\b` 는 ASCII 기준 단어 경계라 한글 앞뒤에서는
 * 절대 성립하지 않는다 — `\b사업\b` 는 어떤 한국어 제목과도 매칭되지 않아 상투어 제거가
 * 통째로 no-op 이 되고, 중복률이 실제보다 낮게 나온다.
 *
 * 대신 **토큰 단위**로 지운다. "창업지원사업" 처럼 붙어 있는 경우는 접미사로 처리하고,
 * "사업자등록" 같은 다른 단어의 일부는 건드리지 않는다.
 */
export const BOILERPLATE = ["지원사업", "사업", "공고", "모집", "안내", "계획"];

export function stripBoilerplate(token) {
  let out = token;
  // 긴 것("지원사업")을 먼저 봐야 짧은 것("사업")이 먼저 먹지 않는다
  for (const word of BOILERPLATE) {
    if (out === word) return "";
    if (out.length > word.length && out.endsWith(word)) {
      out = out.slice(0, -word.length);
      break;
    }
  }
  return out;
}

/**
 * 제목 정규화. 같은 사업이 소스마다 다르게 표기되는 부분을 걷어낸다.
 * 예) "2026년 청년월세 한시 특별지원(2차)" / "[서울] 청년월세 한시 특별지원 사업"
 */
export function normalizeTitle(title) {
  return (title ?? "")
    .normalize("NFC")
    .replace(/\d{4}\s*년도?/gu, " ") // 연도
    .replace(/제?\s*\d+\s*차/gu, " ") // 회차
    .replace(/[[\]()〔〕【】「」『』<>《》]/gu, " ") // 괄호류
    .split(/[^\p{L}\p{N}]+/u) // 구두점·공백으로 토큰화
    .filter(Boolean)
    .map(stripBoilerplate)
    .join("")
    .toLowerCase();
}

/** 소관기관 정규화. "○○시청"/"○○시" 같은 표기 차이를 흡수한다. */
export function normalizeIssuer(issuer) {
  return (issuer ?? "")
    .normalize("NFC")
    .replace(/\s+/gu, "")
    .replace(/(청|처|부|위원회|공단|공사|원)$/u, "")
    .toLowerCase();
}

/** 문자 bigram 집합 — 한국어 제목에서 형태소 분석기 없이 쓸 수 있는 가장 무난한 표현 */
export function bigrams(text) {
  const set = new Set();
  if (!text) return set;
  if (text.length < 2) {
    set.add(text);
    return set;
  }
  for (let i = 0; i + 1 < text.length; i++) set.add(text.slice(i, i + 2));
  return set;
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared++;
  return shared / (a.size + b.size - shared);
}

/** 두 공고의 유사도. 소관기관이 같으면 같은 사업일 가능성이 크게 오른다. */
export function similarity(a, b) {
  const score = jaccard(bigrams(a.normTitle), bigrams(b.normTitle));
  const sameIssuer = a.normIssuer && a.normIssuer === b.normIssuer;
  return sameIssuer ? Math.min(1, score + 0.1) : score;
}

/** 측정 대상 행을 비교 가능한 형태로 준비한다 */
export function prepare(row) {
  return {
    ...row,
    normTitle: normalizeTitle(row.title),
    normIssuer: normalizeIssuer(row.issuer),
  };
}
