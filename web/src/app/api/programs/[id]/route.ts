/**
 * GET /api/programs/:id — 상세 (SPEC §9).
 * 세션 프로필이 있으면 자격 체크리스트(✅/❌)를 함께 돌려준다.
 */
import { NextResponse } from "next/server";
import { getProgram } from "@/lib/matching";
import { checklist, dDay, evaluate, needsEligibilityReview } from "@/lib/eligibility";
import { readProfile } from "@/lib/session";
import { isDbConfigured } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const numeric = Number(id);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return NextResponse.json(
      { ok: false, message: "프로그램 번호가 올바르지 않습니다." },
      { status: 400 },
    );
  }

  let program;
  try {
    program = await getProgram(numeric);
  } catch (e) {
    console.error("[api/programs] 조회 실패", e);
    return NextResponse.json(
      { ok: false, message: "정보를 불러오지 못했습니다." },
      { status: 500 },
    );
  }
  if (!program) {
    return NextResponse.json(
      { ok: false, message: "해당 지원 정보를 찾을 수 없습니다." },
      { status: 404 },
    );
  }

  const profile = await readProfile();
  const ev = profile ? evaluate(program.rules, profile) : null;
  const review = ev ? needsEligibilityReview(program.rules, ev.unknownDimensions) : false;

  return NextResponse.json({
    ok: true,
    program,
    dDay: dDay(program),
    checklist: profile ? checklist(program.rules, profile) : null,
    eligible: ev ? (ev.violations > 0 ? false : review ? null : true) : null,
    violations: ev ? ev.violations : null,
    extraConditions: program.rules.extra_conditions,
    source: { url: program.source_url, fetchedAt: program.fetched_at },
    demoMode: !isDbConfigured(),
    disclaimer:
      "본 정보는 참고용이며 최종 자격 판정은 소관 기관 확인이 필요합니다.",
  });
}
