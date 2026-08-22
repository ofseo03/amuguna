"use client";

/**
 * 온보딩 6단계 (SPEC §9 화면 2, §5 입력 필드 정의).
 * 인적사항 5 + 원하는 것 1. 진행바 / 뒤로가기 / 마지막 단계 건너뛰기.
 *
 * 자유입력("원하는 것")은 서버에 저장하지 않는다 (§8).
 * 결과 화면이 새로고침돼도 같은 결과를 다시 그릴 수 있도록 브라우저 탭 메모리
 * (sessionStorage)에만 잠시 두며, 탭을 닫으면 사라진다.
 */
import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  DECILES,
  MEDIAN_INCOME_SOURCE_URL,
  MEDIAN_INCOME_YEAR,
  OCCUPATIONS,
  SIDO,
  medianIncomeAmount,
  medianIncomePercent,
  sigunguOf,
} from "@/lib/shared-data";
import { MAX_QUERY_LEN } from "@/lib/validation";
import { QUERY_STORAGE_KEY } from "@/lib/client-keys";
import Term from "@/components/Term";
import StepTrail, { STEP_LABELS } from "@/components/StepTrail";
import PrivacyAssurance from "@/components/PrivacyAssurance";
import type { Gender } from "@/lib/types";

/** 단계 수는 StepTrail 의 라벨 목록에서 파생한다 — 두 곳이 어긋나지 않게 */
const TOTAL_STEPS = STEP_LABELS.length;

const STEP_TITLES = [
  "나이를 알려주세요",
  "성별을 선택해 주세요",
  "어떤 일을 하고 계신가요?",
  "어디에 살고 계신가요?",
  "소득이 어느 정도인가요?",
  "어떤 도움이 필요하신가요?",
];

