/**
 * 초기 적재 진행률과 완료까지 남은 일수 (SPEC §3.2).
 *
 * 왜 필요한가. 소스별 **일일 호출 한도가 100배 차이**나서, 어떤 소스는 첫날 전량이
 * 들어오고 어떤 소스는 며칠에 걸쳐 조금씩 쌓인다. "실패 시 직전 성공 스냅샷 유지"
 * 정책은 첫 실행에는 지켜줄 스냅샷이 없다 — 심사위원이 빈 결과를 보는 것이 이 구간의
 * 실질적 위험이므로, 언제 다 차는지를 숫자로 알고 있어야 한다.
 *
 *   DATABASE_URL=... node scripts/coldstart-eta.mjs
 *
 * DATABASE_URL 이 없으면 0건에서 시작하는 최악 가정으로 계산해 보여준다.
 */
import postgres from "postgres";

/**
 * 소스별 초기 적재 속도.
 *
 * `perDay` 는 **하루에 새로 적재 가능한 건수**다. 목록만으로 본문이 확보되는 소스는
 * 페이지 호출만 들어 사실상 하루에 전량이 들어오고(Infinity), 건별 상세 조회가 필요한
 * 소스는 `maxDetailCalls` 가 그대로 상한이 된다.
 *
 * `estimatedTotal` 은 SPEC §3.3 기준 추정치이며, 실제 목록 호출로 확인되면 갱신한다.
 */
const SOURCES = [
  {
    key: "gov24",
    label: "보조금24 (행안부)",
    dailyQuota: "10,000회/일",
    perDay: Infinity,
    estimatedTotal: null, // 목록 응답의 totalCount 로 확인
    note: "목록이 지원대상·선정기준을 함께 주므로 상세 조회가 없다. 하루에 전량 적재된다.",
  },
  {
    key: "social_security",
    label: "중앙부처복지 (사회보장정보원)",
    dailyQuota: "100회/일 ⚠️",
    perDay: 90, // maxDetailCalls 기본값. 나머지 10회는 목록·재시도 여유
    estimatedTotal: 461, // SPEC §3.2 실측
    note: "건별 상세 조회가 필요하고 개발계정 한도가 100회/일이라 여기가 임계 경로다.",
  },
  {
    key: "local_welfare",
    label: "지자체복지 (사회보장정보원)",
    dailyQuota: "1,000회/일",
    perDay: 90, // maxDetailCalls 기본값 (한도가 커도 코드 기본값이 90)
    estimatedTotal: null,
    note: "한도는 1,000회/일이지만 maxDetailCalls 기본값이 90이다. 총건수를 확인한 뒤 올릴 수 있다.",
  },
  {
    key: "bizinfo",
    label: "기업마당",
    dailyQuota: "미공개",
    perDay: Infinity,
    estimatedTotal: null,
    note: "목록 응답에 본문이 포함된다.",
  },
  {
    key: "finlife",
    label: "금감원 금융상품 6종",
    dailyQuota: "미공개",
    perDay: Infinity,
    estimatedTotal: null,
    note: "상품 목록 조회만으로 완결된다.",
  },
];

async function loadCounts() {
  const dsn = process.env.DATABASE_URL;
  if (!dsn) return null;
  const sql = postgres(dsn, { max: 1, idle_timeout: 5, connect_timeout: 10, prepare: false });
  try {
    const rows = await sql`
      SELECT split_part(external_id, ':', 1) AS source_key,
             count(*) FILTER (WHERE status <> 'expired')::int AS loaded,
             count(*)::int AS total
      FROM programs
      GROUP BY 1`;
    return new Map(rows.map((r) => [r.source_key, { loaded: r.loaded, total: r.total }]));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function daysRemaining(loaded, estimatedTotal, perDay) {
  if (estimatedTotal === null) return null;
  const left = Math.max(0, estimatedTotal - loaded);
  if (left === 0) return 0;
  if (!Number.isFinite(perDay)) return 1;
  return Math.ceil(left / perDay);
}

const counts = await loadCounts();
const connected = counts !== null;

console.log("=== amuguna 초기 적재 진행률 (SPEC §3.2) ===");
console.log(
  connected
    ? "DATABASE_URL 로 실제 적재 건수를 읽었습니다."
    : "DATABASE_URL 이 없어 0건에서 시작하는 최악 가정으로 계산합니다.",
);
console.log("");

let worstDays = 0;
let unknownTotals = 0;

for (const source of SOURCES) {
  const loaded = counts?.get(source.key)?.loaded ?? 0;
  const days = daysRemaining(loaded, source.estimatedTotal, source.perDay);
  if (days === null) unknownTotals++;
  else worstDays = Math.max(worstDays, days);

  const perDayLabel = Number.isFinite(source.perDay) ? `${source.perDay}건/일` : "제한 없음";
  const totalLabel = source.estimatedTotal === null ? "미확인" : `${source.estimatedTotal}건`;
  const daysLabel = days === null ? "총건수 확인 필요" : days === 0 ? "완료" : `약 ${days}일`;

  console.log(`${source.label}`);
  console.log(`  한도 ${source.dailyQuota} · 적재 속도 ${perDayLabel}`);
  console.log(`  적재 ${loaded}건 / 추정 총 ${totalLabel} → 완료까지 ${daysLabel}`);
  console.log(`  ${source.note}`);
  console.log("");
}

console.log("---");
if (worstDays > 0) {
  const done = new Date(Date.now() + worstDays * 86_400_000);
  const kst = new Date(done.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
  console.log(`확인된 소스 기준 전량 적재 완료까지 약 ${worstDays}일 (KST ${kst} 경).`);
} else {
  console.log("확인된 소스는 모두 적재 완료 상태입니다.");
}
if (unknownTotals) {
  console.log(
    `총건수가 확인되지 않은 소스 ${unknownTotals}종이 있습니다.` +
      " 첫 목록 호출의 totalCount 를 이 파일의 estimatedTotal 에 반영하세요.",
  );
}
console.log(
  "심사 구간(9/7 11:00~9/11 23:59) 전에 적재가 끝나야 합니다." +
    " 늦어질 것 같으면 db/README.md 의 시드 스냅샷 절차로 복구용 덤프를 미리 확보하세요.",
);
