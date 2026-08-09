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
 * TLS 설정.
 *
 * `ssl: "require"` 는 연결을 암호화하지만 **서버 인증서를 검증하지 않는다**
 * (postgres 라이브러리에서 rejectUnauthorized: false 로 매핑된다). 경로상
 * 공격자가 DNS·라우팅을 잡으면 연결을 중계해 프로필·이메일 질의를 읽거나
 * 바꿀 수 있고, 이건 애플리케이션 role 의 작업이라 RLS 로 막히지 않는다.
 *
 * 그래서 기본값을 **검증 켜짐**으로 둔다:
 *   - `DATABASE_CA_CERT` (PEM 본문) 또는 `DATABASE_CA_CERT_PATH` 가 있으면 그 CA 로 검증
 *   - 없으면 Node 기본 신뢰 저장소로 검증
 * 풀러 인증서 체인 문제로 잠깐 꺼야 하면 `DATABASE_SSL_INSECURE=1` 로 명시해야 하며,
 * 그때는 서버 로그에 경고를 남긴다 — 조용히 검증 없이 도는 상태를 만들지 않는다.
 */
function sslOption(): "require" | { rejectUnauthorized: true; ca?: string } {
  if (process.env.DATABASE_SSL_INSECURE === "1") {
    console.warn(
      "[db] DATABASE_SSL_INSECURE=1 — Postgres 서버 인증서를 검증하지 않습니다. " +
        "중간자 공격에 노출되므로 임시로만 사용하세요.",
    );
    return "require";
  }
  const inline = process.env.DATABASE_CA_CERT;
  const path = process.env.DATABASE_CA_CERT_PATH;
  const ca = inline || (path ? readFileSync(path, "utf8") : undefined);
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}

export function getSql(): Sql | null {
  if (!isDbConfigured()) return null;
  if (!client) {
    client = postgres(process.env.DATABASE_URL as string, {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 10,
      ssl: sslOption(),
      prepare: false,
    });
  }
  return client;
}
