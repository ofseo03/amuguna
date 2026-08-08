/**
 * GET /api/unsubscribe/:token — 1클릭 해지 (SPEC §9, 이메일 링크용).
 *
 * §8: 이메일이 등록된 프로필은 90일 자동 삭제 대상에서 제외되므로,
 * 해지 시에는 프로필까지 **즉시 삭제**한다. 이메일만 지우면 익명 프로필이 영구히 남는다.
 */
import { NextResponse } from "next/server";
import { getSql, isDbConfigured } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;

  if (!token || token.length < 16 || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    return NextResponse.json(
      { ok: false, message: "해지 링크가 올바르지 않습니다." },
      { status: 400 },
    );
  }

  if (!isDbConfigured()) {
    return NextResponse.json({
      ok: true,
      demoMode: true,
      message:
        "데모 모드입니다. 데이터베이스가 연결되어 있지 않아 해지할 등록 정보가 없습니다.",
    });
  }

  try {
    const sql = getSql();
    if (!sql) throw new Error("DB 미연결");
    // 이메일만 지우지 않고 프로필 행 자체를 삭제한다 (§8)
    const deleted = await sql`
      DELETE FROM profiles WHERE unsubscribe_token = ${token} RETURNING id`;
    if (deleted.length === 0) {
      return NextResponse.json(
        { ok: false, message: "이미 해지되었거나 유효하지 않은 링크입니다." },
        { status: 404 },
      );
    }
  } catch (e) {
    console.error("[api/unsubscribe] 해지 실패", e);
    return NextResponse.json(
      { ok: false, message: "해지 처리 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    demoMode: false,
    message: "알림이 해지되었고 등록하신 정보가 삭제되었습니다.",
  });
}
