import {
  hasDependentContext,
  lookupOccupations,
  lookupRegions,
  midrateToDecile,
  normalizeText,
} from "./dictionaries";
import {
  CollectedProgram,
  EligibilityRules,
  type ExtraCondition,
  type ParseEvidence,
  type ParseMethod,
} from "./models";

type ParsedValues = {
  age_min?: number | null;
  age_max?: number | null;
  gender?: "M" | "F" | null;
  income_decile_max?: number | null;
};
type Pattern = {
  source: string;
  handle: (match: RegExpExecArray) => ParsedValues;
};
type Span = { start: number; end: number };

const PREFIX_DEPENDENT_NOUNS = [
  "자녀",
  "아동",
  "손자녀",
  "피부양자",
  "배우자",
  "부양가족",
];
const DASH = "[~∼〜–—\\-]";

const AGE: Pattern[] = [
  {
    source: "만?\\s*(\\d{1,3})\\s*세\\s*(?:이상|부터)\\s*(?:만\\s*)?(\\d{1,3})\\s*세\\s*(?:이하|까지)",
    handle: (match) => ({ age_min: Number(match[1]), age_max: Number(match[2]) }),
  },
  {
    source: "만?\\s*(\\d{1,3})\\s*세\\s*(?:이상|부터)\\s*(?:만\\s*)?(\\d{1,3})\\s*세\\s*미만",
    handle: (match) => ({ age_min: Number(match[1]), age_max: Number(match[2]) - 1 }),
  },
  {
    source: `만?\\s*(\\d{1,3})\\s*${DASH}\\s*(\\d{1,3})\\s*세(?!대)`,
    handle: (match) => ({ age_min: Number(match[1]), age_max: Number(match[2]) }),
  },
  {
    source: "만?\\s*(\\d{1,3})\\s*세\\s*미만",
    handle: (match) => ({ age_max: Number(match[1]) - 1 }),
  },
  {
    source: "만?\\s*(\\d{1,3})\\s*세\\s*초과",
    handle: (match) => ({ age_min: Number(match[1]) + 1 }),
  },
  {
    source: "만?\\s*(\\d{1,3})\\s*세\\s*(?:이상|부터)",
    handle: (match) => ({ age_min: Number(match[1]) }),
  },
  {
    source: "만?\\s*(\\d{1,3})\\s*세\\s*(?:이하|까지)",
    handle: (match) => ({ age_max: Number(match[1]) }),
  },
];

const INCOME: Pattern[] = [
  {
    source: "(?:기준\\s*)?중위소득\\s*(\\d{1,3})\\s*%\\s*(?:이하|까지)",
    handle: (match) => ({ income_decile_max: midrateToDecile(Number(match[1])) }),
  },
  {
    source: "소득\\s*(\\d{1,2})\\s*분위\\s*이하",
    handle: (match) => ({ income_decile_max: Number(match[1]) }),
  },
  {
    source: "(\\d{1,2})\\s*분위\\s*이하",
    handle: (match) => ({ income_decile_max: Number(match[1]) }),
  },
  {
    source: "차상위\\s*계층|기초생활\\s*수급|의료급여\\s*수급",
    handle: () => ({ income_decile_max: 2 }),
  },
];

const PERSON_NOUNS =
  "(?:청년|어르신|노인|농업인|어업인|소상공인|자영업자|장애인|가장|한부모|근로자|구직자|가구주)";
const GENDER: Pattern[] = [
  {
    source: `여성만|여성에\\s*한(?:함|정)|여성으로\\s*한정|여성\\s*한정|여성\\s*${PERSON_NOUNS}`,
    handle: () => ({ gender: "F" }),
  },
  {
    source: `남성만|남성에\\s*한(?:함|정)|남성으로\\s*한정|남성\\s*한정|남성\\s*${PERSON_NOUNS}`,
    handle: () => ({ gender: "M" }),
  },
];

