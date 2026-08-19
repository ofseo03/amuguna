/**
 * 익명 세션 (SPEC §8 개인정보).
 *
 * 회원가입 없음. 정규화한 프로필은 httpOnly 쿠키에 담고,
 * 자유입력("원하는 것")은 절대 쿠키에도 DB 에도 넣지 않는다 — 요청 처리 중에만 존재한다.
 *
 * **프로필 쿠키는 서명이 아니라 암호화한다.**
 * 서명(HMAC)은 위변조를 탐지할 뿐 내용을 가리지 못한다. 프로필은 나이·성별·직업·지역·
 * 소득분위의 조합이고 이는 준식별정보다 — 서명만 붙이면 그 조합이 평문으로 클라이언트에
 * 상주하고 매 요청 네트워크로 오간다. "서버에 개인정보를 저장하지 않는다"가 이 서비스의
 * 핵심 주장인데, 저장하지 않는 대신 평문으로 들고 다니면 주장이 약해진다.
 * 그래서 AES-256-GCM 으로 암호화한다 (기밀성 + 무결성을 함께 얻는다).
 *
 * 세션 id 는 rate limit 키로만 쓰는 무의미한 UUID 라 서명으로 충분하다.
 */
import { cookies } from "next/headers";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { Profile } from "./types";

export const PROFILE_COOKIE = "amuguna_profile";
export const SESSION_COOKIE = "amuguna_sid";

/**
 * 쿠키 수명 90일 — 재방문 시 6단계를 다시 입력하지 않아도 되게 한다.
 * 서버에 사본이 없으므로 이 값이 프로필의 유일한 보유기간이다. 개인정보처리방침에 같은 값을 고지한다(§8).
 */
const MAX_AGE_SEC = 60 * 60 * 24 * 90;

let warned = false;
export function sessionSecret(env: NodeJS.ProcessEnv = process.env): string {
  const s = env.SESSION_SECRET;
  if (s && s.length >= 32) return s;
  if (env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET은 프로덕션에서 32자 이상이어야 합니다.");
  }
  if (!warned) {
    warned = true;
    console.warn(
      "[session] SESSION_SECRET 미설정 — 개발용 고정 키를 사용합니다. 배포 시 반드시 설정하세요.",
    );
  }
  return "amuguna-dev-only-session-secret";
}

function sign(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function serializeSessionId(id: string): string {
  if (!UUID_V4.test(id)) throw new Error("invalid session id");
  return `${id}.${sign(`sid:${id}`)}`;
}

export function deserializeSessionId(raw: string | undefined): string | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  return UUID_V4.test(id) && safeEqual(signature, sign(`sid:${id}`)) ? id : null;
}

/* ------------------------------------------------------------------ */
/* 프로필 쿠키 — AES-256-GCM 암호화                                      */
/* ------------------------------------------------------------------ */

/** 암호화 형식 버전 접두사. 형식을 바꾸면 올린다. */
const PROFILE_V1 = "v1";
const IV_BYTES = 12; // GCM 표준 nonce 길이
const TAG_BYTES = 16;

/**
 * 암호화 키를 SESSION_SECRET 에서 파생한다.
 *
 * SESSION_SECRET 을 그대로 키로 쓰지 않고 HKDF 로 분리한다 — 같은 비밀이 세션 id 서명에도
 * 쓰이므로, 두 용도가 같은 키를 공유하면 한쪽의 약점이 다른 쪽으로 번진다.
 */
let cachedKey: { secret: string; key: Buffer } | null = null;
function profileKey(): Buffer {
  const secret = sessionSecret();
  if (cachedKey?.secret === secret) return cachedKey.key;
  const key = Buffer.from(
    hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), "amuguna:profile:v1", 32),
  );
  cachedKey = { secret, key };
  return key;
}

export function serializeProfile(p: Profile): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", profileKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(p), "utf8"),
    cipher.final(),
  ]);
  // iv | ciphertext | authTag — 한 덩어리로 붙여 쿠키 하나에 담는다
  const packed = Buffer.concat([iv, ciphertext, cipher.getAuthTag()]);
  return `${PROFILE_V1}.${packed.toString("base64url")}`;
}

/** 복호화한 평문이 실제로 Profile 형태인지 확인한다 (키가 맞아도 형식은 검증한다) */
function toProfile(json: string): Profile | null {
  try {
    const obj = JSON.parse(json);
    if (
      typeof obj?.age !== "number" ||
      typeof obj?.occupation !== "string" ||
      typeof obj?.sidoCode !== "string" ||
      typeof obj?.sigunguCode !== "string"
    ) {
      return null;
    }
    const incomeDecile = typeof obj.incomeDecile === "number" ? obj.incomeDecile : null;
    const medianIncomePercent =
      typeof obj.medianIncomePercent === "number" ? obj.medianIncomePercent : null;
    return { ...obj, incomeDecile, medianIncomePercent } as Profile;
  } catch {
    return null;
  }
}

