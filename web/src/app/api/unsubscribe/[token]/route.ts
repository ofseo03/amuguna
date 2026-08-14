/** POST /api/unsubscribe/:token — 해지는 POST로만 프로필을 삭제한다. */
import { NextResponse } from "next/server";

import { getSql, isDbConfigured } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function validToken(token: string): boolean {
  return token.length >= 20 && token.length <= 128 && /^[A-Za-z0-9_-]+$/.test(token);
}

export async function POST(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!validToken(token)) {
    return NextResponse.json({ ok: false, message: "해지 링크가 올바르지 않습니다." }, { status: 400 });
  }
  if (!isDbConfigured()) {
    return NextResponse.json({
      ok: true,
      demoMode: true,
      message: "데모 모드입니다. 데이터베이스가 연결되어 있지 않아 해지할 등록 정보가 없습니다.",
    });
  }
  try {
    const sql = getSql();
    if (!sql) throw new Error("DB 미연결");
    const deleted = await sql`DELETE FROM profiles WHERE unsubscribe_token = ${token} RETURNING id`;
    if (!deleted.length) {
      return NextResponse.json(
        { ok: false, message: "이미 해지되었거나 유효하지 않은 링크입니다." },
        { status: 404 },
      );
    }
  } catch (error) {
    console.error("[api/unsubscribe] failed", error);
    return NextResponse.json({ ok: false, message: "해지 처리 중 오류가 발생했습니다." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, demoMode: false, message: "알림이 해지되었고 등록하신 정보가 삭제되었습니다." });
}
