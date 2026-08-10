import {
  clauseBounds,
  clauseOf,
  hasDependentContext,
  lookupOccupations,
  lookupRegions,
  midrateToDecile,
  nonRequirementReason,
  normalizeText,
  type LookupMatch,
  type LookupMeta,
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
    source: "차상위\\s*계층|기초생활\\s*수급|생계급여|의료급여\\s*수급",
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
  ["industrial_accident", "산업재해|산재(?:노동자|근로자|장해인)"],
  ["housing", "무주택(?:자|세대주|세대구성원)?|주택\\s*미소유"],
  ["residency_period", "\\d+\\s*(?:개월|년)\\s*이상\\s*(?:계속\\s*)?(?:거주|주민등록)"],
  ["duplicate_support", "중복\\s*(?:수혜|지원)\\s*(?:불가|제한)|유사\\s*지원을?\\s*받지\\s*않은"],
  ["credit", "신용\\s*등급|신용\\s*점수|연체\\s*중|채무\\s*불이행"],
  [
    "business_history",
    "사업자\\s*등록|사업\\s*개시\\s*후\\s*\\d+\\s*년|업력\\s*\\d+\\s*년|창업\\s*\\d+\\s*년\\s*(?:이내|인내)",
  ],
  [
    "employment_period",
    "(?:재직|근속)\\s*(?:기간)?\\s*\\d+\\s*(?:년|개월)\\s*(?:이하|이내|이상)|\\d+\\s*(?:년|개월)\\s*(?:이하|이내|이상)\\s*재직",
  ],
  [
    "income_amount",
    "(?:연(?:간)?|월)\\s*소득\\s*[\\d,]+\\s*(?:원|만원|억원)\\s*(?:이하|미만)",
  ],
  ["insurance", "4대\\s*보험|고용보험\\s*가입|건강보험료\\s*본인부담"],
  ["assets", "재산\\s*과세표준|자산\\s*\\d+\\s*(?:만원|억)|총자산"],
  ["income_exception", "중위소득\\s*\\d{1,3}\\s*%\\s*(?:초과|이상)"],
  ["household", "세대주|세대원\\s*전원|1인\\s*가구"],
  ["education", "재학\\s*중|졸업\\s*후\\s*\\d+\\s*년"],
  ["military", "병역\\s*(?:필|의무\\s*이행)|군\\s*복무"],
  ["prior_training", "교육\\s*(?:이수|수료)\\s*(?:자|필수)"],
];