/** SPEC §5 — 필터가 아니라 입력 도우미다. 누르면 입력칸에 채워지고 고칠 수 있다. */
const EXAMPLES = [
  "보증금 올려달래서 대출 알아봐요",
  "가게 확장하려는데 자금이 필요해요",
  "목돈 모으고 싶어요",
  "병원비가 부담돼요",
];

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [age, setAge] = useState("");
  const [gender, setGender] = useState<Gender | "unset">("unset");
  const [occupation, setOccupation] = useState("");
  const [sidoCode, setSidoCode] = useState("");
  const [sigunguCode, setSigunguCode] = useState("");
  const [incomeDecile, setIncomeDecile] = useState<number | null>(null);
  const [incomeDecileChosen, setIncomeDecileChosen] = useState(false);
  const [householdSize, setHouseholdSize] = useState("");
  const [monthlyIncome, setMonthlyIncome] = useState("");
  const [query, setQuery] = useState("");

  const queryRef = useRef<HTMLTextAreaElement>(null);
  const sigungus = useMemo(() => (sidoCode ? sigunguOf(sidoCode) : []), [sidoCode]);
  const queryLen = [...query].length;

  const ageNum = Number(age);
  const ageValid = age !== "" && Number.isInteger(ageNum) && ageNum >= 0 && ageNum <= 120;
  const householdNum = Number(householdSize);
  const monthlyIncomeWon = Number(monthlyIncome) * 10_000;
  const householdValid =
    householdSize !== "" && Number.isInteger(householdNum) && householdNum >= 1 && householdNum <= 20;
  const monthlyIncomeValid =
    monthlyIncome !== "" && Number.isFinite(monthlyIncomeWon) && monthlyIncomeWon >= 0;
  const calculatorEmpty = householdSize === "" && monthlyIncome === "";
  const calculatorValid = calculatorEmpty || (householdValid && monthlyIncomeValid);
  const calculatedMedianPercent = householdValid && monthlyIncomeValid
    ? medianIncomePercent(householdNum, monthlyIncomeWon)
    : null;

  const canAdvance =
    (step === 1 && ageValid) ||
    (step === 2 && gender !== "unset") ||
    (step === 3 && occupation !== "") ||
    (step === 4 && sidoCode !== "" && sigunguCode !== "") ||
    (step === 5 && incomeDecileChosen && calculatorValid) ||
    step === 6;

  async function submit(withQuery: string) {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          age: ageNum,
          gender: gender === "unset" ? null : gender,
          occupation,
          sidoCode,
          sigunguCode,
          incomeDecile,
          medianIncomePercent: calculatedMedianPercent,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.errors?.[0]?.message ?? "입력 정보를 저장하지 못했습니다.");
        setSubmitting(false);
        return;
      }
      // 자유입력은 서버에 보내지 않고 결과 화면에서 /api/match 로만 쓴다
      if (withQuery.trim()) {
        window.sessionStorage.setItem(QUERY_STORAGE_KEY, withQuery.trim());
      } else {
        window.sessionStorage.removeItem(QUERY_STORAGE_KEY);
      }
      router.push("/results");
    } catch {
      setError("네트워크 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.");
      setSubmitting(false);
    }
  }

  function next() {
    if (step < TOTAL_STEPS) setStep(step + 1);
  }

  return (
    <div className="mx-auto max-w-2xl px-5 py-10 sm:px-8">
      {/* 진행 표시 — 남은 질문이 무엇인지까지 보여준다 */}
      <div className="mb-8">
        <div className="mb-3 flex items-baseline justify-between">
          <p className="text-sm font-semibold text-brand">
            {step} / {TOTAL_STEPS} 단계
          </p>
          <Link href="/" className="inline-block py-1.5 text-sm text-ink-3 underline hover:text-brand">
            처음으로
          </Link>
        </div>
        <StepTrail step={step} />
      </div>

      <h1 className="mb-1 text-2xl font-bold text-ink sm:text-3xl">
        {STEP_TITLES[step - 1]}
      </h1>

      <form
        className="mt-7"
        onSubmit={(e) => {
          e.preventDefault();
          if (step === TOTAL_STEPS) void submit(query);
          else if (canAdvance) next();
        }}
      >
        {/* ---------------- 1. 나이 ---------------- */}
        {step === 1 && (
          <div>
            <label htmlFor="age" className="block text-ink-2">
              만 나이를 숫자로 입력해 주세요.
            </label>
            <div className="mt-3 flex items-center gap-3">
              <input
                id="age"
                name="age"
                type="number"
                inputMode="numeric"
                min={0}
                max={120}
                autoFocus
                value={age}
                onChange={(e) => setAge(e.target.value)}
                aria-describedby="age-help"
                className="w-40 rounded-lg border-2 border-line bg-bg px-4 py-3 text-2xl font-bold text-ink focus:border-brand"
              />
              <span className="text-xl text-ink-2">세</span>
            </div>
            <p id="age-help" className="mt-3 text-sm text-ink-3">
              0세부터 120세까지 입력할 수 있습니다. 나이 조건이 있는 지원을
              가려내는 데만 씁니다.
            </p>
            {age !== "" && !ageValid && (
              <p role="alert" className="mt-3 text-sm font-semibold text-danger">
                0에서 120 사이의 숫자를 입력해 주세요.
              </p>
            )}
          </div>
        )}

        {/* ---------------- 2. 성별 ---------------- */}
        {step === 2 && (
          <fieldset>
            <legend className="mb-3 text-ink-2">
              성별 조건이 있는 지원을 가려내는 데만 씁니다.
            </legend>
            <div className="grid gap-3 sm:grid-cols-3">
              {[
                { v: "M" as const, label: "남성" },
                { v: "F" as const, label: "여성" },
                { v: null, label: "선택 안 함" },
              ].map((o) => (
                <ChoiceButton
                  key={String(o.v)}
                  name="gender"
                  checked={gender !== "unset" && gender === o.v}
                  onSelect={() => setGender(o.v)}
                  label={o.label}
                />
              ))}
            </div>
            <p className="mt-4 text-sm text-ink-3">
              &ldquo;선택 안 함&rdquo;을 고르면 성별 조건이 있는 지원도 모두
              결과에 포함합니다.
            </p>
          </fieldset>
        )}

        {/* ---------------- 3. 직업 ---------------- */}
        {step === 3 && (
          <fieldset>
            <legend className="mb-3 text-ink-2">
              가장 가까운 것 하나를 골라주세요.
            </legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {OCCUPATIONS.map((o) => (
                <ChoiceButton
                  key={o.code}
                  name="occupation"
                  checked={occupation === o.code}
                  onSelect={() => setOccupation(o.code)}
                  label={o.name}
                />
              ))}
            </div>
          </fieldset>
        )}

        {/* ---------------- 4. 거주지역 (2단계) ---------------- */}
        {step === 4 && (
          <div className="space-y-6">
            <div>
              <label htmlFor="sido" className="block font-semibold text-ink">
                1) 시 · 도
              </label>
              <select
                id="sido"
                value={sidoCode}
                onChange={(e) => {
                  setSidoCode(e.target.value);
                  setSigunguCode("");
                }}
                className="mt-2 w-full rounded-lg border-2 border-line bg-bg px-4 py-3 text-lg text-ink focus:border-brand"
              >
                <option value="">선택해 주세요</option>
                {SIDO.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="sigungu" className="block font-semibold text-ink">
                2) 시 · 군 · 구
              </label>
              <select
                id="sigungu"
                value={sigunguCode}
                disabled={!sidoCode}
                onChange={(e) => setSigunguCode(e.target.value)}
                aria-describedby="sigungu-help"
                className="mt-2 w-full rounded-lg border-2 border-line bg-bg px-4 py-3 text-lg text-ink focus:border-brand disabled:bg-bg-sunken disabled:text-ink-3"
              >
                <option value="">
                  {sidoCode ? "선택해 주세요" : "시·도를 먼저 선택해 주세요"}
                </option>
                {sigungus.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name}
                  </option>
                ))}
              </select>
              <p id="sigungu-help" className="mt-3 text-sm text-ink-3">
                지자체가 자기 주민에게만 주는 지원을 찾는 데 씁니다. 상세 주소는
                묻지 않습니다.
              </p>
              {sidoCode && sigungus.length === 0 && (
                <p role="alert" className="mt-2 text-sm text-warn">
                  이 지역의 시·군·구 목록은 아직 준비 중입니다. 다른 지역을
                  선택해 주세요.
                </p>
              )}
            </div>
          </div>
        )}

        {/* ---------------- 5. 소득 ---------------- */}
        {step === 5 && (
          <div className="space-y-8">
            <fieldset>
              <legend className="mb-3 text-ink-2">
                알고 있는 <Term name="소득분위">소득분위</Term>를 골라주세요.
              </legend>
              <div className="grid gap-2">
                {DECILES.map((d) => (
                  <ChoiceButton
                    key={d.decile}
                    name="incomeDecile"
                    checked={incomeDecileChosen && incomeDecile === d.decile}
                    onSelect={() => {
                      setIncomeDecile(d.decile);
                      setIncomeDecileChosen(true);
                    }}
                    label={d.label}
                    align="left"
                  />
                ))}
                <ChoiceButton
                  name="incomeDecile"
                  checked={incomeDecileChosen && incomeDecile === null}
                  onSelect={() => {
                    setIncomeDecile(null);
                    setIncomeDecileChosen(true);
                  }}
                  label="소득분위를 모릅니다"
                  align="left"
                />
              </div>
            </fieldset>

            <fieldset className="rounded-xl border border-line bg-bg-soft p-5">
              <legend className="px-1 font-bold text-ink">
                기준중위소득 계산 <span className="font-normal text-ink-3">(선택)</span>
              </legend>
              <p className="text-sm text-ink-2">
                두 값을 모두 입력하면 {MEDIAN_INCOME_YEAR}년 공식 기준과 비교합니다.
                실제 심사는 재산을 환산한 소득인정액 등을 사용할 수 있어 예상치입니다.
              </p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="font-semibold text-ink">
                  가구원 수
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={20}
                    value={householdSize}
                    onChange={(e) => setHouseholdSize(e.target.value)}
                    className="mt-2 w-full rounded-lg border-2 border-line bg-bg px-4 py-3 text-ink focus:border-brand"
                  />
                </label>
                <label className="font-semibold text-ink">
                  월 가구소득 또는 소득인정액
                  <span className="ml-1 font-normal text-ink-3">(만원)</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.1"
                    value={monthlyIncome}
                    onChange={(e) => setMonthlyIncome(e.target.value)}
                    className="mt-2 w-full rounded-lg border-2 border-line bg-bg px-4 py-3 text-ink focus:border-brand"
                  />
                </label>
              </div>
              {!calculatorEmpty && !calculatorValid && (
                <p role="alert" className="mt-3 text-sm font-semibold text-danger">
                  가구원 수와 월 소득을 모두 올바르게 입력해 주세요.
                </p>
              )}
              {calculatedMedianPercent !== null && (
                <p aria-live="polite" className="mt-4 rounded-lg bg-brand-soft px-4 py-3 font-semibold text-brand-dark">
                  {householdNum}인 가구 기준액 {medianIncomeAmount(householdNum).toLocaleString("ko-KR")}원 대비 약 {calculatedMedianPercent}%입니다.
                </p>
              )}
              <p className="mt-3 text-sm text-ink-3">
                입력한 월 금액과 가구원 수는 서버로 보내거나 저장하지 않고, 계산된 비율만 저장합니다. {" "}
                <a href={MEDIAN_INCOME_SOURCE_URL} target="_blank" rel="noreferrer" className="underline hover:text-brand">
                  보건복지부 고시 확인
                </a>
              </p>
            </fieldset>
          </div>
        )}

        {/* ---------------- 6. 원하는 것 ---------------- */}
        {step === 6 && (
          <div>
            <label htmlFor="query" className="block text-ink-2">
              찾고 계신 것을 한 줄로 적어주세요. 없으면 건너뛰어도 됩니다.
            </label>
            <textarea
              id="query"
              ref={queryRef}
              value={query}
              maxLength={MAX_QUERY_LEN}
              rows={3}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
              aria-describedby="query-help query-count"
              className="mt-3 w-full rounded-lg border-2 border-line bg-bg px-4 py-3 text-lg text-ink focus:border-brand"
              placeholder="예) 보증금 올려달래서 대출 알아봐요"
            />
            <div className="mt-2 flex items-start justify-between gap-4">
              <p
                id="query-help"
                className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-ink-2"
              >
                <strong className="text-warn">개인정보는 입력하지 마세요.</strong>{" "}
                이름·연락처·주민번호·질병명 등은 적지 않으셔도 됩니다. 입력하신
                문장은 <strong>서버에 저장하지 않고</strong> 검색할 때만
                사용합니다.
              </p>
              <span
                id="query-count"
                aria-live="polite"
                className={`shrink-0 text-sm ${queryLen > MAX_QUERY_LEN - 20 ? "font-semibold text-warn" : "text-ink-3"}`}
              >
                {queryLen} / {MAX_QUERY_LEN}자
              </span>
            </div>

            <div className="mt-6">
              <p id="examples-label" className="font-semibold text-ink">
                이런 걸 찾으시나요?{" "}
                <span className="font-normal text-ink-3">
                  (누르면 입력됩니다)
                </span>
              </p>
              <ul
                aria-labelledby="examples-label"
                className="mt-3 grid gap-2 sm:grid-cols-2"
              >
                {EXAMPLES.map((ex) => (
                  <li key={ex}>
                    <button
                      type="button"
                      onClick={() => {
                        setQuery(ex);
                        queryRef.current?.focus();
                      }}
                      className="w-full rounded-lg border border-line bg-bg px-4 py-3 text-left text-ink-2 transition-colors hover:border-brand hover:bg-brand-soft"
                    >
                      · {ex}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {error && (
          <p
            role="alert"
            className="mt-6 rounded-lg border border-danger bg-danger-soft px-4 py-3 font-semibold text-danger"
          >
            {error}
          </p>
        )}

        {/* ---------------- 이동 버튼 ---------------- */}
        <div className="mt-10 flex flex-wrap items-center gap-3 border-t border-line pt-6">
          <button
            type="button"
            onClick={() => (step > 1 ? setStep(step - 1) : router.push("/"))}
            className="rounded-lg border-2 border-line bg-bg px-5 py-3 font-semibold text-ink-2 transition-colors hover:bg-bg-sunken"
          >
            {step > 1 ? "← 뒤로" : "← 처음으로"}
          </button>

          {step < TOTAL_STEPS ? (
            <button
              type="submit"
              disabled={!canAdvance}
              className="rounded-lg bg-brand px-7 py-3 font-bold text-white transition-colors hover:bg-brand-dark disabled:cursor-not-allowed disabled:bg-bg-sunken disabled:text-ink-3"
            >
              다음 →
            </button>
          ) : (
            <>
              <button
                type="submit"
                disabled={submitting}
                className="rounded-lg bg-brand px-7 py-3 font-bold text-white transition-colors hover:bg-brand-dark disabled:bg-bg-sunken disabled:text-ink-3"
              >
                {submitting ? "찾는 중…" : "결과 보기"}
              </button>
              {/* 명확한 건너뛰기 (§8 접근성) */}
              <button
                type="button"
                disabled={submitting}
                onClick={() => void submit("")}
                className="rounded-lg border-2 border-line bg-bg px-6 py-3 font-semibold text-ink-2 underline transition-colors hover:bg-bg-sunken"
              >
                건너뛰기
              </button>
              <span className="w-full text-sm text-ink-3 sm:w-auto">
                건너뛰어도 대상이 되는 지원을 모두 보여드립니다.
              </span>
            </>
          )}
        </div>
      </form>

      <PrivacyAssurance />
    </div>
  );
}

/** 라디오 기반 선택 버튼 — 키보드 방향키 이동과 스크린리더 그룹 읽기를 그대로 얻는다 */
function ChoiceButton({
  name,
  checked,
  onSelect,
  label,
  sub,
  align = "center",
}: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  label: string;
  sub?: string;
  align?: "center" | "left";
}) {
  return (
    <label
      className={`flex cursor-pointer items-center gap-3 rounded-lg border-2 px-4 py-3 transition-colors ${
        checked
          ? "border-brand bg-brand-soft"
          : "border-line bg-bg hover:border-ink-3"
      } ${align === "center" ? "justify-center text-center" : ""}`}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onSelect}
        className="h-5 w-5 shrink-0 accent-[var(--brand)]"
      />
      <span className={align === "left" ? "flex-1" : ""}>
        <span className="block font-semibold text-ink">{label}</span>
        {sub && <span className="block text-sm text-ink-3">{sub}</span>}
      </span>
    </label>
  );
}
