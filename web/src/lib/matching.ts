/**
 * 매칭 오케스트레이션 — 자격(A) ∩ 의도(B) 교차 검증, 스코어링, 빈 결과 완화.
 * SPEC §7.3 / §7.4 / §7.6 / §7.7.
 *
 * 두 개의 백엔드를 같은 인터페이스로 감싼다.
 *  - DB 모드   : Supabase RPC match_programs(...) → 프로그램 행 조회
 *  - 데모 모드 : 번들 JSON 위에서 동일 판정을 TypeScript 로 수행
 *
 * 저장 요약·절차와 근거 문장은 결정형으로 조립한다. 실시간 전체 안내는 API 라우트가 담당한다.
 */
import { cosine, embedQuery, toPgVectorLiteral, vectorSpace } from "./embedding";
import {
  buildBadges,
  buildReason,
  dDay,
  evaluate,
  isOpen,
  needsEligibilityReview,
  nearMissMessage,
  profileLabel,
  regionPrefixes,
  toDateString,
} from "./eligibility";
import { getSql, isDbConfigured } from "./db";
import { demoEmbeddingIndex, demoPrograms } from "./demo-store";
import { scoreProgram } from "./scoring";
import { FORMS } from "./forms";
import type {
  MatchCard,
  MatchCursor,
  MatchResponse,
  NearMissCard,
  Profile,
  Program,
  ProgramForm,
  RelaxationStage,
  RuleDimension,
} from "./types";

export const PAGE_SIZE = 15;
const TOPK_BASE = 200;
const TOPK_EXPANDED = 500;

/**
 * 데모 모드의 집합 B 소속 판정 하한.
 *
 * DB 모드에서는 HNSW top-k 절단이 B 를 정의한다. 그런데 데모 데이터셋은 22건뿐이라
 * top-k 200 이 전 건을 포함해 버려 교집합이 항상 A 와 같아진다 — 교차 검증이 시연되지 않는다.
 * 그래서 데모에서만 유사도 하한으로 B 를 정의한다.
 *
 * 절대 하한만 쓰면 mock 임베딩(문자 bigram)의 조사·어미 겹침 때문에 무관한 건도 0.15 근처가
 * 나와 잘 걸러지지 않는다. 질의마다 유사도 분포의 스케일이 달라지므로 최고 유사도 대비
 * 상대 하한을 함께 쓴다. 값은 SPEC §5 예시 문구 4종으로 실측해 정했다
 * (예: "보증금 올려달래서 대출 알아봐요" → best 0.338, 하한 0.152, B 9건).
 */
const DEMO_B_RELATIVE = 0.45;
const DEMO_B_ABS_FLOOR = 0.1;

export interface MatchInput {
  profile: Profile;
  /** 자유입력 (최대 200자). 건너뛰면 null. 저장하지 않는다 (§8) */
  query: string | null;
  /** 결과를 본 뒤 좁히는 용도의 form 탭 (§5) */
  form: ProgramForm | "all";
  cursor: MatchCursor | null;
}

/** 백엔드가 돌려주는 원시 후보 (자격 판정 완료, 점수 미산출) */
interface Candidate {
  program: Program;
  sim: number;
  violations: number;
  violatedDimensions: RuleDimension[];
  matchedDimensions: RuleDimension[];
  unknownDimensions: RuleDimension[];
  /** DB keyset RPC가 정한 정렬 점수. 카드 표시는 같은 점수 계산을 유지한다. */
  sortScore?: number;
}

/* ================================================================== */
/* 데모 백엔드                                                          */
/* ================================================================== */