const EXTRA_CONDITION_LABELS: Record<string, string> = {
  industrial_accident: "산재 대상 조건",
  housing: "주택 보유 조건",
  residency_period: "거주 기간 조건",
  duplicate_support: "중복 수혜 제한",
  credit: "신용 조건",
  business_history: "사업 이력 조건",
  employment_period: "재직 기간 조건",
  income_amount: "금액 소득 조건",
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

function sameSentence(text: string, first: Span, second: Span): boolean {
  const left = first.start < second.start ? first.end : second.end;
  const right = first.start < second.start ? second.start : first.start;
  return !/[\n.。]/u.test(text.slice(left, right));
}

function protectField(fields: Set<string>, field: string): void {
  if (field === "age_min" || field === "age_max") {
    fields.add("age_min");
    fields.add("age_max");
  } else {
    fields.add(field);
  }
}

function addRejected(rejected: ExtraCondition[], condition: ExtraCondition): void {
  if (!rejected.some(({ kind, text }) => kind === condition.kind && text === condition.text)) {
    rejected.push(condition);
  }
}

function sharedAlternativePrefix(
  span: Span,
  left: number,
  clause: string,
  branches: string[],
  field: keyof ParsedValues | "regions",
): boolean {
  const connector = clause.search(/또는|혹은/u);
  const candidate = span.start - left;
  if (connector === -1 || candidate >= connector) return false;
  const between = clause.slice(candidate + (span.end - span.start), connector);
  const contradiction = field === "regions"
    ? /(?:전국|(?:지역|거주지?)\s*(?:무관|제한\s*없는|기준\s*없는))/u
    : field === "income_decile_max"
      ? /소득\s*(?:무관|제한\s*없는|기준\s*없는)/u
      : /(?:연령|나이)\s*(?:무관|제한\s*없는|기준\s*없는)/u;
  return (
    !contradiction.test(clause) &&
    /(?:인|하는)\s+\S+\s*$/u.test(between) &&
    branches.every((branch) => lookupOccupations(branch)[0].length > 0)
  );
}

function ambiguousScalarCandidate(
  text: string,
  span: Span,
  patterns: Pattern[],
  field: keyof ParsedValues,
): string | null {
  const [left, right] = clauseBounds(text, span.start, span.end);
  const clause = text.slice(left, right);
  if (!/(?:또는|혹은)/u.test(clause)) return null;
  const branches = clause.split(/\s*(?:또는|혹은)\s*/u);
  const values = branches.map((branch) =>
    patterns.flatMap(({ source, handle }) =>
      matches(source, branch)
        .filter(
          (match) => !nonRequirementReason(branch, match.index, match.index + match[0].length),
        )
        .map((match) => handle(match)[field])
        .filter((value) => value != null),
    ),
  );
  if (values.every(({ length }) => length) && new Set(values.flat()).size === 1) return null;
  if (field !== "gender" && sharedAlternativePrefix(span, left, clause, branches, field)) {
    return null;
  }
  return clauseOf(text, span.start, span.end);
}

function ambiguousLookupCandidate(
  text: string,
  match: LookupMatch,
  lookup: (branch: string) => string[],
  field: "regions" | "occupations",
): string | null {
  const [left, right] = clauseBounds(text, match.start, match.end);
  const clause = text.slice(left, right);
  if (!/(?:또는|혹은)/u.test(clause)) return null;
  const branches = clause.split(/\s*(?:또는|혹은)\s*/u);
  if (branches.every((branch) => lookup(branch).length > 0)) return null;
  if (field === "regions" && sharedAlternativePrefix(match, left, clause, branches, field)) {
    return null;
  }
  return clauseOf(text, match.start, match.end);
}

function applyPatterns(
  patterns: Pattern[],
  text: string,
  out: ParsedValues,
  evidence: ParseEvidence,
  consumed: Span[],
  dependentGuard: boolean,
  rejected: ExtraCondition[],
  protectedFields: Set<string>,
  acceptedSpans: Partial<Record<keyof ParsedValues, Span>>,
  unsafeSpans: Map<keyof ParsedValues, Span[]>,
): void {
  for (const { source, handle } of patterns) {
    for (const match of matches(source, text)) {
      const span = { start: match.index, end: match.index + match[0].length };
      if (overlaps(span, consumed)) continue;
      const parsed = handle(match);
      const nonRequirement = nonRequirementReason(text, span.start, span.end);
      if (nonRequirement) {
        for (const field of Object.keys(parsed)) protectField(protectedFields, field);
        addRejected(rejected, {
          kind: "non_requirement",
          text: clauseOf(text, span.start, span.end),
          reason: `'${nonRequirement}' 문맥 — 지원 요건이 아님`,
        });
        consumed.push(span);
        continue;
      }
      if (dependentGuard) {
        const reason = dependentReason(text, span.start, span.end);
        if (reason) {
          for (const field of Object.keys(parsed)) protectField(protectedFields, field);
          addRejected(rejected, {
            kind: "dependent_person",
            text: clauseOf(text, span.start, span.end),
            reason: `'${reason}' 문맥 — 신청자 본인 조건이 아님`,
          });
          consumed.push(span);
          continue;
        }
      }
      const fresh = Object.entries(parsed).filter(([key]) => {
        const field = key as keyof ParsedValues;
        const alternative = ambiguousScalarCandidate(text, span, patterns, field);
        if (!alternative) {
          if (unsafeSpans.get(field)?.some((unsafe) => sameSentence(text, unsafe, span))) {
            return false;
          }
          unsafeSpans.delete(field);
          return out[field] == null;
        }
        const accepted = acceptedSpans[field];
        if (accepted && !sameSentence(text, accepted, span)) return false;
        protectField(protectedFields, field);
        unsafeSpans.set(field, [...(unsafeSpans.get(field) ?? []), span]);
        const kind = field === "age_min" || field === "age_max"
          ? "age_alternatives"
          : "alternative_constraints";
        addRejected(rejected, {
          kind,
          text: alternative,
          reason: `'또는/혹은'의 일부 분기에만 ${field.startsWith("age_") ? "나이" : field === "gender" ? "성별" : "소득"} 조건이 있음`,
        });
        return false;
      });
      if (!fresh.length) continue;
      for (const [key, value] of fresh) {
        Object.assign(out, { [key]: value });
        acceptedSpans[key as keyof ParsedValues] = span;
        unsafeSpans.delete(key as keyof ParsedValues);
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
      if (
        !clause ||
        seen.has(key) ||
        (kind !== "income_exception" &&
          nonRequirementReason(text, match.index, match.index + match[0].length))
      ) {
        continue;
      }
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
  const protectedFields = new Set<string>();
  const acceptedSpans: Partial<Record<keyof ParsedValues, Span>> = {};
  const unsafeSpans = new Map<keyof ParsedValues, Span[]>();

  if (text) {
    applyPatterns(
      AGE,
      text,
      out,
      evidence,
      consumed,
      true,
      rejected,
      protectedFields,
      acceptedSpans,
      unsafeSpans,
    );
    applyPatterns(
      INCOME,
      text,
      out,
      evidence,
      consumed,
      false,
      rejected,
      protectedFields,
      acceptedSpans,
      unsafeSpans,
    );
    applyPatterns(
      GENDER,
      text,
      out,
      evidence,
      consumed,
      false,
      rejected,
      protectedFields,
      acceptedSpans,
      unsafeSpans,
    );
    for (const field of unsafeSpans.keys()) {
      out[field] = null;
      delete evidence[field];
    }
  }

  if (out.age_min != null && out.age_max != null && out.age_min > out.age_max) {
    out.age_min = null;
    out.age_max = null;
    delete evidence.age_min;
    delete evidence.age_max;
    protectedFields.add("age_min");
    protectedFields.add("age_max");
  }

  const hasAge =
    protectedFields.has("age_min") ||
    protectedFields.has("age_max") ||
    out.age_min != null ||
    out.age_max != null;
  const emptyLookup: [string[], string[], LookupMeta] = [
    [],
    [],
    { matches: [], rejected: false },
  ];
  const regionLookup = text ? lookupRegions(text) : emptyLookup;
  let [regions, regionEvidence] = regionLookup;
  const regionMeta = regionLookup[2];
  const occupationLookup = text
    ? lookupOccupations(text, { dropAgeDescriptors: hasAge })
    : emptyLookup;
  let [occupations, occupationEvidence] = occupationLookup;
  const occupationMeta = occupationLookup[2];
  const regionAlternative = regionMeta.matches
    .map((match) =>
      ambiguousLookupCandidate(text, match, (branch) => lookupRegions(branch)[0], "regions"),
    )
    .find(Boolean);
  const occupationAlternative = occupationMeta.matches
    .map((match) =>
      ambiguousLookupCandidate(
        text,
        match,
        (branch) => lookupOccupations(branch, { dropAgeDescriptors: hasAge })[0],
        "occupations",
      ),
    )
    .find(Boolean);
  if (regionAlternative) {
    regions = [];
    regionEvidence = [];
    protectedFields.add("regions");
    rejected.push({
      kind: "alternative_constraints",
      text: regionAlternative,
      reason: "'또는/혹은'의 일부 분기에만 지역 조건이 있음",
    });
  }
  if (occupationAlternative) {
    occupations = [];
    occupationEvidence = [];
    protectedFields.add("occupations");
    rejected.push({
      kind: "alternative_constraints",
      text: occupationAlternative,
      reason: "'또는/혹은'의 일부 분기에만 직업 조건이 있음",
    });
  }
  if (regionMeta.rejected && !regions.length) protectedFields.add("regions");
  if (occupationMeta.rejected && !occupations.length) protectedFields.add("occupations");
  if (regions.length) evidence.regions = { text: regionEvidence.join(", "), method: "regex" };
  if (occupations.length) {
    evidence.occupations = { text: occupationEvidence.join(", "), method: "regex" };
  }
  if (protectedFields.size) evidence._protected_fields = [...protectedFields].sort();

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
