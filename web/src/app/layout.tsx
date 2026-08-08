import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

export const metadata: Metadata = {
  title: {
    default: "아무거나 — 내게 맞는 공공 금융정보 찾기",
    template: "%s · 아무거나",
  },
  description:
    "나이·지역·소득만 입력하면 받을 수 있는 지원금·대출·금융상품을 1분 만에 찾아드립니다. 회원가입 없이 익명으로 이용하세요.",
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // 확대 제한을 걸지 않는다 (§8 접근성)
  maximumScale: 5,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body className="flex min-h-screen flex-col bg-bg">
        <a href="#main" className="skip-link">
          본문 바로가기
        </a>
        <SiteHeader />
        <main id="main" className="flex-1">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