function demoCandidates(
  profile: Profile,
  qvec: Float64Array | null,
  topk: number,
  useIntent: boolean,
  now: Date,
): { eligible: Candidate[]; nearMiss: Candidate[] } {
  const index = demoEmbeddingIndex();
  const rows: Candidate[] = [];

  for (const program of demoPrograms()) {
    if (!isOpen(program, now)) continue;

    // 프로그램 단위 최대 유사도 (§7.1 — 청크별 계산 후 MAX)
    let sim = 0;
    if (qvec) {
      for (const chunk of index.get(program.id) ?? []) {
        const s = cosine(qvec, chunk);
        if (s > sim) sim = s;
      }
    }

    const ev = evaluate(program.rules, profile);
    rows.push({
      program,
      sim,
      violations: ev.violations,
      violatedDimensions: ev.violatedDimensions,
      matchedDimensions: ev.matchedDimensions,
      unknownDimensions: ev.unknownDimensions,
    });
  }

  // 집합 B: 유사도 상위 topk 이면서 하한 이상
  let inB: Set<number> | null = null;
  if (useIntent && qvec && rows.length > 0) {
    const ranked = [...rows].sort((a, b) => b.sim - a.sim).slice(0, topk);
    const best = ranked[0]?.sim ?? 0;
    // top-k 확대 단계(§7.7-1)에서는 하한도 함께 완화해 실제로 후보가 늘어나게 한다.
    // 데모 규모에서는 k 만 키워봐야 이미 전 건이 들어와 있어 아무 효과가 없기 때문이다.
    const relative = topk > TOPK_BASE ? DEMO_B_RELATIVE * 0.6 : DEMO_B_RELATIVE;
    const floor = Math.max(DEMO_B_ABS_FLOOR, best * relative);
    inB = new Set(ranked.filter((r) => r.sim >= floor).map((r) => r.program.id));
  }

  const eligible = rows.filter(
    (r) => r.violations === 0 && (inB === null || inB.has(r.program.id)),
  );
  // 근접 탈락은 의도 필터를 적용하지 않는다 — 자격 축 안내가 목적이므로 (§7.6).
  // DB 백엔드도 같은 규칙을 지켜야 한다: runMatch 의 근접 탈락 조회는 벡터를 NULL 로 넘긴다.
  const nearMiss = rows.filter((r) => r.violations === 1);
  return { eligible, nearMiss };
}

/* ================================================================== */
/* DB 백엔드                                                            */
/* ================================================================== */

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToProgram(r: any): Program {
  return {
    id: Number(r.id),
    external_id: r.external_id,
    title: r.title,
    summary: r.summary ?? "",
    body_text: r.body_text ?? "",
    form: (r.form ?? "subsidy") as ProgramForm,
    issuer: r.issuer ?? "",
    issuer_level: (r.issuer_level ?? "central") as Program["issuer_level"],
    benefit_amount_text: r.benefit_amount_text ?? null,
    benefit_amount_min: r.benefit_amount_min === null ? null : Number(r.benefit_amount_min),
    benefit_amount_max: r.benefit_amount_max === null ? null : Number(r.benefit_amount_max),
    apply_url: r.apply_url ?? null,
    apply_method: r.apply_method ?? null,
    // date 컬럼은 날짜로 유지한다 — 타임스탬프로 바꾸면 KST 자정 근처에서 D-day 가 밀린다
    starts_at: toDateString(r.starts_at),
    ends_at: toDateString(r.ends_at),
    is_always_open: Boolean(r.is_always_open),
    source_url: r.source_url ?? "",
    fetched_at: r.fetched_at ? new Date(r.fetched_at).toISOString() : "",
    status: (r.status ?? "active") as Program["status"],
    apply_steps: Array.isArray(r.apply_steps) ? r.apply_steps : [],
    rules: {
      age_min: r.age_min ?? null,
      age_max: r.age_max ?? null,
      gender: r.gender ?? null,
      regions: r.regions ?? null,
      occupations: r.occupations ?? null,
      income_decile_max: r.income_decile_max ?? null,
      median_income_percent_max: r.median_income_percent_max ?? null,
      extra_conditions: normalizeExtraConditions(r.extra_conditions),
      parse_method: (r.parse_method ?? "regex") as Program["rules"]["parse_method"],
      confidence: r.confidence === null || r.confidence === undefined ? 0 : Number(r.confidence),
      needs_review: Boolean(r.needs_review),
    },
  };
}

function normalizeExtraConditions(v: any): Program["rules"]["extra_conditions"] {
  if (!v) return [];
  if (Array.isArray(v)) {
    return v.map((x) =>
      typeof x === "string"
        ? { label: "추가 확인 필요", text: x }
        : { label: x.label ?? "추가 확인 필요", text: x.text ?? String(x) },
    );
  }
  if (typeof v === "object") {
    return Object.entries(v).map(([label, text]) => ({ label, text: String(text) }));
  }
  return [];
}