const EXTRA_CONDITIONS: Array<[string, string]> = [
  ["housing", "무주택(?:자|세대주|세대구성원)?|주택\\s*미소유"],
  ["residency_period", "\\d+\\s*(?:개월|년)\\s*이상\\s*(?:계속\\s*)?(?:거주|주민등록)"],
  ["duplicate_support", "중복\\s*(?:수혜|지원)\\s*(?:불가|제한)|유사\\s*지원을?\\s*받지\\s*않은"],
  ["credit", "신용\\s*등급|신용\\s*점수|연체\\s*중|채무\\s*불이행"],
  ["business_history", "사업자\\s*등록|사업\\s*개시\\s*후\\s*\\d+\\s*년|업력\\s*\\d+\\s*년"],
  ["insurance", "4대\\s*보험|고용보험\\s*가입|건강보험료\\s*본인부담"],
  ["assets", "재산\\s*과세표준|자산\\s*\\d+\\s*(?:만원|억)|총자산"],
  ["income_exception", "중위소득\\s*\\d{1,3}\\s*%\\s*(?:초과|이상)"],
  ["household", "세대주|세대원\\s*전원|1인\\s*가구"],
  ["education", "재학\\s*중|졸업\\s*후\\s*\\d+\\s*년"],
  ["military", "병역\\s*(?:필|의무\\s*이행)|군\\s*복무"],
  ["prior_training", "교육\\s*(?:이수|수료)\\s*(?:자|필수)"],
];

const EXTRA_CONDITION_LABELS: Record<string, string> = {
  housing: "주택 보유 조건",
  residency_period: "거주 기간 조건",
  duplicate_support: "중복 수혜 제한",
  credit: "신용 조건",
  business_history: "사업 이력 조건",
  insurance: "보험 가입 조건",
  assets: "재산 조건",
  income_exception: "소득 예외 조건",
  household: "세대 구성 조건",
  education: "학적 조건",
  military: "병역 조건",
  prior_training: "사전 교육 조건",
};

function matches(source: string, text: string): RegExpExecArray[] {
  return [...text.matchAll(new RegExp(source, "g"))];
}

function overlaps(span: Span, consumed: Span[]): boolean {
  return consumed.some(({ start, end }) => span.start < end && start < span.end);
}

function prefixDependent(text: string, start: number): string | null {
  const head = text.slice(Math.max(0, start - 10), start);
  return PREFIX_DEPENDENT_NOUNS.find((noun) => head.includes(noun)) ?? null;
}

function dependentReason(text: string, start: number, end: number): string | null {
  return hasDependentContext(text, start, end) ?? prefixDependent(text, start);
}

function clauseOf(text: string, start: number, end: number): string {
  let left = 0;
  let right = text.length;
  for (const match of text.matchAll(/[\n·;,]|(?<=[.。])\s/g)) {
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;
    if (matchEnd <= start) left = matchEnd;
    else if (matchStart >= end) {
      right = matchStart;
      break;
    }
  }
  return text.slice(left, right).replace(/^[ \t\-–—·]+|[ \t\-–—·]+$/g, "");
}

function alternativeAgeClause(text: string): string | null {
  const spans: Span[] = [];
  for (const { source } of AGE) {
    for (const match of matches(source, text)) {
      const span = { start: match.index, end: match.index + match[0].length };
      if (!overlaps(span, spans)) spans.push(span);
    }
  }
  spans.sort((a, b) => a.start - b.start);
  for (let index = 0; index < spans.length - 1; index += 1) {
    const current = spans[index];
    const next = spans[index + 1];
    if (text.slice(current.end, next.start).includes("또는")) {
      return clauseOf(text, current.start, next.end);
    }
  }
  return null;
}

function applyPatterns(
  patterns: Pattern[],
  text: string,
  out: ParsedValues,
  evidence: ParseEvidence,
  consumed: Span[],
  dependentGuard: boolean,
  rejected: ExtraCondition[],
): void {
  for (const { source, handle } of patterns) {
    for (const match of matches(source, text)) {
      const span = { start: match.index, end: match.index + match[0].length };
      if (overlaps(span, consumed)) continue;
      if (dependentGuard) {
        const reason = dependentReason(text, span.start, span.end);
        if (reason) {
          rejected.push({
            kind: "dependent_person",
            text: clauseOf(text, span.start, span.end),
            reason: `'${reason}' 문맥 — 신청자 본인 조건이 아님`,
          });
          consumed.push(span);
          continue;
        }
      }
      const fresh = Object.entries(handle(match)).filter(
        ([key]) => out[key as keyof ParsedValues] == null,
      );
      if (!fresh.length) continue;
      for (const [key, value] of fresh) {
        Object.assign(out, { [key]: value });
        evidence[key] = {
          text: match[0],
          start: [...text.slice(0, span.start)].length,
          end: [...text.slice(0, span.end)].length,
          pattern: source,
          method: "regex",
        };
      }
      consumed.push(span);
    }
  }
}

