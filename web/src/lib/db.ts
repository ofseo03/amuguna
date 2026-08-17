/**
 * Supabase Postgres 접속 (서버 전용).
 *
 * DATABASE_URL 이 없으면 데모 모드로 동작한다 — 이 모듈은 null 을 돌려주고
 * 호출부(src/lib/matching.ts)가 번들 데이터셋 경로를 탄다.
 */
import { readFileSync } from "node:fs";
import postgres from "postgres";

export type Sql = ReturnType<typeof postgres>;

let client: Sql | null = null;

export function isDbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * CA 체인 + 호스트명 검증. Supabase 풀러 인증서가 시스템 CA 로 검증되지 않으면
 * `PGSSLROOTCERT` 에 CA 번들 경로를 주어 우회한다 — libpq 와 같은 변수명이라
 * TypeScript 배치(web/ingest/db.ts)와 한 값으로 맞출 수 있다. 없으면 시스템 CA 로 검증한다.
 */
function dsnSslMode(dsn: string): string | null {
  try {
    return new URL(dsn).searchParams.get("sslmode");
  } catch {
    const match = /(?:^|\s)sslmode\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/iu.exec(dsn);
    return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
  }
}

function isLocalDsn(dsn: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(dsn).hostname);
  } catch {
    const match = /(?:^|\s)host\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/iu.exec(dsn);
    const host = match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
    return ["localhost", "127.0.0.1", "::1"].includes(host) || host.startsWith("/");
  }
}

export function sslOption(dsn: string, env: NodeJS.ProcessEnv = process.env) {
  if (dsnSslMode(dsn) !== null || isLocalDsn(dsn)) return undefined;
  const caPath = env.PGSSLROOTCERT;
  if (!caPath) return "verify-full" as const;
  return { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true };
}

export function getSql(): Sql | null {
  if (!isDbConfigured()) return null;
  if (!client) {
    const dsn = process.env.DATABASE_URL as string;
    const ssl = sslOption(dsn);
    client = postgres(dsn, {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 10,
      ...(ssl === undefined ? {} : { ssl }),
      prepare: false,
    });
  }
  return client;
}
