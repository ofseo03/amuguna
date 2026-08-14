import { createHash } from "node:crypto";

import { normalizeText } from "./dictionaries";

// 파서 의미가 바뀌면 올린다. content_hash 접두사가 달라져 기존 공고도 다음
// 수집에서 한 번 일반 수정 경로를 타며 새 eligibility_rules 로 교체된다.
export const PARSER_VERSION = 2;
export const PARSER_HASH_PREFIX = `parser-v${PARSER_VERSION}:`;

export const HASHED_FIELDS = [
  "title",
  "body_text",
  "form",
  "issuer",
  "issuer_level",
  "benefit_amount_text",
  "benefit_amount_min",
  "benefit_amount_max",
  "apply_url",
  "apply_method",
  "starts_at",
  "ends_at",
  "is_always_open",
  "eligibility_text",
] as const;

export interface CollectedProgramInput {
  external_id: string;
  source_key: string;
  source_url: string;
  title: string;
  body_text: string;
  eligibility_text?: string;
  form?: "subsidy" | "loan" | "tax" | "product" | "law";
  issuer?: string;
  issuer_level?: "central" | "metro" | "local";
  benefit_amount_text?: string;
  benefit_amount_min?: number | null;
  benefit_amount_max?: number | null;
  apply_url?: string;
  apply_method?: string;
  starts_at?: string | null;
  ends_at?: string | null;
  is_always_open?: boolean;
  raw_body?: Record<string, unknown>;
}

export class CollectedProgram {
  external_id: string;
  source_key: string;
  source_url: string;
  title: string;
  body_text: string;
  eligibility_text: string;
  form: "subsidy" | "loan" | "tax" | "product" | "law";
  issuer: string;
  issuer_level: "central" | "metro" | "local";
  benefit_amount_text: string;
  benefit_amount_min: number | null;
  benefit_amount_max: number | null;
  apply_url: string;
  apply_method: string;
  starts_at: string | null;
  ends_at: string | null;
  is_always_open: boolean;
  raw_body: Record<string, unknown>;

  constructor(input: CollectedProgramInput) {
    this.external_id = input.external_id;
    this.source_key = input.source_key;
    this.source_url = input.source_url;
    this.title = input.title;
    this.body_text = input.body_text;
    this.eligibility_text = input.eligibility_text ?? "";
    this.form = input.form ?? "subsidy";
    this.issuer = input.issuer ?? "";
    this.issuer_level = input.issuer_level ?? "central";
    this.benefit_amount_text = input.benefit_amount_text ?? "";
    this.benefit_amount_min = input.benefit_amount_min ?? null;
    this.benefit_amount_max = input.benefit_amount_max ?? null;
    this.apply_url = input.apply_url ?? "";
    this.apply_method = input.apply_method ?? "";
    this.starts_at = input.starts_at ?? null;
    this.ends_at = input.ends_at ?? null;
    this.is_always_open = input.is_always_open ?? false;
    this.raw_body = input.raw_body ?? {};
  }

  comparisonFields(): Record<(typeof HASHED_FIELDS)[number], string | number | boolean | null> {
    return Object.fromEntries(
      HASHED_FIELDS.map((name) => {
        const value = this[name];
        return [name, typeof value === "string" ? normalizeText(value) : value];
      }),
    ) as Record<(typeof HASHED_FIELDS)[number], string | number | boolean | null>;
  }

  contentHash(): string {
    const fields = this.comparisonFields();
    const sorted = Object.fromEntries(
      Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    const digest = createHash("sha256").update(JSON.stringify(sorted), "utf8").digest("hex");
    return `${PARSER_HASH_PREFIX}${digest}`;
  }

  embeddingSource(): string {
    const parts = [this.body_text];
    if (this.eligibility_text && !this.body_text.includes(this.eligibility_text)) {
      parts.push(`[자격요건]\n${this.eligibility_text}`);
    }
    return parts.filter(Boolean).join("\n\n");
  }

  toDict(): CollectedProgramInput {
    return { ...this };
  }
}

export type ParseMethod = "regex" | "llm" | "mixed";
export type ParseEvidence = Record<string, unknown>;
export type ExtraCondition = Record<string, string>;

export interface EligibilityRulesInput {
  age_min?: number | null;
  age_max?: number | null;
  gender?: "M" | "F" | null;
  regions?: string[] | null;
  occupations?: string[] | null;
  income_decile_max?: number | null;
  extra_conditions?: ExtraCondition[];
  parse_method?: ParseMethod;
  parse_evidence?: ParseEvidence;
  confidence?: number;
  needs_review?: boolean;
  review_reason?: string | null;
}

export class EligibilityRules {
  static readonly BLOCKING_REVIEW_REASONS = new Set([
    "llm_failed",
    "llm_validation_rejected",
  ]);

  age_min: number | null;
  age_max: number | null;
  gender: "M" | "F" | null;
  regions: string[] | null;
  occupations: string[] | null;
  income_decile_max: number | null;
  extra_conditions: ExtraCondition[];
  parse_method: ParseMethod;
  parse_evidence: ParseEvidence;
  confidence: number;
  needs_review: boolean;
  review_reason: string | null;

  constructor(input: EligibilityRulesInput = {}) {
    this.age_min = input.age_min ?? null;
    this.age_max = input.age_max ?? null;
    this.gender = input.gender ?? null;
    this.regions = input.regions ?? null;
    this.occupations = input.occupations ?? null;
    this.income_decile_max = input.income_decile_max ?? null;
    this.extra_conditions = input.extra_conditions ?? [];
    this.parse_method = input.parse_method ?? "regex";
    this.parse_evidence = input.parse_evidence ?? {};
    this.confidence = input.confidence ?? 0;
    this.needs_review = input.needs_review ?? false;
    this.review_reason = input.review_reason ?? null;
  }

  get blocksActivation(): boolean {
    return this.review_reason !== null && EligibilityRules.BLOCKING_REVIEW_REASONS.has(this.review_reason);
  }

  toRow(): Omit<EligibilityRulesInput, "needs_review" | "review_reason"> {
    return {
      age_min: this.age_min,
      age_max: this.age_max,
      gender: this.gender,
      regions: this.regions,
      occupations: this.occupations,
      income_decile_max: this.income_decile_max,
      extra_conditions: this.extra_conditions,
      parse_method: this.parse_method,
      parse_evidence: this.parse_evidence,
      confidence: this.confidence,
    };
  }

  filledFields(): string[] {
    return [
      "age_min",
      "age_max",
      "gender",
      "regions",
      "occupations",
      "income_decile_max",
    ].filter((name) => {
      const value = this[name as keyof EligibilityRules];
      return value !== null && value !== "" && (!Array.isArray(value) || value.length > 0);
    });
  }
}
