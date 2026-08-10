import { readFileSync } from "node:fs";

type RegionEntry = { code: string; name: string; sido: string };
type RegionData = {
  sido: Array<{ code: string; name: string }>;
  sigungu: Array<{ code: string; name: string; sido: string }>;
};
type OccupationData = {
  categories: Array<{ code: string; synonyms: string[] }>;
};
type MidincomeData = {
  mapping: Array<{ max_percent: number | null; decile: number }>;
};

function load<T>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`../../shared/${name}`, import.meta.url), "utf8"),
  ) as T;
}

const midincome = load<MidincomeData>("midincome_to_decile.json");
const regions = load<RegionData>("regions.json");
const occupations = load<OccupationData>("occupations.json");

export function midrateToDecile(percent: number): number {
  return (
    midincome.mapping.find(
      ({ max_percent }) => max_percent === null || percent <= max_percent,
    )?.decile ?? 10
  );
}

const SIDO_ALIAS_SUFFIXES = [
  "특별자치시",
  "특별자치도",
  "특별시",
  "광역시",
  "특별시",
  "도",
  "시",
];

function sidoAliases(name: string): string[] {
  const aliases = new Set([name]);
  let stem = name;
  for (const suffix of SIDO_ALIAS_SUFFIXES) {
    if (stem.endsWith(suffix) && stem.length > suffix.length) {
      stem = stem.slice(0, -suffix.length);
      break;
    }
  }
  if (stem !== name) {
    aliases.add(stem);
    aliases.add(
      stem +
        (name.endsWith("특별시") ||
        name.endsWith("광역시") ||
        name.endsWith("특별자치시")
          ? "시"
          : "도"),
    );
  }
  if (stem.length === 3 && "라청상".includes(stem[1])) {
    aliases.add(stem[0] + stem[2]);
  }
  return [...aliases].sort((a, b) => b.length - a.length);
}

function add<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

const sidoIndex = new Map<string, RegionEntry[]>();
const sigunguIndex = new Map<string, RegionEntry[]>();
for (const row of regions.sido) {
  const entry = { code: row.code, name: row.name, sido: row.code };
  for (const alias of sidoAliases(row.name)) add(sidoIndex, alias, entry);
}
for (const row of regions.sigungu) {
  const entry = { code: row.code, name: row.name, sido: row.sido };
  add(sigunguIndex, row.name, entry);
  const [head, tail] = row.name.split(" ", 2);
  if (tail) add(sigunguIndex, head, { code: row.sido, name: head, sido: row.sido });
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dictionaryPattern(names: Iterable<string>): RegExp {
  return new RegExp(
    [...names]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegex)
      .join("|"),
    "g",
  );
}

const sigunguPattern = dictionaryPattern(sigunguIndex.keys());
const sidoPattern = dictionaryPattern(sidoIndex.keys());

const REGION_BLOCKERS = [
  "여성가족부",
  "중소벤처기업부",
  "서울보증보험",
  "서울신용보증재단",
];

function blocked(
  text: string,
  start: number,
  end: number,
  blockers: readonly string[],
): boolean {
  for (const word of blockers) {
    const left = Math.max(0, start - word.length + 1);
    for (let at = text.indexOf(word, left); at !== -1 && at < end; at = text.indexOf(word, at + 1)) {
      if (at + word.length > start) return true;
    }
  }
  return false;
}

type TextMatch = { text: string; start: number; end: number };
export type LookupMatch = TextMatch & { codes: string[] };
export type LookupMeta = { matches: LookupMatch[]; rejected: boolean };

function matches(pattern: RegExp, text: string): TextMatch[] {
  return [...text.matchAll(pattern)].map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
}

export function clauseBounds(text: string, start: number, end: number): [number, number] {
  let left = 0;
  let right = text.length;
  for (const match of text.matchAll(/[\n·;,]|(?<=[.。])\s/gu)) {
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;
    if (matchEnd <= start) left = matchEnd;
    else if (matchStart >= end) {
      right = matchStart;
      break;
    }
  }
  return [left, right];
}

export function clauseOf(text: string, start: number, end: number): string {
  const [left, right] = clauseBounds(text, start, end);
  return text.slice(left, right).replace(/^[ \t\-–—·]+|[ \t\-–—·]+$/gu, "");
}

const NON_REQUIREMENT_MARKERS = [
  "제외",
  "불가",
  "해당하지 않",
  "신청할 수 없",
  "참여할 수 없",
  "지원하지 않",
  "면제",
  "우선지원",
  "우선 지원",
  "우선 선정",
  "우선 선발",
  "우선적으로 선정",
  "우선적으로 선발",
  "우대",
  "가점",
  "추가 혜택",
];

export function nonRequirementReason(text: string, start: number, end: number): string | null {
  const [left, right] = clauseBounds(text, start, end);
  const clause = text.slice(left, right);
  const candidate = start - left;
  for (const marker of NON_REQUIREMENT_MARKERS) {
    const at = clause.indexOf(marker);
    if (at === -1) continue;
    if (
      candidate !== -1 &&
      candidate < at &&
      /(?:이되|다만|그러나|반면|중|가운데|지원하며|지원하고|지원합니다)/u.test(
        clause.slice(candidate + (end - start), at),
      )
    ) {
      continue;
    }
    return marker;
  }
  return null;
}