/**
 * 암호화 도입 이전에 발급된 서명 쿠키(`<base64url payload>.<hmac>`)를 읽는다.
 *
 * 이미 브라우저에 남아 있는 쿠키를 한순간에 무효화하면 사용자가 온보딩 6단계를 다시
 * 입력해야 한다 — 심사 구간에 그런 일이 생기면 곤란하다. 읽기만 허용하고,
 * `readProfile` 이 곧바로 암호화 형식으로 재발급한다.
 *
 * 재발급이 한 바퀴 돈 뒤(쿠키 수명 90일)에는 이 경로를 지워도 된다.
 */
function readLegacySignedProfile(raw: string): Profile | null {
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!safeEqual(sig, sign(payload))) return null;
  return toProfile(Buffer.from(payload, "base64url").toString("utf8"));
}

export function deserializeProfile(raw: string | undefined): Profile | null {
  if (!raw) return null;
  if (!raw.startsWith(`${PROFILE_V1}.`)) return readLegacySignedProfile(raw);

  try {
    const packed = Buffer.from(raw.slice(PROFILE_V1.length + 1), "base64url");
    if (packed.length <= IV_BYTES + TAG_BYTES) return null;
    const iv = packed.subarray(0, IV_BYTES);
    const tag = packed.subarray(packed.length - TAG_BYTES);
    const ciphertext = packed.subarray(IV_BYTES, packed.length - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", profileKey(), iv);
    decipher.setAuthTag(tag);
    // 변조되면 final() 이 던진다 — GCM 이 무결성까지 책임진다
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return toProfile(plaintext);
  } catch {
    return null;
  }
}

/** 이 쿠키가 구형(서명) 형식이라 재발급이 필요한가 */
export function isLegacyProfileCookie(raw: string | undefined): boolean {
  return Boolean(raw) && !raw!.startsWith(`${PROFILE_V1}.`);
}

/**
 * 쿠키 속성 (SPEC §8).
 *
 * - `httpOnly`: 스크립트가 읽지 못하게 한다. XSS 가 나더라도 프로필이 유출되지 않는다
 * - `sameSite: "lax"`: 크로스사이트 POST 에 쿠키가 실리지 않아 CSRF 의 1차 방어선이 된다.
 *   `strict` 로 올리지 않는 이유는 상세 페이지 URL 공유가 설계 전제이기 때문이다 —
 *   외부 링크로 들어온 첫 요청에도 프로필이 붙어야 자격 체크리스트를 그릴 수 있다
 * - `secure`: 프로덕션에서만. 로컬 http 개발을 막지 않기 위해서다
 */
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

/**
 * 구형(서명) 프로필 쿠키를 암호화 형식으로 조용히 교체한다.
 *
 * **라우트 핸들러에서만 호출한다.** 서버 컴포넌트의 렌더 중에는 쿠키 쓰기가 허용되지
 * 않아 예외가 난다. 교체 자체는 부가 작업이므로 실패해도 요청을 실패시키지 않는다 —
 * 다음 요청에 다시 시도하면 되고, 그동안에도 읽기는 정상 동작한다.
 */
export async function upgradeProfileCookie(): Promise<void> {
  try {
    const jar = await cookies();
    const raw = jar.get(PROFILE_COOKIE)?.value;
    if (!isLegacyProfileCookie(raw)) return;
    const profile = deserializeProfile(raw);
    if (profile) jar.set(PROFILE_COOKIE, serializeProfile(profile), COOKIE_OPTS);
  } catch {
    // 쓰기 불가 컨텍스트이거나 쿠키가 깨진 경우 — 다음 요청에 다시 시도한다
  }
}

export async function writeProfile(p: Profile): Promise<void> {
  const jar = await cookies();
  jar.set(PROFILE_COOKIE, serializeProfile(p), COOKIE_OPTS);
}

export async function clearProfile(): Promise<void> {
  const jar = await cookies();
  jar.delete(PROFILE_COOKIE);
}

/** 익명 세션 id — 요청 빈도 제한 키로만 쓴다 */
export async function readOrCreateSessionId(): Promise<string> {
  const jar = await cookies();
  const existing = deserializeSessionId(jar.get(SESSION_COOKIE)?.value);
  if (existing) return existing;
  const sid = randomUUID();
  jar.set(SESSION_COOKIE, serializeSessionId(sid), COOKIE_OPTS);
  return sid;
}

/** 쓰기 없이 읽기만 (읽기 전용 컨텍스트에서 안전) */
export async function readSessionId(): Promise<string | null> {
  const jar = await cookies();
  return deserializeSessionId(jar.get(SESSION_COOKIE)?.value);
}