function extractExtraConditions(text: string): ExtraCondition[] {
  const found: ExtraCondition[] = [];
  const seen = new Set<string>();
  for (const [kind, source] of EXTRA_CONDITIONS) {
    for (const match of matches(source, text)) {
      const clause = clauseOf(text, match.index, match.index + match[0].length);
      const key = `${kind}\u0000${clause}`;
      if (!clause || seen.has(key)) continue;
      seen.add(key);
      found.push({
        kind,
        label: EXTRA_CONDITION_LABELS[kind] ?? kind,
        text: clause,
        matched: match[0],
      });
    }
  }
  return found;
}

export function computeConfidence(rules: EligibilityRules): number {
  const filled = rules.filledFields();
  if (!filled.length) return 0.2;
  const weights = filled.map((name) => {
    const item = rules.parse_evidence[name];
    return item && typeof item === "object" && "method" in item && item.method === "llm"
      ? 0.55
      : 1;
  });
  const base = weights.reduce((sum, weight) => sum + weight, 0) / weights.length;
  const coverage = Math.min(1, filled.length / 3);
  const score = base * (0.6 + 0.4 * coverage) * (rules.needs_review ? 0.8 : 1);
  return Math.round(Math.min(1, score) * 1000) / 1000;
}

export function resolveParseMethod(evidence: ParseEvidence): ParseMethod {
  const methods = new Set<string>();
  for (const [key, value] of Object.entries(evidence)) {
    if (key.startsWith("_") || !value || typeof value !== "object") continue;
    const method = "method" in value ? value.method : "regex";
    if (typeof method === "string") methods.add(method);
  }
  if (!methods.size) return "regex";
  if (methods.size > 1) return "mixed";
  return methods.has("llm") ? "llm" : "regex";
}

export function parseEligibility(rawText: string): EligibilityRules {
  const text = normalizeText(rawText);
  const out: ParsedValues = {};
  const evidence: ParseEvidence = {};
  const consumed: Span[] = [];
  const rejected: ExtraCondition[] = [];
  const ageAlternative = text ? alternativeAgeClause(text) : null;

  if (text) {
    applyPatterns(AGE, text, out, evidence, consumed, true, rejected);
    if (ageAlternative) {
      out.age_min = null;
      out.age_max = null;
      delete evidence.age_min;
      delete evidence.age_max;
      rejected.push({
        kind: "age_alternatives",
        text: ageAlternative,
        reason: "'또는'으로 연결된 복수 나이 조건 — 자동 판정 안 함",
      });
    }
    applyPatterns(INCOME, text, out, evidence, consumed, false, rejected);
    applyPatterns(GENDER, text, out, evidence, consumed, false, rejected);
  }

  if (out.age_min != null && out.age_max != null && out.age_min > out.age_max) {
    out.age_min = null;
    out.age_max = null;
    delete evidence.age_min;
    delete evidence.age_max;
  }

  const hasAge = ageAlternative !== null || out.age_min != null || out.age_max != null;
  const [regions, regionEvidence] = text ? lookupRegions(text) : [[], []];
  const [occupations, occupationEvidence] = text
    ? lookupOccupations(text, { dropAgeDescriptors: hasAge })
    : [[], []];
  if (regions.length) evidence.regions = { text: regionEvidence.join(", "), method: "regex" };
  if (occupations.length) {
    evidence.occupations = { text: occupationEvidence.join(", "), method: "regex" };
  }

  const rules = new EligibilityRules({
    age_min: out.age_min,
    age_max: out.age_max,
    gender: out.gender,
    regions: regions.length ? regions : null,
    occupations: occupations.length ? occupations : null,
    income_decile_max: out.income_decile_max,
    extra_conditions: [...extractExtraConditions(text), ...rejected],
    parse_evidence: evidence,
    parse_method: resolveParseMethod(evidence),
  });
  rules.confidence = computeConfidence(rules);
  return rules;
}

export function eligibilitySourceText(program: CollectedProgram): string {
  return program.eligibility_text.trim() ? program.eligibility_text : program.body_text;
}

export function parseProgram(program: CollectedProgram): EligibilityRules {
  return parseEligibility(eligibilitySourceText(program));
}
