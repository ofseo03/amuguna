/**
 * 소스 간 중복 공고 측정 (SPEC §3.3).
 *
 * 보조금24는 중앙+지자체+공공기관을 모두 커버하므로 중앙부처복지·지자체복지와 커버 영역이
 * 겹친다. 같은 지원금이 소스별로 다른 `external_id` 로 들어오면 `external_id` 기준 dedup 이
 * 걸리지 않아 (a) 카드가 중복 노출되고 (b) 벡터 top-k 슬롯을 두 번 차지해 유효 결과를 민다.
 *
 * **이 스크립트는 측정만 한다.** 병합도 삭제도 하지 않는다 — 실제 중복률을 보고
 * "병합 로직을 넣을지 소스를 줄일지"를 사람이 결정해야 하기 때문이다.
 *
 *   DATABASE_URL='postgres://...' node scripts/measure-duplicates.mjs [--threshold 0.6] [--examples 15]
 *
 * DATABASE_URL 이 없으면 번들 데모 데이터로 돌아간다 (22건이라 대표성은 없고, 동작 확인용).
 */
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { prepare, similarity } from "./lib/title-similarity.mjs";

const { values } = parseArgs({
  options: {
    threshold: { type: "string", default: "0.6" },
    examples: { type: "string", default: "15" },
  },
});
const THRESHOLD = Number(values.threshold);
const EXAMPLES = Number(values.examples);

/**
 * 민감도 표에 쓰는 임계치들.
 *
 * 단일 임계치는 위험하다. 실측해 보면 같은 사업이라도 한쪽 소스가 지역명을 접두어로
 * 붙이는 것만으로 유사도가 0.85 → 0.60 으로 떨어진다 (예: "청년월세 한시 특별지원" vs
 * "[서울] 청년월세 한시 특별지원(2차)"). 0.8 로 자르면 그런 진짜 중복을 통째로 놓치고,
 * 0.5 로 내리면 "기초연금 vs 장애인연금" 같은 오탐이 섞인다.
 * 그래서 하나를 고르지 않고 구간별 건수를 함께 보여준다 — 어디서 꺾이는지가 판단 재료다.
 */
const SENSITIVITY = [0.9, 0.8, 0.7, 0.6, 0.5];
const FLOOR = Math.min(THRESHOLD, ...SENSITIVITY);

/* ------------------------------------------------------------------ 정규화 */

// 순수 함수는 scripts/lib/title-similarity.mjs 에 있다 — 이 파일은 실행형이라
// 테스트에서 import 할 수 없어서 분리했다 (src/lib/title-similarity.test.mjs).

/* ------------------------------------------------------------------ 데이터 */

