/** 데이터 출처 · 갱신 주기 (SPEC §9 화면 6, §3 데이터 소스). */
import type { Metadata } from "next";
import Link from "next/link";
import { getSql, isDbConfigured } from "@/lib/db";
import { demoFetchedAt, demoPrograms } from "@/lib/demo-store";
import { formatDateTime } from "@/lib/format";
import Icon from "@/components/visual/Icon";

export const metadata: Metadata = {
  title: "데이터 출처·갱신 주기",
  description:
    "아무거나가 수집하는 공공데이터 소스 목록과 수집 주기, 외부 데이터 사용 사실을 공개합니다.",
};

export const dynamic = "force-dynamic";

type SourceStatus = "scheduled" | "manual" | "planned";

const SOURCES: {
  key: string;
  tier: string;
  name: string;
  method: string;
  covers: string;
  url: string;
  status: SourceStatus;
  permission: string;
}[] = [
  {
    key: "social_security",
    tier: "T1",
    name: "공공데이터포털 — 한국사회보장정보원 사회보장급여·공공서비스",
    method: "REST API",
    covers: "중앙부처 복지서비스 목록·상세",
    url: "https://www.data.go.kr/data/15090532/openapi.do",
    status: "scheduled",
    permission: "코드상 정기 대상. 운영 키·데이터셋 활용승인·재이용 범위는 배포 전에 별도 확인 필요",
  },
  {
    key: "bizinfo",
    tier: "T1",
    name: "기업마당 (bizinfo.go.kr) 지원사업 정보",
    method: "REST API",
    covers: "소상공인·창업·중소기업 정책자금",
    url: "https://www.bizinfo.go.kr/",
    status: "scheduled",
    permission: "코드상 정기 대상. 운영 API 키·약관·재이용 범위는 배포 전에 별도 확인 필요",
  },
  {
    key: "finlife",
    tier: "T1",
    name: "금융감독원 금융상품통합비교공시",
    method: "REST API",
    covers: "예·적금, 대출, 연금 상품",
    url: "https://finlife.fss.or.kr/",
    status: "scheduled",
    permission: "코드상 정기 대상. 운영 발급 키의 상품·권역 범위와 이용조건은 배포 전에 실응답으로 확인 필요",
  },
  {
    key: "gov24",
    tier: "T1",
    name: "공공데이터포털 — 보조금24",
    method: "REST API",
    covers: "정부·지자체 수혜서비스",
    url: "https://www.data.go.kr/",
    status: "scheduled",
    permission: "코드상 정기 대상. 운영 키·데이터셋 활용승인·재이용 범위는 배포 전에 별도 확인 필요",
  },
  {
    key: "local_welfare",
    tier: "T1",
    name: "공공데이터포털 — 지자체 복지서비스",
    method: "REST API",
    covers: "지방자치단체 자체 복지사업",
    url: "https://www.data.go.kr/",
    status: "scheduled",
    permission: "코드상 정기 대상. 운영 키·데이터셋 활용승인·재이용 범위는 배포 전에 별도 확인 필요",
  },
  {
    key: "kstartup",
    tier: "T2",
    name: "K-Startup 창업지원포털",
    method: "REST API",
    covers: "창업지원 공고",
    url: "https://www.k-startup.go.kr/",
    status: "manual",
    permission: "수집기는 구현됨. 공식 API 이용승인과 실응답 대조 전에는 정기 배치 제외",
  },
  {
    key: "regional_portals",
    tier: "T2",
    name: "서울 열린데이터광장 / 경기데이터드림 등 광역 포털",
    method: "미연동",
    covers: "지방자치단체 자체 사업",
    url: "https://data.seoul.go.kr/",
    status: "planned",
    permission: "현재 수집하지 않음. 구현 전에 포털별 이용조건 확인 필요",
  },
  {
    key: "law",
    tier: "T2",
    name: "국가법령정보센터 Open API",
    method: "미연동",
    covers: "관련 법령·시행령 원문",
    url: "https://www.law.go.kr/",
    status: "planned",
    permission: "현재 수집하지 않음. Open API 이용승인·조건 확인 필요",
  },
  {
    key: "html_sources",
    tier: "T3",
    name: "소상공인시장진흥공단 · 주택도시기금 · 청약홈 등",
    method: "미연동",
    covers: "T1·T2 누락분 보완",
    url: "https://www.semas.or.kr/",
    status: "planned",
    permission: "현재 수집하지 않음. 사이트별 robots.txt·약관·재이용 범위 확인 필요",
  },
];

