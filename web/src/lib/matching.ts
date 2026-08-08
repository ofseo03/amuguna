/**
 * 매칭 오케스트레이션 — 자격(A) ∩ 의도(B) 교차 검증, 스코어링, 빈 결과 완화.
 * SPEC §7.3 / §7.4 / §7.6 / §7.7.
 *
 * 두 개의 백엔드를 같은 인터페이스로 감싼다.
 *  - DB 모드   : Supabase RPC match_programs(...) → 프로그램 행 조회
 *  - 데모 모드 : 번들 JSON 위에서 동일 판정을 TypeScript 로 수행
 *
 * 요청 경로에 LLM 은 없다 (§7.5). 요약·절차는 배치 사전 생성분, 근거 문장은 템플릿 조립.
 */
import { cosine, embedQuery, toPgVectorLiteral } from "./embedding";
import {
  buildBadges,
  buildReason,
  dDay,
  evaluate,
  isOpen,
  nearMissMessage,
  profileLabel,
  regionPrefixes,
} from "./eligibility";
import { getSql, isDbConfigured } from "./db";
import { demoEmbeddingIndex, demoPrograms } from "./demo-store";
import { scoreProgram } from "./scoring";
import { FORMS } from "./forms";
import type {
  MatchCard,
  MatchResponse,
  NearMissCard,
  Profile,
  Program,
  ProgramForm,
  RelaxationStage,
  RuleDimension,
} from "./types";

export const PAGE_SIZE = 20;
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
  page: number;
}

/** 백엔드가 돌려주는 원시 후보 (자격 판정 완료, 점수 미산출) */
interface Candidate {
  program: Program;
  sim: number;
  violations: number;
  violatedDimensions: RuleDimension[];
  matchedDimensions: RuleDimension[];
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
    if (!isOpen(program, now)) continue; // status='active' AND ends_at >= now()

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
  // 근접 탈락은 의도 필터를 적용하지 않는다 — 자격 축 안내가 목적이므로 (§7.6)
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
    starts_at: r.starts_at ? new Date(r.starts_at).toISOString() : null,
    ends_at: r.ends_at ? new Date(r.ends_at).toISOString() : null,
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
      extra_conditions: normalizeExtraConditions(r.extra_conditions),
      parse_method: (r.parse_method ?? "regex") as Program["rules"]["parse_method"],
      confidence: r.confidence === null || r.confidence === undefined ? 0 : Number(r.confidence),
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

/** DB 계약: SELECT * FROM match_programs(age, gender, region_codes, occupation, decile, qvec, topk) */
async function dbCandidates(
  profile: Profile,
  qvec: Float64Array | null,
  topk: number,
  useIntent: boolean,
): Promise<{ eligible: Candidate[]; nearMiss: Candidate[] }> {
  const sql = getSql();
  if (!sql) throw new Error("DATABASE_URL 미설정");

  const vecLiteral = useIntent && qvec ? toPgVectorLiteral(qvec) : null;

  const matches = vecLiteral
    ? await sql`
        SELECT program_id, sim, violations, violated_field
        FROM match_programs(
          ${profile.age}::int,
          ${profile.gender}::text,
          ${regionPrefixes(profile)}::text[],
          ${profile.occupation}::text,
          ${profile.incomeDecile}::int,
          ${vecLiteral}::vector,
          ${topk}::int
        )`
    : await sql`
        SELECT program_id, sim, violations, violated_field
        FROM match_programs(
          ${profile.age}::int,
          ${profile.gender}::text,
          ${regionPrefixes(profile)}::text[],
          ${profile.occupation}::text,
          ${profile.incomeDecile}::int,
          NULL::vector,
          ${topk}::int
        )`;

  if (matches.length === 0) return { eligible: [], nearMiss: [] };

  const ids = matches.map((m: any) => Number(m.program_id));
  const rows = await sql`
    SELECT p.*,
           e.age_min, e.age_max, e.gender, e.regions, e.occupations,
           e.income_decile_max, e.extra_conditions, e.parse_method, e.confidence
    FROM programs p
    LEFT JOIN eligibility_rules e ON e.program_id = p.id
    WHERE p.id = ANY(${ids}::bigint[])`;

  const byId = new Map<number, Program>();
  for (const r of rows) byId.set(Number(r.id), rowToProgram(r));

  const eligible: Candidate[] = [];
  const nearMiss: Candidate[] = [];
  for (const m of matches as any[]) {
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
    };
    if (cand.violations === 0) eligible.push(cand);
    else if (cand.violations === 1) nearMiss.push(cand);
  }
  return { eligible, nearMiss };
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
  return {
    program: c.program,
    score: breakdown.total,
    breakdown,
    sim: c.sim,
    reason: buildReason(c.matchedDimensions, c.program.rules, profile),
    badges: buildBadges(c.matchedDimensions, c.program.rules, profile),
    dDay: dDay(c.program, now),
  };
}

