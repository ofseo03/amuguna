/** SPEC §5 데이터 모델 / §9 API 초안에 대응하는 공용 타입. */

export type Gender = "M" | "F" | null;

/** SPEC §5 form — 결과 화면 탭 전용 (검색 전 필터 아님). */
export type ProgramForm = "subsidy" | "loan" | "tax" | "product" | "law";

export type IssuerLevel = "central" | "metro" | "local";

/** SPEC §5 입력 필드 1~5 (인적사항). 자유입력(6번)은 저장하지 않으므로 여기에 없다. */
export interface Profile {
  /** 만 나이 0~120 */
  age: number;
  gender: Gender;
  /** shared/occupations.json 의 code */
  occupation: string;
  /** 시도 2자리. shared/regions.json 화이트리스트 */
  sidoCode: string;
  /** 시군구 5자리. shared/regions.json 화이트리스트 */
  sigunguCode: string;
  /** 1~10 */
  incomeDecile: number;
}

/** SPEC §7.3 질의용 지역 코드 배열 — [시도 2자리, 시군구 5자리] */
export type RegionPrefixes = [string, string];

/** SPEC §5 extra_conditions — 정형화 실패분, 표시 전용 (필터링에 쓰지 않음, §6.3) */
export interface ExtraCondition {
  label: string;
  /** 원문 발췌 */
  text: string;
}

/** SPEC §5 eligibility_rules */
export interface EligibilityRules {
  age_min: number | null;
  age_max: number | null;
  gender: Gender;
  /** NULL = 전국. 시도 2자리 / 시군구 5자리 혼재 저장 */
  regions: string[] | null;
  occupations: string[] | null;
  income_decile_max: number | null;
  extra_conditions: ExtraCondition[];
  parse_method: "regex" | "llm" | "mixed";
  confidence: number;
}

/** SPEC §5 programs + eligibility_rules 조인 결과 (카드/상세 렌더 단위) */
export interface Program {
  id: number;
  external_id: string;
  title: string;
  /** 배치 LLM 생성 (§7.5) */
  summary: string;
  body_text: string;
  form: ProgramForm;
  issuer: string;
  issuer_level: IssuerLevel;
  benefit_amount_text: string | null;
  benefit_amount_min: number | null;
  benefit_amount_max: number | null;
  apply_url: string | null;
  apply_method: string | null;
  starts_at: string | null;
  ends_at: string | null;
  is_always_open: boolean;
  source_url: string;
  fetched_at: string;
  status: "active" | "expired" | "needs_review";
  /** 배치 LLM 생성 3단계 (§7.5) */
  apply_steps: string[];
  rules: EligibilityRules;
}

/** SPEC §7.3 의 6개 자격 조건 축 */
export type RuleDimension =
  | "age"
  | "gender"
  | "region"
  | "occupation"
  | "income";

export interface DimensionCheck {
  dimension: RuleDimension;
  /** 이 프로그램이 해당 축에 조건을 걸고 있는가 (NULL = 조건 없음 = 통과) */
  constrained: boolean;
  pass: boolean;
  /** 상세 화면 체크리스트 문구 */
  requirement: string;
  mine: string;
}

export interface ScoreBreakdown {
  similarity: number;
  specificity: number;
  regionProximity: number;
  amountScale: number;
  deadlineUrgency: number;
  /** 가중 합산 최종 점수 0~1 */
  total: number;
}

/** 결과 카드 1건 */
export interface MatchCard {
  program: Program;
  score: number;
  breakdown: ScoreBreakdown;
  sim: number;
  /** §7.5 템플릿 조립 근거 문장 */
  reason: string;
  /** 카드 배지 (매칭에 관여한 내 속성) */
  badges: string[];
  dDay: number | null;
}

/** §7.6 근접 탈락 1건 */
export interface NearMissCard {
  program: Program;
  score: number;
  violatedDimension: RuleDimension;
  /** "소득 2분위 이하면 대상입니다 (현재 3분위)" */
  message: string;
  dDay: number | null;
}

/** §7.7 적용된 완화 단계 */
export type RelaxationStage =
  | "none"
  | "topk_expanded"
  | "intent_dropped"
  | "near_miss_only";

export interface MatchResponse {
  /** 매칭 요약 배너용 */
  summary: {
    /** "28세 · 서울 관악구 기준" */
    profileLabel: string;
    total: number;
    /** form 탭별 건수 */
    byForm: Record<ProgramForm, number>;
  };
  cards: MatchCard[];
  nearMisses: NearMissCard[];
  relaxation: RelaxationStage;
  /** 완화 적용 시 화면에 그대로 노출할 안내 문구 (§7.7) */
  relaxationNotice: string | null;
  page: number;
  pageSize: number;
  totalPages: number;
  /** DB 미연결 시 true — 번들 데모 데이터로 동작 중 */
  demoMode: boolean;
  /** 임베딩 실패 등으로 의도 축이 빠진 경우 (§8 신뢰성) */
  degraded: boolean;
  tookMs: number;
}