async function loadFromDb(dsn) {
  const sql = postgres(dsn, { max: 1, idle_timeout: 5, connect_timeout: 10, prepare: false });
  try {
    return await sql`
      SELECT id, external_id, split_part(external_id, ':', 1) AS source_key,
             title, issuer, benefit_amount_max, ends_at
      FROM programs
      WHERE status <> 'expired'
      ORDER BY id`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function loadFromDemo() {
  const raw = JSON.parse(
    await readFile(new URL("../src/demo/programs.json", import.meta.url), "utf8"),
  );
  return raw.programs.map((p) => ({
    id: p.id,
    external_id: p.external_id,
    source_key: p.external_id.split(":")[0],
    title: p.title,
    issuer: p.issuer,
    benefit_amount_max: p.benefit_amount_max,
    ends_at: null,
  }));
}

const dsn = process.env.DATABASE_URL;
const rows = dsn ? await loadFromDb(dsn) : await loadFromDemo();

console.log("=== amuguna 소스 간 중복 공고 측정 (SPEC §3.3) ===");
console.log(
  dsn
    ? `DATABASE_URL 로 ${rows.length}건을 읽었습니다.`
    : `DATABASE_URL 이 없어 번들 데모 데이터 ${rows.length}건으로 돌립니다 — 대표성 없음, 동작 확인용입니다.`,
);
console.log(`기준 임계치 ${THRESHOLD} (제목 문자 bigram Jaccard, 소관기관 일치 시 +0.1)\n`);

/* ------------------------------------------------------------- 소스별 분포 */

const bySource = new Map();
for (const row of rows) bySource.set(row.source_key, (bySource.get(row.source_key) ?? 0) + 1);
console.log("소스별 건수");
for (const [key, count] of [...bySource].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${key.padEnd(18)}${String(count).padStart(7)}건`);
}
console.log("");

/* ------------------------------------------------------------------ 측정 */

const prepared = rows.map(prepare);

// 완전 동일 제목은 별도로 센다 — 가장 확실한 중복이고 임계치 논쟁이 없다.
const exactGroups = new Map();
for (const row of prepared) {
  const key = `${row.normTitle}|${row.normIssuer}`;
  if (!row.normTitle) continue;
  if (!exactGroups.has(key)) exactGroups.set(key, []);
  exactGroups.get(key).push(row);
}
const exactDupes = [...exactGroups.values()].filter((group) => group.length > 1);
const exactCrossSource = exactDupes.filter(
  (group) => new Set(group.map((r) => r.source_key)).size > 1,
);

// 유사 중복 — O(n²) 이지만 수천 건 규모에서는 충분하다.
const pairs = [];
for (let i = 0; i < prepared.length; i++) {
  for (let j = i + 1; j < prepared.length; j++) {
    const a = prepared[i];
    const b = prepared[j];
    if (!a.normTitle || !b.normTitle) continue;
    const score = similarity(a, b);
    if (score >= FLOOR) {
      pairs.push({ a, b, score, crossSource: a.source_key !== b.source_key });
    }
  }
}
pairs.sort((x, y) => y.score - x.score);

const crossSourcePairs = pairs.filter((p) => p.crossSource && p.score >= THRESHOLD);
// 중복으로 묶인 공고가 몇 건인지 (쌍 수가 아니라 건 수)
const involved = new Set();
for (const p of crossSourcePairs) involved.add(p.a.id).add(p.b.id);

const pct = (n) => (rows.length ? ((n / rows.length) * 100).toFixed(1) : "0.0");

console.log("측정 결과");
console.log(`  전체 공고                       ${rows.length}건`);
console.log(
  `  제목+기관 완전일치 그룹          ${exactDupes.length}개 (그중 소스 간 ${exactCrossSource.length}개)`,
);
console.log(`  기준 임계치 ${THRESHOLD} · 소스 간 중복 쌍  ${crossSourcePairs.length}쌍`);
console.log(
  `  중복 후보에 걸린 공고            ${involved.size}건 (전체의 ${pct(involved.size)}%)`,
);
console.log("");

console.log("임계치 민감도 — 어디서 꺾이는지가 판단 재료다");
console.log("  임계치   소스 간 쌍   걸린 공고   비율");
for (const level of SENSITIVITY) {
  const at = pairs.filter((p) => p.crossSource && p.score >= level);
  const ids = new Set();
  for (const p of at) ids.add(p.a.id).add(p.b.id);
  console.log(
    `  ${level.toFixed(1).padStart(5)}${String(at.length).padStart(12)}쌍` +
      `${String(ids.size).padStart(11)}건${pct(ids.size).padStart(8)}%`,
  );
}
console.log("");

// 소스 조합별 — "어느 소스끼리 겹치는가"가 소스 축소 결정의 근거다
const comboCounts = new Map();
for (const p of crossSourcePairs) {
  const combo = [p.a.source_key, p.b.source_key].sort().join(" ↔ ");
  comboCounts.set(combo, (comboCounts.get(combo) ?? 0) + 1);
}
if (comboCounts.size) {
  console.log("소스 조합별 중복 쌍");
  for (const [combo, count] of [...comboCounts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${combo.padEnd(34)}${String(count).padStart(6)}쌍`);
  }
  console.log("");
}

if (crossSourcePairs.length) {
  console.log(`중복 후보 예시 (상위 ${Math.min(EXAMPLES, crossSourcePairs.length)}건)`);
  for (const { a, b, score } of crossSourcePairs.slice(0, EXAMPLES)) {
    console.log(`  [${score.toFixed(3)}]`);
    console.log(`    ${a.source_key}: ${a.title}  (${a.issuer})`);
    console.log(`    ${b.source_key}: ${b.title}  (${b.issuer})`);
  }
  console.log("");
}

console.log("---");
console.log("판단 기준 (병합 구현 여부를 정하는 근거)");
console.log("  · 중복 5% 미만  → 방치 가능. 벡터 top-k(200) 잠식이 미미하다");
console.log("  · 5~15%        → 소스 축소가 병합 구현보다 싸다. 겹치는 조합을 위 표에서 고른다");
console.log("  · 15% 이상     → 병합 로직이 필요하다. 이 경우 external_id 를 유지한 채");
console.log("                   canonical_id 를 두어 대표 1건만 노출하는 방식을 검토한다");
console.log("");
console.log("주의: 이 측정은 제목·기관 표기 유사도만 본다. 실제로 다른 사업인데 이름이 비슷한");
console.log("      경우(오탐)가 섞이므로, 병합을 결정하기 전에 위 예시를 눈으로 확인할 것.");
