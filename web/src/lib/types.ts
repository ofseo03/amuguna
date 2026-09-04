/** SPEC §5 데이터 모델 / §9 API 초안에 대응하는 공용 타입. */

export type Gender = "M" | "F" | null;

/** SPEC §5 form — 결과 화면 탭 전용 (검색 전 필터 아님). */
export type ProgramForm = "subsidy" | "loan" | "tax" | "product" | "law";

export type IssuerLevel = "central" | "metro" | "local";

/** SPEC §5 입력 필드 1~5 (인적사항). 월소득 원문과 자유입력은 저장하지 않는다. */
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
  /** 1~10 자가 선택. 모르면 null */
  incomeDecile: number | null;
  /** 2026 기준중위소득 대비 정수 비율. 브라우저 계산값이며 원소득은 저장하지 않는다. */
  medianIncomePercent: number | null;
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
  median_income_percent_max: number | null;
  extra_conditions: ExtraCondition[];
  parse_method: "regex" | "llm" | "mixed";
  confidence: number;
  /**
   * 자격요건 자동 추출 결과에 원문 확인이 필요한가 (SPEC §6.2).
   *
   * 이 값이 true 여도 공고는 정상 노출하고 상세 화면에 원문 확인 안내를 띄운다.
   */
  needs_review: boolean;
}

/** SPEC §5 programs + eligibility_rules 조인 결과 (카드/상세 렌더 단위) */
export interface Program {
  id: number;
  external_id: string;
  title: string;
  /** 수집 시 결정형으로 생성한 한 줄 요약 */
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
  /** 수집 시 결정형으로 생성한 3단계 신청 절차 */
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
  /** 조건은 있지만 대응하는 사용자 값이 없어 자동 판정하지 않음 */
  unknown: boolean;
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

/** 서버가 다음 결과 묶음을 찾는 데만 쓰는 opaque cursor payload. */
export interface MatchCursor {
  score: number;
  id: number;
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

/** `pending` 은 클라이언트 전용 — 카드는 떴고 안내를 기다리는 중이다 */
export type AiAnswerStatus = "ok" | "not_requested" | "unavailable" | "pending";

/** 결과 화면 탭 — form 별 좁혀보기 + 전체 */
export type MatchTab = ProgramForm | "all";

/** 한 탭의 한 페이지 (15건 단위) */
export interface MatchPage {
  cards: MatchCard[];
  /** 다음 페이지를 여는 keyset 커서. 마지막 페이지면 null */
  nextCursor: string | null;
}

/**
 * 탭별 페이지 묶음.
 *
 * 첫 요청(커서 없음)에는 **모든 탭의 1페이지**가 한꺼번에 담긴다 — 탭 전환은 이미 받아둔
 * 결과를 좁히는 것뿐이므로 서버를 다시 왕복하지 않는다. 2페이지 이후만 커서로 더 받아온다.
 */
export type MatchPages = Partial<Record<MatchTab, MatchPage>>;

export interface MatchResponse {
  /** 매칭 요약 배너용 */
  summary: {
    /** "28세 · 서울 관악구 기준" */
    profileLabel: string;
    /** 전체 탭 기준 총 건수 (탭별 건수는 byForm) */
    total: number;
    /** form 탭별 건수 */
    byForm: Record<ProgramForm, number>;
  };
  pages: MatchPages;
  nearMisses: NearMissCard[];
  relaxation: RelaxationStage;
  /** 완화 적용 시 화면에 그대로 노출할 안내 문구 (§7.7) */
  relaxationNotice: string | null;
  pageSize: number;
  /**
   * 자격은 되지만 자유입력(의도)과 멀어 결과에서 빠진 건수.
   *
   * 자유입력 한 줄이 결과를 조용히 깎으면, 대상인데 몰라서 못 받는 것을 없애자는 서비스가
   * 대상인 것을 숨기게 된다. 몇 건이 빠졌는지 알리고 `ignoreIntent` 로 되돌릴 수 있게 한다.
   */
  intentHiddenCount: number;
  /** 이 응답이 자유입력 필터를 끄고(= 전체 보기) 만들어졌는가 */
  intentIgnored: boolean;
  /** DB 미연결 시 true — 번들 데모 데이터로 동작 중 */
  demoMode: boolean;
  /**
   * DB 는 연결됐는데 노출 가능한 공고가 **한 건도 없는** 상태 (콜드 스타트).
   *
   * "내 조건에 맞는 게 없다"와 "아직 데이터가 없다"는 사용자에게 전혀 다른 사실인데
   * 둘 다 빈 화면으로 보이면 서비스가 고장 난 것처럼 읽힌다. 초기 적재가 며칠에 걸쳐
   * 진행되는 소스가 있으므로(SPEC §3.2 상세조회 100회/일) 이 구분이 필요하다.
   */
  catalogEmpty: boolean;
  /** 임베딩 실패 등으로 의도 축이 빠진 경우 (§8 신뢰성) */
  degraded: boolean;
  tookMs: number;
}

/**
 * `POST /api/answer` — 질의가 있는 최초 검색의 상위 5건을 근거로 실시간 생성한 안내.
 *
 * 매칭 응답과 분리한 이유: 한 응답에 묶으면 이미 계산된 카드가 OpenRouter 를 기다리는 동안
 * (최대 12초) 화면에 못 나온다. 카드를 먼저 그리고 안내는 뒤따라 받는다.
 */
export interface AnswerResponse {
  aiAnswer: string | null;
  aiAnswerStatus: AiAnswerStatus;
}
