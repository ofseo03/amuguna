/**
 * 데모 모드 저장소 (DATABASE_URL 미설정 시).
 *
 * DB 없이도 대회 데모가 완전히 동작해야 하므로 번들 JSON 을 인메모리 "DB"처럼 다룬다.
 * - programs + eligibility_rules 를 SPEC §5 형태로 그대로 보유
 * - program_embeddings 를 흉내내어 문단 단위 청크 임베딩을 최초 1회 계산해 캐시 (§7.1)
 * - ends_at 은 demo_ends_in_days 로부터 프로세스 기동 시각 기준으로 계산한다
 *   (절대 날짜로 박으면 시간이 지나 전 건 만료 → 데모가 빈 화면이 된다)
 */
import raw from "@/demo/programs.json";
import { mockEmbed } from "./embedding";
import { kstDate } from "./eligibility";
import type { EligibilityRules, Program, ProgramForm } from "./types";

interface RawRules
  extends Omit<
    EligibilityRules,
    "parse_method" | "median_income_percent_max" | "needs_review"
  > {
  parse_method: string;
  median_income_percent_max?: number | null;
  /** 데모 데이터는 손으로 라벨링했으므로 기본은 false */
  needs_review?: boolean;
}
interface RawProgram {
  id: number;
  external_id: string;
  title: string;
  summary: string;
  body_text: string;
  form: string;
  issuer: string;
  issuer_level: string;
  benefit_amount_text: string | null;
  benefit_amount_min: number | null;
  benefit_amount_max: number | null;
  apply_url: string | null;
  apply_method: string | null;
  starts_at: string | null;
  demo_ends_in_days: number | null;
  is_always_open: boolean;
  source_url: string;
  status: string;
  apply_steps: string[];
  rules: RawRules;
}

const DAY = 86_400_000;

/**
 * 데모 마감일도 **KST 달력 날짜**로 만든다 (SPEC §5).
 *
 * 운영 경로의 `programs.ends_at` 이 `date` 컬럼이라 날짜 문자열로 정규화되므로,
 * 데모가 전체 타임스탬프를 쓰면 두 경로에서 D-day 계산 분기가 갈린다.
 * 데모에서만 재현되는(또는 데모에서만 안 잡히는) 날짜 버그를 만들지 않으려면 같아야 한다.
 */
function toKstDate(daysFromNow: number, base: Date): string {
  return kstDate(new Date(base.getTime() + daysFromNow * DAY));
}

function build(): { programs: Program[]; fetchedAt: string } {
  const base = new Date();
  const fetchedAt = String(raw.fetched_at);
  const programs = (raw.programs as RawProgram[]).map<Program>((p) => ({
    id: p.id,
    external_id: p.external_id,
    title: p.title,
    summary: p.summary,
    body_text: p.body_text,
    form: p.form as ProgramForm,
    issuer: p.issuer,
    issuer_level: p.issuer_level as Program["issuer_level"],
    benefit_amount_text: p.benefit_amount_text,
    benefit_amount_min: p.benefit_amount_min,
    benefit_amount_max: p.benefit_amount_max,
    apply_url: p.apply_url,
    apply_method: p.apply_method,
    starts_at: p.starts_at,
    ends_at: p.demo_ends_in_days === null ? null : toKstDate(p.demo_ends_in_days, base),
    is_always_open: p.is_always_open,
    source_url: p.source_url,
    fetched_at: fetchedAt,
    status: p.status as Program["status"],
    apply_steps: p.apply_steps,
    rules: {
      age_min: p.rules.age_min,
      age_max: p.rules.age_max,
      gender: p.rules.gender,
      regions: p.rules.regions,
      occupations: p.rules.occupations,
      income_decile_max: p.rules.income_decile_max,
      median_income_percent_max: p.rules.median_income_percent_max ?? null,
      extra_conditions: p.rules.extra_conditions ?? [],
      parse_method: p.rules.parse_method as EligibilityRules["parse_method"],
      confidence: p.rules.confidence,
      needs_review: Boolean(p.rules.needs_review),
    },
  }));
  return { programs, fetchedAt };
}

let cache: { programs: Program[]; fetchedAt: string } | null = null;

export function demoPrograms(): Program[] {
  if (!cache) cache = build();
  return cache.programs;
}

export function demoProgram(id: number): Program | null {
  return demoPrograms().find((p) => p.id === id) ?? null;
}

export function demoFetchedAt(): string {
  if (!cache) cache = build();
  return cache.fetchedAt;
}

/* ------------------------------------------------------------------ */
/* program_embeddings 대체 — 문단 단위 청크, 프로그램 단위 MAX 집계     */
/* ------------------------------------------------------------------ */

/**
 * 색인 대상 텍스트 (SPEC §7.1): title + summary + body_text.
 * 청크 0 은 제목+요약, 이후 본문 문단마다 한 청크.
 * 벡터를 합치지 않고 청크별로 보관해 질의 시 MAX(sim) 을 취한다 —
 * "본문 중 한 문단이 강하게 일치"하는 신호가 나머지 문단에 희석되지 않게.
 */
export function chunksOf(p: Program): string[] {
  const head = `${p.title} ${p.summary}`.trim();
  const paras = p.body_text
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return [head, ...paras];
}

let embeddingIndex: Map<number, Float64Array[]> | null = null;

/** 최초 호출 시 1회 계산 후 프로세스 수명 동안 재사용 */
export function demoEmbeddingIndex(): Map<number, Float64Array[]> {
  if (embeddingIndex) return embeddingIndex;
  const idx = new Map<number, Float64Array[]>();
  for (const p of demoPrograms()) {
    idx.set(
      p.id,
      chunksOf(p).map((c) => mockEmbed(c)),
    );
  }
  embeddingIndex = idx;
  return idx;
}
