/** POST /api/confirm/:token — 이메일 링크에서 온 double opt-in 확인. */
import { NextResponse } from "next/server";

import { getSql, isDbConfigured } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (token.length < 20 || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    return NextResponse.json({ ok: false, message: "확인 링크가 올바르지 않습니다." }, { status: 400 });
  }
  if (!isDbConfigured()) {
    return NextResponse.json({ ok: true, demoMode: true, message: "데모 모드에서는 이메일 확인이 필요하지 않습니다." });
  }
  try {
    const sql = getSql();
    if (!sql) throw new Error("DB 미연결");
    const confirmed = await sql`
      UPDATE profiles
      SET email_confirmed_at = now(), confirmation_token = NULL
      WHERE confirmation_token = ${token} AND email IS NOT NULL AND email_confirmed_at IS NULL
      RETURNING id
    `;
    if (!confirmed.length) {
      return NextResponse.json(
        { ok: false, message: "이미 확인되었거나 유효하지 않은 링크입니다." },
        { status: 404 },
      );
    }
  } catch (error) {
    console.error("[api/confirm] failed", error);
    return NextResponse.json({ ok: false, message: "이메일 확인 중 오류가 발생했습니다." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, demoMode: false, message: "이메일 확인이 완료되었습니다. 이제 하루 한 번 알림을 받을 수 있습니다." });
}
