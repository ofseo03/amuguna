/** 데이터 출처 · 갱신 주기 (SPEC §9 화면 6, §3 데이터 소스). */
import type { Metadata } from "next";
import Link from "next/link";
import { isDbConfigured } from "@/lib/db";
import { demoFetchedAt, demoPrograms } from "@/lib/demo-store";
import { formatDateTime } from "@/lib/format";

export const metadata: Metadata = {
  title: "데이터 출처·갱신 주기",
  description:
    "아무거나가 수집하는 공공데이터 소스 목록과 수집 주기, 외부 데이터 사용 사실을 공개합니다.",
};

export const dynamic = "force-dynamic";

const SOURCES = [
  {
    tier: "T1",
    name: "공공데이터포털 — 한국사회보장정보원 사회보장급여·공공서비스",
    method: "REST API",
    covers: "보조금24 전체 복지·지원금 (전국 + 지자체)",
    url: "https://www.data.go.kr/",
  },
  {
    tier: "T1",
    name: "기업마당 (bizinfo.go.kr) 지원사업 정보",
    method: "REST API",
    covers: "소상공인·창업·중소기업 정책자금",
    url: "https://www.bizinfo.go.kr/",
  },
  {
    tier: "T1",
    name: "금융감독원 금융상품통합비교공시",
    method: "REST API",
    covers: "예·적금, 대출, 연금 상품",
    url: "https://finlife.fss.or.kr/",
  },
  {
    tier: "T2",
    name: "서울 열린데이터광장 / 경기데이터드림 등 광역 포털",
    method: "REST API",
    covers: "지방자치단체 자체 사업",
    url: "https://data.seoul.go.kr/",
  },
  {
    tier: "T2",
    name: "국가법령정보센터 Open API",
    method: "REST API",
    covers: "관련 법령·시행령 원문",
    url: "https://www.law.go.kr/",
  },
  {
    tier: "T3",
    name: "소상공인시장진흥공단 · 주택도시기금 · 청약홈 등",
    method: "HTML 수집 (API 미제공 게시판)",
    covers: "T1·T2 누락분 보완",
    url: "https://www.semas.or.kr/",
  },
];

export default function SourcesPage() {
  const demo = !isDbConfigured();
  const programs = demo ? demoPrograms() : [];

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-3xl font-bold text-ink">데이터 출처와 갱신 주기</h1>
      <p className="mt-3 text-ink-2">
        본 서비스는 정부·지방자치단체·공공기관이 공개한 데이터를 수집해
        제공합니다. 외부 데이터 사용 사실을 아래와 같이 공개합니다.
      </p>

      {demo && (
        <div className="mt-6 rounded-xl border-2 border-warn bg-warn-soft p-5">
          <p className="font-bold text-warn">현재 데모 모드로 동작 중입니다</p>
          <p className="mt-2 text-ink-2">
            데이터베이스가 연결되어 있지 않아, 아래 소스에서 수집한 실제 데이터
            대신 <strong>번들 예시 데이터 {programs.length}건</strong>으로
            동작하고 있습니다. 예시 데이터는 실제 제도를 참고해 구성했으나
            금액·기한은 시연용 값입니다. 매칭·스코어링·근접탈락 로직은 실제
            동작과 동일합니다.
          </p>
          <p className="mt-2 text-sm text-ink-3">
            예시 데이터 기준 시각 {formatDateTime(demoFetchedAt())}
          </p>
        </div>
      )}

      <section className="mt-10">
        <h2 className="text-xl font-bold text-ink">수집 소스 목록</h2>
        <ul className="mt-4 grid gap-3">
          {SOURCES.map((s) => (
            <li key={s.name} className="rounded-xl border border-line bg-white p-5">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded px-2 py-0.5 text-sm font-bold ${
                    s.tier === "T1"
                      ? "bg-brand text-white"
                      : s.tier === "T2"
                        ? "bg-brand-soft text-brand-dark"
                        : "bg-bg-sunken text-ink-2"
                  }`}
                >
                  {s.tier}
                </span>
                <span className="text-sm text-ink-3">{s.method}</span>
              </div>
              <h3 className="mt-2 font-bold text-ink">{s.name}</h3>
              <p className="mt-1 text-ink-2">{s.covers}</p>
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="mt-2 inline-block break-all text-sm underline hover:text-brand"
              >
                {s.url}
              </a>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm text-ink-3">
          T1 = 필수 · T2 = 권장 · T3 = 보완. 공식 Open API 가 있으면 API 를
          쓰고, 없을 때만 공개 공고문을 수집합니다.
        </p>
      </section>

      <section className="mt-10">
        <h2 className="text-xl font-bold text-ink">갱신 주기</h2>
        <ul className="mt-3 grid gap-2 text-ink-2">
          <Item label="정기 수집">
            매일 1회 심야 배치. 사용자 요청 시점에는 외부 API 를 호출하지 않고
            우리 데이터베이스만 조회합니다 — 응답이 빠르고 외부 장애의 영향을
            받지 않습니다.
          </Item>
          <Item label="증분 수집">
            소스가 수정일 조회를 지원하면 전일 이후 변경분만 가져옵니다.
            지원하지 않으면 본문 해시를 비교해 바뀐 건만 다시 처리합니다.
          </Item>
          <Item label="전량 대조">
            매주 일요일 1회. 원본에서 조용히 내려간 공고를 찾아 만료 처리합니다
            — 죽은 링크를 계속 추천하지 않기 위해서입니다.
          </Item>
          <Item label="수집 실패 시">
            직전 성공 스냅샷을 유지합니다. 빈 결과를 노출하지 않습니다.
          </Item>
        </ul>
      </section>

      <section className="mt-10">
        <h2 className="text-xl font-bold text-ink">수집 정책</h2>
        <ul className="mt-3 list-disc pl-6 text-ink-2">
          <li>robots.txt 를 준수하고 User-Agent 에 서비스명과 연락처를 명시합니다.</li>
          <li>도메인당 초당 1회, 동시 1커넥션으로 제한합니다.</li>
          <li>공개된 공고문만 수집하며 로그인이 필요한 페이지에 접근하지 않습니다.</li>
          <li>수집 대상 URL 은 화이트리스트로 고정합니다.</li>
        </ul>
      </section>

      <section className="mt-10">
        <h2 className="text-xl font-bold text-ink">자동 처리의 한계</h2>
        <p className="mt-3 text-ink-2">
          자격요건은 정규식으로 우선 추출하고, 추출되지 않은 항목만 언어모델로
          보완합니다. &ldquo;관내 6개월 이상 거주하며 무주택인 자&rdquo; 같은
          복합 조건은 정형 필드로 만들지 않고 상세 화면의{" "}
          <strong>추가 확인 필요 조건</strong>에 원문 그대로 표시합니다. 자동
          판정을 포기하는 대신 잘못된 탈락을 만들지 않기 위한 선택입니다.
        </p>
      </section>

      <p className="mt-10">
        <Link href="/privacy" className="underline hover:text-brand">
          ← 개인정보처리방침 보기
        </Link>
      </p>
    </div>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <li className="rounded-lg border border-line bg-bg-soft px-4 py-3">
      <strong className="text-ink">{label}</strong> — {children}
    </li>
  );
}
