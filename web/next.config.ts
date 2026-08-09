import type { NextConfig } from "next";

/**
 * 보안 헤더 (SPEC §8 보안).
 *
 * CSP 주의점: Next.js 는 하이드레이션 부트스트랩에 인라인 <script> 를 쓰므로
 * script-src 에 'unsafe-inline' 이 필요하다. nonce 방식으로 없앨 수 있으나
 * 모든 응답을 동적 렌더로 만들어야 해서 (§8 성능 3초 목표와 정적 최적화를 잃는다)
 * MVP 에서는 인라인을 허용하되 object-src/frame-ancestors/base-uri 로 실제 공격면을 막는다.
 * Tailwind 는 인라인 style 을 쓰므로 style-src 에도 'unsafe-inline' 이 필요하다.
 */
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // 외부 API 는 서버에서만 호출한다 — 브라우저에서 나가는 요청은 자기 자신뿐이다
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  // HTTPS 강제 (§8)
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // 개인화 응답이 CDN 이나 브라우저에 캐시되지 않게 한다
      {
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, max-age=0" },
          ...securityHeaders,
        ],
      },
    ];
  },
};

export default nextConfig;