const STATUS_LABEL: Record<SourceStatus, string> = {
  scheduled: "정기 배치 대상",
  manual: "승인 확인 후 수동 연동",
  planned: "현재 미연동",
};

async function sourceStats(): Promise<Map<string, { count: number; fetchedAt: string | null }>> {
  const sql = getSql();
  if (!sql) return new Map();
  try {
    const rows = await sql<[{ source_key: string; count: string; fetched_at: string | null }]>`
      SELECT split_part(external_id, ':', 1) AS source_key,
             count(*) FILTER (WHERE status = 'active')::text AS count,
             max(fetched_at)::text AS fetched_at
        FROM programs
       GROUP BY 1
    `;
    return new Map(
      rows.map((row) => [
        row.source_key,
        { count: Number(row.count), fetchedAt: row.fetched_at },
      ]),
    );
  } catch (error) {
    console.error("[sources] 수집 상태 조회 실패", error);
    return new Map();
  }
}

export default async function SourcesPage() {
  const demo = !isDbConfigured();
  const programs = demo ? demoPrograms() : [];
  const stats = await sourceStats();

  return (
    <div className="mx-auto max-w-3xl px-5 py-12 sm:px-8">
      <h1 className="t-section text-ink">데이터 출처와 갱신 주기</h1>
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
            <li key={s.name} className="rounded-xl border border-line bg-bg p-5">
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
                <span className="rounded bg-bg-sunken px-2 py-0.5 text-sm text-ink-2">
                  {STATUS_LABEL[s.status]}
                </span>
              </div>
              <h3 className="mt-2 font-bold text-ink">{s.name}</h3>
              <p className="mt-1 text-ink-2">{s.covers}</p>
              {stats.has(s.key) && (
                <p className="mt-2 text-sm font-semibold text-ok">
                  DB 활성 {stats.get(s.key)?.count.toLocaleString("ko-KR")}건 · 최근 수집{" "}
                  {formatDateTime(stats.get(s.key)?.fetchedAt ?? null)}
                </p>
              )}
              <p className="mt-2 text-sm text-ink-3">이용 범위: {s.permission}</p>
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="mt-2 inline-flex items-start gap-1.5 break-all py-1 text-sm underline hover:text-brand"
              >
                {/* 새 창으로 열린다는 걸 아이콘으로 함께 알린다 (§8) */}
                <span aria-hidden="true" className="mt-0.5 shrink-0">
                  <Icon name="external" size="sm" />
                </span>
                <span>{s.url}</span>
                <span className="sr-only">(새 창으로 열림)</span>
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
          <li>현재 연동은 발급 키를 사용하는 공식 API 수집기입니다.</li>
          <li>미연동 T3 HTML 수집을 추가할 때는 robots.txt·약관을 확인하고 공개 공고문만 대상으로 제한합니다.</li>
          <li>외부 원문 링크는 http·https URL만 표시합니다.</li>
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

      {/*
        서체 출처. SIL OFL 조건 2 는 라이선스 전문을 함께 두면 충족되고 그건 이미
        /fonts/OFL.txt 로 배포하지만, 배포처가 출처 표기도 권장하므로 한 줄 남긴다.
      */}
      <p className="mt-10 text-sm text-ink-3">
        이 사이트는 이베이코리아에서 제공한 G마켓산스 폰트가 적용되어 있습니다. 라이선스
        전문은{" "}
        <a href="/fonts/OFL.txt" className="underline hover:text-brand">
          OFL.txt
        </a>
        에 함께 배포합니다.
      </p>

      <p className="mt-6">
        <Link href="/privacy" className="inline-block py-1 underline hover:text-brand">
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
