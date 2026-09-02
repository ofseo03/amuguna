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
 *
 * **DSN 의 `sslmode` 는 postgres.js 에 그대로 넘기지 않는다.** postgres.js 는
 * `sslmode=require|prefer|allow` 를 `rejectUnauthorized: false` 로 해석한다 — 암호화는
 * 하되 상대가 누구인지 확인하지 않는다는 뜻이다. Supabase 대시보드가 주는 연결 문자열에
 * `?sslmode=require` 가 붙어 있으므로, 그대로 넘기면 이 함수가 지키려는 바로 그 배포에서
 * CA 검증이 통째로 빠진다. 그래서 `disable` 만 명시적 해제로 존중하고, 나머지 모드는
 * 전부 "검증하는 TLS" 로 승격한다.
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
  const mode = dsnSslMode(dsn)?.trim().toLowerCase() ?? null;
  // 명시적 해제만 존중한다. postgres.js 도 'disable'/'false' 를 ssl:false 로 본다
  if (mode === "disable" || mode === "false") return false as const;
  // 로컬·유닉스 소켓은 TLS 가 없다. 단, sslmode 를 명시했다면 그 뜻대로 검증한다
  if (mode === null && isLocalDsn(dsn)) return undefined;
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
