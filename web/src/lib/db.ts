/**
 * Supabase Postgres 접속 (서버 전용).
 *
 * DATABASE_URL 이 없으면 데모 모드로 동작한다 — 이 모듈은 null 을 돌려주고
 * 호출부(src/lib/matching.ts)가 번들 데이터셋 경로를 탄다.
 */
import postgres from "postgres";

export type Sql = ReturnType<typeof postgres>;

let client: Sql | null = null;

export function isDbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function getSql(): Sql | null {
  if (!isDbConfigured()) return null;
  if (!client) {
    client = postgres(process.env.DATABASE_URL as string, {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 10,
      // Supabase 는 TLS 필수. 풀러 인증서 체인 때문에 verify-full 은 쓰지 않는다.
      ssl: "require",
      prepare: false,
    });
  }
  return client;
}