interface DbCounts {
  total: number;
  byForm: Record<ProgramForm, number>;
}

interface DbPageRow {
  program_id: number;
  sim: number;
  violations: number;
  sort_score: number;
}

/** DB keyset RPC의 얇은 호출부. 카드 근거는 페이지의 프로그램만 다시 읽어 조립한다. */
async function dbCounts(
  profile: Profile,
  qvec: Float64Array | null,
  topk: number,
  useIntent: boolean,
): Promise<DbCounts> {
  const sql = getSql();
  if (!sql) throw new Error("DATABASE_URL 미설정");
  const vecLiteral = useIntent && qvec ? toPgVectorLiteral(qvec) : null;
  const rows = vecLiteral
    ? await sql`
        SELECT * FROM match_program_counts(
          ${profile.age}::int,
          ${profile.gender}::text,
          ${regionPrefixes(profile)}::text[],
          ${profile.occupation}::text,
          ${profile.incomeDecile}::int,
          ${profile.medianIncomePercent}::int,
          ${vecLiteral}::vector,
          ${topk}::int
        )`
    : await sql`
        SELECT * FROM match_program_counts(
          ${profile.age}::int,
          ${profile.gender}::text,
          ${regionPrefixes(profile)}::text[],
          ${profile.occupation}::text,
          ${profile.incomeDecile}::int,
          ${profile.medianIncomePercent}::int,
          NULL::vector,
          ${topk}::int
        )`;
  const row = rows[0] as any;
  return {
    total: Number(row?.total ?? 0),
    byForm: {
      subsidy: Number(row?.subsidy_count ?? 0),
      loan: Number(row?.loan_count ?? 0),
      tax: Number(row?.tax_count ?? 0),
      product: Number(row?.product_count ?? 0),
      law: Number(row?.law_count ?? 0),
    },
  };
}

async function dbPageRows(
  profile: Profile,
  qvec: Float64Array | null,
  topk: number,
  useIntent: boolean,
  hasQuery: boolean,
  form: ProgramForm | "all",
  cursor: MatchCursor | null,
  violations: 0 | 1,
  limit: number,
): Promise<DbPageRow[]> {
  const sql = getSql();
  if (!sql) throw new Error("DATABASE_URL 미설정");
  const vecLiteral = useIntent && qvec ? toPgVectorLiteral(qvec) : null;
  const dbForm = form === "all" ? null : form;
  const rows = vecLiteral
    ? await sql`
        SELECT * FROM match_program_page(
          ${profile.age}::int, ${profile.gender}::text, ${regionPrefixes(profile)}::text[],
          ${profile.occupation}::text, ${profile.incomeDecile}::int,
          ${profile.medianIncomePercent}::int, ${vecLiteral}::vector, ${topk}::int,
          ${hasQuery}::boolean, ${dbForm}::text, ${cursor?.score ?? null}::double precision,
          ${cursor?.id ?? null}::bigint, ${limit}::int, ${violations}::int
        )`
    : await sql`
        SELECT * FROM match_program_page(
          ${profile.age}::int, ${profile.gender}::text, ${regionPrefixes(profile)}::text[],
          ${profile.occupation}::text, ${profile.incomeDecile}::int,
          ${profile.medianIncomePercent}::int, NULL::vector, ${topk}::int,
          ${hasQuery}::boolean, ${dbForm}::text, ${cursor?.score ?? null}::double precision,
          ${cursor?.id ?? null}::bigint, ${limit}::int, ${violations}::int
        )`;
  return (rows as any[]).map((r) => ({
    program_id: Number(r.program_id),
    sim: r.sim === null || r.sim === undefined ? 0 : Number(r.sim),
    violations: Number(r.violations),
    sort_score: Number(r.sort_score),
  }));
}