export function lookupRegions(text: string): [string[], string[], LookupMeta] {
  const codes: string[] = [];
  const evidence: string[] = [];
  const accepted: LookupMatch[] = [];
  let rejected = false;
  const sigunguMatches = matches(sigunguPattern, text).filter((match) => {
    if (blocked(text, match.start, match.end, REGION_BLOCKERS)) return false;
    if (nonRequirementReason(text, match.start, match.end)) {
      rejected = true;
      return false;
    }
    return true;
  });

  const sidoHits: Array<{ match: TextMatch; entry: RegionEntry }> = [];
  for (const match of matches(sidoPattern, text)) {
    if (blocked(text, match.start, match.end, REGION_BLOCKERS)) continue;
    if (nonRequirementReason(text, match.start, match.end)) {
      rejected = true;
      continue;
    }
    if (
      sigunguMatches.some(
        ({ start, end }) => match.start < end && start < match.end,
      )
    ) {
      continue;
    }
    const entries = sidoIndex.get(match.text) ?? [];
    if (entries.length === 1) sidoHits.push({ match, entry: entries[0] });
  }

  const consumedSido = new Set<string>();
  for (const match of sigunguMatches) {
    const candidates = sigunguIndex.get(match.text) ?? [];
    const context = sidoHits.filter(({ match: sidoMatch }) => sidoMatch.start < match.start);
    const nearest = context.at(-1)?.entry;
    const matched = nearest
      ? candidates.filter(({ sido }) => sido === nearest.sido)
      : candidates;
    if (matched.length !== 1) continue;
    const entry = matched[0];
    if (!codes.includes(entry.code)) {
      codes.push(entry.code);
      evidence.push(match.text);
    }
    accepted.push({ ...match, codes: [entry.code] });
    consumedSido.add(entry.sido);
  }

  for (const { match, entry } of sidoHits) {
    if (consumedSido.has(entry.sido)) continue;
    if (!codes.includes(entry.code)) {
      codes.push(entry.code);
      evidence.push(entry.name);
    }
    accepted.push({ ...match, codes: [entry.code] });
    consumedSido.add(entry.sido);
  }
  return [codes, evidence, { matches: accepted, rejected }];
}

const occupationIndex = new Map<string, string[]>();
for (const row of occupations.categories) {
  for (const synonym of row.synonyms) add(occupationIndex, synonym, row.code);
}

export const occupationCodes = new Set(
  occupations.categories.map(({ code }) => code),
);

const occupationPattern = dictionaryPattern(occupationIndex.keys());
const OCCUPATION_BLOCKERS = [
  "노인장기요양",
  "노인복지관",
  "노인일자리",
  "여성가족부",
  "소상공인시장진흥공단",
  "중소기업진흥공단",
  "농업기술센터",
  "무직자대출",
  "학생증",
  "중소기업",
  "여성기업",
  "상시근로자",
  "사업자등록",
];
const DEPENDENT_VERBS = [
  "모시",
  "부양",
  "양육",
  "돌보",
  "를 둔",
  "을 둔",
  "둔 가구",
  "동거하는",
  "포함된",
];
const DEPENDENT_NOUNS = ["자녀", "아동", "손자녀", "가구원", "세대원", "피부양"];
const AGE_DESCRIPTOR_SYNONYMS = new Set(["어르신", "노인", "청소년"]);
const OPEN_TO_ALL_MARKERS = [
  "실명의 개인",
  "누구나",
  "제한 없음",
  "제한없음",
  "가입 제한 없",
];

export function hasDependentContext(
  text: string,
  _start: number,
  end: number,
): string | null {
  const tail = text.slice(end, end + 25);
  for (const verb of DEPENDENT_VERBS) if (tail.includes(verb)) return verb;
  const near = text.slice(end, end + 5);
  for (const noun of DEPENDENT_NOUNS) if (near.includes(noun)) return noun;
  return null;
}

export function lookupOccupations(
  text: string,
  options: { dropAgeDescriptors?: boolean } = {},
): [string[], string[], LookupMeta] {
  const codes: string[] = [];
  const evidence: string[] = [];
  const accepted: LookupMatch[] = [];
  let rejected = false;
  if (OPEN_TO_ALL_MARKERS.some((marker) => text.includes(marker))) {
    return [codes, evidence, { matches: accepted, rejected }];
  }

  for (const match of matches(occupationPattern, text)) {
    const word = match.text;
    if (options.dropAgeDescriptors && AGE_DESCRIPTOR_SYNONYMS.has(word)) continue;
    if (blocked(text, match.start, match.end, OCCUPATION_BLOCKERS)) continue;
    if (
      hasDependentContext(text, match.start, match.end) ||
      nonRequirementReason(text, match.start, match.end) ||
      /^의\s*(?:소견|진단서?|처방|확인서?|추천)/u.test(text.slice(match.end))
    ) {
      rejected = true;
      continue;
    }
    const matchedCodes = occupationIndex.get(word) ?? [];
    for (const code of matchedCodes) {
      if (!codes.includes(code)) codes.push(code);
    }
    if (!evidence.includes(word)) evidence.push(word);
    accepted.push({ ...match, codes: matchedCodes });
  }
  return [codes, evidence, { matches: accepted, rejected }];
}

export function normalizeText(text: string): string {
  return (text || "")
    .normalize("NFC")
    .replaceAll("\u00a0", " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
