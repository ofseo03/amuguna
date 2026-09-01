/**
 * Supabase Postgres 접속 (서버 전용).
 *
 * DATABASE_URL 이 없으면 데모 모드로 동작한다 — 이 모듈은 null 을 돌려주고
 * 호출부(src/lib/matching.ts)가 번들 데이터셋 경로를 탄다.
 */
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { SUPABASE_ROOT_CA_2021 } from "@/lib/supabase-ca";

export type Sql = ReturnType<typeof postgres>;

let client: Sql | null = null;

export function isDbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * CA 체인 + 호스트명 검증. Supabase 풀러 인증서가 시스템 CA 로 검증되지 않으면
 * `PGSSLROOTCERT`의 CA 번들을 우선 사용한다. Vercel처럼 파일 경로를 제공하지 않는
 * 런타임에서는 번들한 Supabase 공식 Root 2021 CA를 사용한다.
 */
function dsnSslMode(dsn: string): string | null {
  try {
    return new URL(dsn).searchParams.get("sslmode");
  } catch {
    const match = /(?:^|\s)sslmode\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/iu.exec(dsn);
    return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
  }
}

function dsnHost(dsn: string): string {
  try {
    return new URL(dsn).hostname;
  } catch {
    const match = /(?:^|\s)host\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/iu.exec(dsn);
    return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
  }
}

function isLocalDsn(dsn: string): boolean {
  const host = dsnHost(dsn);
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) || host.startsWith("/");
}

function isSupabaseDsn(dsn: string): boolean {
  const host = dsnHost(dsn).toLowerCase();
  return host.endsWith(".supabase.com") || host.endsWith(".supabase.co");
}

export function sslOption(dsn: string, env: NodeJS.ProcessEnv = process.env) {
  if (dsnSslMode(dsn) !== null || isLocalDsn(dsn)) return undefined;
  const caPath = env.PGSSLROOTCERT;
  if (caPath) return { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true };
  if (isSupabaseDsn(dsn)) {
    return { ca: SUPABASE_ROOT_CA_2021, rejectUnauthorized: true };
  }
  return "verify-full" as const;
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