async function dbCandidatesForRows(profile: Profile, pageRows: DbPageRow[]): Promise<Candidate[]> {
  if (pageRows.length === 0) return [];
  const sql = getSql();
  if (!sql) throw new Error("DATABASE_URL 미설정");
  const ids = pageRows.map((m) => m.program_id);
  const programRows = await sql`
    SELECT p.*,
           e.age_min, e.age_max, e.gender, e.regions, e.occupations,
           e.income_decile_max, e.median_income_percent_max,
           e.extra_conditions, e.parse_method, e.confidence, e.needs_review
    FROM programs p
    LEFT JOIN eligibility_rules e ON e.program_id = p.id
    WHERE p.id = ANY(${ids}::bigint[])`;

  const byId = new Map<number, Program>();
  for (const r of programRows) byId.set(Number(r.id), rowToProgram(r));

  const candidates: Candidate[] = [];
  for (const m of pageRows) {
    const program = byId.get(Number(m.program_id));
    if (!program) continue;
    // violated_field 는 RPC 가 알려주지만, 매칭/위반 축 전체는 규칙으로 재평가한다.
    // (근거 문장·체크리스트가 RPC 출력 이상의 정보를 필요로 하므로)
    const ev = evaluate(program.rules, profile);
    const cand: Candidate = {
      program,
      sim: m.sim === null || m.sim === undefined ? 0 : Number(m.sim),
      violations: Number(m.violations),
      violatedDimensions: ev.violatedDimensions,
      matchedDimensions: ev.matchedDimensions,
      unknownDimensions: ev.unknownDimensions,
      sortScore: m.sort_score,
    };
    candidates.push(cand);
  }
  return candidates;
}

/* ================================================================== */
/* 공통 조립                                                            */
/* ================================================================== */

function toCard(
  c: Candidate,
  profile: Profile,
  hasQuery: boolean,
  now: Date,
): MatchCard {
  const breakdown = scoreProgram(
    c.program,
    profile,
    c.matchedDimensions,
    c.sim,
    hasQuery,
    now,
  );
  const needsReview = needsEligibilityReview(c.program.rules, c.unknownDimensions);
  return {
    program: c.program,
    eligibilityStatus: needsReview ? "needs_review" : "likely",
    score: c.sortScore ?? breakdown.total,
    breakdown,
    sim: c.sim,
    reason: buildReason(c.matchedDimensions, c.program.rules, profile, c.unknownDimensions, needsReview),
    badges: buildBadges(c.matchedDimensions, c.program.rules, profile, c.unknownDimensions, needsReview),
    dDay: dDay(c.program, now),
  };
}

function toNearMiss(
  c: Candidate,
  profile: Profile,
  hasQuery: boolean,
  now: Date,
): NearMissCard | null {
  // 구조화된 축 하나가 명확히 어긋난 사실은, 원문에 추가 확인 조건이나 미입력 축이
  // 남아 있어도 사용자에게 유용하다. 화면에서는 최종 자격을 단정하지 않고 원문 확인을 안내한다.
  const d = c.violatedDimensions[0];
  if (!d) return null;
  const breakdown = scoreProgram(
    c.program,
    profile,
    c.matchedDimensions,
    c.sim,
    hasQuery,
    now,
  );
  return {
    program: c.program,
    score: c.sortScore ?? breakdown.total,
    violatedDimension: d,
    message: nearMissMessage(d, c.program.rules, profile),
    dDay: dDay(c.program, now),
  };
}

const RELAXATION_NOTICE: Record<RelaxationStage, string | null> = {
  none: null,
  topk_expanded:
    "정확히 일치하는 결과가 적어 검색 범위를 넓혔습니다 (유사도 상위 200건 → 500건).",
  intent_dropped:
    "찾으시는 것과 딱 맞는 건 없지만, 조건 일부가 일치하는 후보를 보여드립니다.",
  near_miss_only:
    "지금 조건으로 바로 받을 수 있는 지원을 찾지 못했습니다. 조건이 하나만 어긋난 지원을 보여드립니다.",
};

function compareCards(a: { score: number; program: Program }, b: { score: number; program: Program }) {
  return b.score - a.score || a.program.id - b.program.id;
}

