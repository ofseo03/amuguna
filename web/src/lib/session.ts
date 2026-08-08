/**
 * 익명 세션 (SPEC §8 개인정보).
 *
 * 회원가입 없음. 프로필 5필드는 httpOnly 쿠키에만 담고,
 * 자유입력("원하는 것")은 절대 쿠키에도 DB 에도 넣지 않는다 — 요청 처리 중에만 존재한다.
 *
 * 쿠키에는 HMAC 서명을 붙여 클라이언트 변조를 막는다. 서명 키가 없으면
 * (로컬/데모) 고정 개발 키를 쓰되 서버 로그에 경고를 남긴다.
 */
import { cookies } from "next/headers";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Profile } from "./types";

export const PROFILE_COOKIE = "amuguna_profile";
export const SESSION_COOKIE = "amuguna_sid";

/** 프로필 보관 90일 후 자동 삭제 정책(§8)과 맞춘 쿠키 수명 */
const MAX_AGE_SEC = 60 * 60 * 24 * 90;

let warned = false;
function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 16) return s;
  if (!warned) {
    warned = true;
    console.warn(
      "[session] SESSION_SECRET 미설정 — 개발용 고정 키를 사용합니다. 배포 시 반드시 설정하세요.",
    );
  }
  return "amuguna-dev-only-session-secret";
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function serializeProfile(p: Profile): string {
  const payload = Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function deserializeProfile(raw: string | undefined): Profile | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!safeEqual(sig, sign(payload))) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (
      typeof obj?.age !== "number" ||
      typeof obj?.occupation !== "string" ||
      typeof obj?.sidoCode !== "string" ||
      typeof obj?.sigunguCode !== "string" ||
      typeof obj?.incomeDecile !== "number"
    ) {
      return null;
    }
    return obj as Profile;
  } catch {
    return null;
  }
}

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: MAX_AGE_SEC,
};

export async function readProfile(): Promise<Profile | null> {
  const jar = await cookies();
  return deserializeProfile(jar.get(PROFILE_COOKIE)?.value);
}

export async function writeProfile(p: Profile): Promise<void> {
  const jar = await cookies();
  jar.set(PROFILE_COOKIE, serializeProfile(p), COOKIE_OPTS);
}

export async function clearProfile(): Promise<void> {
  const jar = await cookies();
  jar.delete(PROFILE_COOKIE);
}

/** 익명 세션 id — rate limit 키와 (DB 연결 시) profiles 행 식별에 쓴다 */
export async function readOrCreateSessionId(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(SESSION_COOKIE)?.value;
  if (existing && /^[0-9a-f-]{36}$/.test(existing)) return existing;
  const sid = randomUUID();
  jar.set(SESSION_COOKIE, sid, COOKIE_OPTS);
  return sid;
}

/** 쓰기 없이 읽기만 (읽기 전용 컨텍스트에서 안전) */
export async function readSessionId(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(SESSION_COOKIE)?.value ?? null;
}