function toNearMiss(
  c: Candidate,
  profile: Profile,
  hasQuery: boolean,
  now: Date,
): NearMissCard | null {
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
    score: breakdown.total,
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
    "찾으시는 것과 딱 맞는 건 없지만, 대상이 되는 지원을 보여드립니다.",
  near_miss_only:
    "지금 조건으로 바로 받을 수 있는 지원을 찾지 못했습니다. 조건이 하나만 어긋난 지원을 보여드립니다.",
};

export async function runMatch(input: MatchInput): Promise<MatchResponse> {
  const started = Date.now();
  const now = new Date();
  const { profile } = input;

  const rawQuery = (input.query ?? "").trim();
  const hasQueryInput = rawQuery.length > 0;

  let qvec: Float64Array | null = null;
  let degraded = false;
  if (hasQueryInput) {
    try {
      const r = await embedQuery(rawQuery);
      qvec = r.vector;
      degraded = r.degraded;
    } catch {
      // §8 신뢰성: 임베딩 실패 시 집합 A 만으로 렌더 (degraded)
      qvec = null;
      degraded = true;
    }
  }

  const demoMode = !isDbConfigured();
  const fetchCandidates = async (topk: number, useIntent: boolean) =>
    demoMode
      ? demoCandidates(profile, qvec, topk, useIntent, now)
      : dbCandidates(profile, qvec, topk, useIntent);

  const useIntentInitially = qvec !== null;

  // ---- §7.7 단계적 완화 ------------------------------------------------
  let stage: RelaxationStage = "none";
  let result = await fetchCandidates(TOPK_BASE, useIntentInitially);

  if (result.eligible.length === 0 && useIntentInitially) {
    stage = "topk_expanded"; // 1. 벡터 top-k 확대 (200 → 500)
    result = await fetchCandidates(TOPK_EXPANDED, true);
  }
  if (result.eligible.length === 0 && useIntentInitially) {
    stage = "intent_dropped"; // 2. 의도 필터 해제
    result = await fetchCandidates(TOPK_EXPANDED, false);
  }
  if (result.eligible.length === 0) {
    stage = "near_miss_only"; // 3. 근접 탈락만 노출
  }

  // 의도 필터가 해제된 단계에서는 유사도 가중치를 빼고 정렬한다
  const hasQueryForScoring = hasQueryInput && stage !== "intent_dropped" && qvec !== null;

  const allCards = result.eligible
    .map((c) => toCard(c, profile, hasQueryForScoring, now))
    .sort((a, b) => b.score - a.score || a.program.id - b.program.id);

  const nearMisses = result.nearMiss
    .map((c) => toNearMiss(c, profile, hasQueryForScoring, now))
    .filter((x): x is NearMissCard => x !== null)
    .sort((a, b) => b.score - a.score || a.program.id - b.program.id)
    .slice(0, 5); // 최대 5건 (§7.6)

  // form 탭 집계는 좁히기 전 전체 기준 (§5 — 검색 전 필터가 아니라 결과 후 좁히기)
  const byForm = FORMS.reduce(
    (acc, f) => {
      acc[f] = allCards.filter((c) => c.program.form === f).length;
      return acc;
    },
    {} as Record<ProgramForm, number>,
  );

  const filtered =
    input.form === "all"
      ? allCards
      : allCards.filter((c) => c.program.form === input.form);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, input.page), totalPages);
  const pageCards = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return {
    summary: {
      profileLabel: profileLabel(profile),
      total: filtered.length,
      byForm,
    },
    cards: pageCards,
    nearMisses,
    relaxation: stage,
    relaxationNotice: RELAXATION_NOTICE[stage],
    page,
    pageSize: PAGE_SIZE,
    totalPages,
    demoMode,
    degraded,
    tookMs: Date.now() - started,
  };
}

/** 상세 화면용 단건 조회 */
export async function getProgram(id: number): Promise<Program | null> {
  if (!isDbConfigured()) {
    const { demoProgram } = await import("./demo-store");
    return demoProgram(id);
  }
  const sql = getSql();
  if (!sql) return null;
  const rows = await sql`
    SELECT p.*,
           e.age_min, e.age_max, e.gender, e.regions, e.occupations,
           e.income_decile_max, e.extra_conditions, e.parse_method, e.confidence
    FROM programs p
    LEFT JOIN eligibility_rules e ON e.program_id = p.id
    WHERE p.id = ${id}::bigint
    LIMIT 1`;
  if (rows.length === 0) return null;
  return rowToProgram(rows[0]);
}