export function encodeMatchCursor(cursor: MatchCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function pageCards(cards: MatchCard[], cursor: MatchCursor | null) {
  const after = cursor
    ? cards.filter((card) => card.score < cursor.score || (card.score === cursor.score && card.program.id > cursor.id))
    : cards;
  const window = after.slice(0, PAGE_SIZE + 1);
  const visible = window.slice(0, PAGE_SIZE);
  const last = visible.at(-1);
  return {
    cards: visible,
    nextCursor: window.length > PAGE_SIZE && last ? encodeMatchCursor({ score: last.score, id: last.program.id }) : null,
  };
}

export async function runMatch(
  input: MatchInput,
): Promise<Omit<MatchResponse, "aiAnswer" | "aiAnswerStatus" | "tookMs">> {
  const now = new Date();
  const { profile } = input;

  const rawQuery = (input.query ?? "").trim();
  const hasQueryInput = rawQuery.length > 0;

  let qvec: Float64Array | null = null;
  let degraded = false;
  if (hasQueryInput) {
    try {
      const r = await embedQuery(rawQuery);
      qvec = r.degraded ? null : r.vector;
      degraded = r.degraded;
    } catch {
      // §8 신뢰성: 임베딩 실패 시 집합 A 만으로 렌더 (degraded)
      qvec = null;
      degraded = true;
    }
  }

  if (qvec && isDbConfigured()) {
    try {
      const sql = getSql();
      const rows = sql
        ? await sql`SELECT active_vector_space FROM ingest_embedding_state WHERE singleton`
        : [];
      if (rows[0]?.active_vector_space !== vectorSpace()) {
        qvec = null;
        degraded = true;
      }
    } catch (error) {
      console.error("[matching] 활성 임베딩 공간 확인 실패", error);
      qvec = null;
      degraded = true;
    }
  }

  const demoMode = !isDbConfigured();
  const useIntentInitially = qvec !== null;
  // ---- §7.7 단계적 완화 ------------------------------------------------
  let stage: RelaxationStage = "none";
  let topk = TOPK_BASE;
  let useIntent = useIntentInitially;

  if (demoMode) {
    let result = demoCandidates(profile, qvec, topk, useIntent, now);
    if (result.eligible.length === 0 && useIntentInitially) {
      stage = "topk_expanded";
      topk = TOPK_EXPANDED;
      result = demoCandidates(profile, qvec, topk, true, now);
    }
    if (result.eligible.length === 0 && useIntentInitially) {
      stage = "intent_dropped";
      useIntent = false;
      result = demoCandidates(profile, qvec, topk, false, now);
    }
    if (result.eligible.length === 0) stage = "near_miss_only";

    const hasQueryForScoring = hasQueryInput && stage !== "intent_dropped" && qvec !== null;
    const allCards = result.eligible
      .map((c) => toCard(c, profile, hasQueryForScoring, now))
      .sort(compareCards);
    // 근접 탈락은 자격 축 안내라 유사도 항 없이 정렬한다 — DB 백엔드와 같은 공식이어야
    // 두 모드에서 같은 다섯 건이 나온다 (§7.6).
    const nearMisses = result.nearMiss
      .map((c) => toNearMiss(c, profile, false, now))
      .filter((x): x is NearMissCard => x !== null)
      .sort(compareCards)
      .slice(0, 5);
    const byForm = FORMS.reduce(
      (acc, f) => {
        acc[f] = allCards.filter((c) => c.program.form === f).length;
        return acc;
      },
      {} as Record<ProgramForm, number>,
    );
    const filtered = input.form === "all" ? allCards : allCards.filter((c) => c.program.form === input.form);
    const paged = pageCards(filtered, input.cursor);
    return {
      summary: { profileLabel: profileLabel(profile), total: filtered.length, byForm },
      cards: paged.cards,
      nearMisses,
      relaxation: stage,
      relaxationNotice: RELAXATION_NOTICE[stage],
      pageSize: PAGE_SIZE,
      nextCursor: paged.nextCursor,
      demoMode,
      // 데모 모드는 번들 데이터가 항상 들어 있으므로 콜드 스타트가 성립하지 않는다
      catalogEmpty: false,
      degraded,
    };
  }

  let counts = await dbCounts(profile, qvec, topk, useIntent);
  if (counts.total === 0 && useIntentInitially) {
    stage = "topk_expanded";
    topk = TOPK_EXPANDED;
    counts = await dbCounts(profile, qvec, topk, true);
  }
  if (counts.total === 0 && useIntentInitially) {
    stage = "intent_dropped";
    useIntent = false;
    counts = await dbCounts(profile, qvec, topk, false);
  }
  if (counts.total === 0) stage = "near_miss_only";

  const hasQueryForScoring = hasQueryInput && stage !== "intent_dropped" && qvec !== null;
  const rows = await dbPageRows(
    profile, qvec, topk, useIntent, hasQueryForScoring, input.form, input.cursor, 0, PAGE_SIZE + 1,
  );
  const hasNext = rows.length > PAGE_SIZE;
  const visibleRows = rows.slice(0, PAGE_SIZE);
  const cards = (await dbCandidatesForRows(profile, visibleRows)).map((c) =>
    toCard(c, profile, hasQueryForScoring, now),
  );
  // 근접 탈락은 의도 필터를 적용하지 않는다 (§7.6). match_programs 의 벡터 분기는
  // violations=1 행까지 top-k 로 INNER JOIN 하므로, 벡터를 NULL 로 넘겨 자격 분기를 타게 한다.
  // 유사도 항이 없으니 정렬도 hasQuery=false 공식 — 데모 백엔드와 같다.
  const nearRows = await dbPageRows(
    profile, null, topk, false, false, "all", null, 1, 20,
  );
  const nearMisses = (await dbCandidatesForRows(profile, nearRows))
    .map((c) => toNearMiss(c, profile, false, now))
    .filter((x): x is NearMissCard => x !== null)
    .slice(0, 5);
  const last = cards.at(-1);
  // 결과가 통째로 비었을 때만 카탈로그 자체를 확인한다 — 정상 경로에 질의를 늘리지 않는다.
  const catalogEmpty =
    cards.length === 0 && nearMisses.length === 0 ? await isCatalogEmpty() : false;

  return {
    summary: {
      profileLabel: profileLabel(profile),
      total: input.form === "all" ? counts.total : counts.byForm[input.form],
      byForm: counts.byForm,
    },
    cards,
    nearMisses,
    relaxation: stage,
    relaxationNotice: RELAXATION_NOTICE[stage],
    pageSize: PAGE_SIZE,
    nextCursor: hasNext && last ? encodeMatchCursor({ score: last.score, id: last.program.id }) : null,
    demoMode,
    catalogEmpty,
    degraded,
  };
}

/**
 * 노출 가능한 공고가 한 건도 없는가 (콜드 스타트 판정).
 *
 * 첫 배포 직후나 초기 적재가 진행 중인 동안에는 DB 가 비어 있을 수 있다.
 * 조회 실패 시 false 를 돌려 "데이터 없음" 안내를 잘못 띄우지 않는다 —
 * 일시적인 DB 오류를 콜드 스타트로 오인하는 편이 더 나쁜 오해다.
 */
async function isCatalogEmpty(): Promise<boolean> {
  const sql = getSql();
  if (!sql) return false;
  try {
    const rows = await sql<{ any_active: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM programs
        WHERE status = 'active'
          AND (ends_at IS NULL OR ends_at >= (now() AT TIME ZONE 'Asia/Seoul')::date)
      ) AS any_active`;
    return rows[0]?.any_active === false;
  } catch (error) {
    console.error("[matching] 카탈로그 적재 여부 확인 실패", error);
    return false;
  }
}

/** 상세 화면용 단건 조회 */
export async function getProgram(id: number): Promise<Program | null> {
  if (!isDbConfigured()) {
    const { demoProgram } = await import("./demo-store");
    const program = demoProgram(id);
    return program && isOpen(program) ? program : null;
  }
  const sql = getSql();
  if (!sql) return null;
  // Keep detail visibility aligned with the active matching catalog.
  const rows = await sql`
    SELECT p.*,
           e.age_min, e.age_max, e.gender, e.regions, e.occupations,
           e.income_decile_max, e.median_income_percent_max,
           e.extra_conditions, e.parse_method, e.confidence, e.needs_review
    FROM programs p
    LEFT JOIN eligibility_rules e ON e.program_id = p.id
    WHERE p.id = ${id}::bigint
      AND p.status = 'active'
      AND (p.starts_at IS NULL OR p.starts_at <= (now() AT TIME ZONE 'Asia/Seoul')::date)
      AND (p.ends_at IS NULL OR p.ends_at >= (now() AT TIME ZONE 'Asia/Seoul')::date)
    LIMIT 1`;
  if (rows.length === 0) return null;
  return rowToProgram(rows[0]);
}
