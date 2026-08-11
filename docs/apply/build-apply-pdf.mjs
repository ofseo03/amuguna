// 공공데이터포털 오픈API 활용신청 첨부용 PDF 생성기.
//
//   node docs/apply/build-apply-pdf.mjs
//   <chromium> --headless --no-pdf-header-footer \
//     --print-to-pdf=docs/apply/amuguna-api-apply.pdf file://$PWD/docs/apply/apply.html
//
// 포털 첨부 규정상 실행·스크립트 파일(HTML 포함)은 업로드할 수 없으므로 산출물은 PDF 1개다.
// 한글 폰트는 저장소에 커밋하지 않고 npm 레지스트리에서 받아 PDF에 임베드한다.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const FONTS = resolve(HERE, ".fonts");

function ensureFonts() {
  if (existsSync(resolve(FONTS, "package/files/noto-sans-kr-korean-400-normal.woff2"))) return;
  mkdirSync(FONTS, { recursive: true });
  const pack = (pkg, into) => {
    const tgz = execFileSync("npm", ["pack", pkg, "--silent"], { cwd: FONTS, encoding: "utf8" })
      .trim()
      .split("\n")
      .pop();
    mkdirSync(resolve(FONTS, into), { recursive: true });
    execFileSync("tar", ["xzf", tgz, "-C", into], { cwd: FONTS });
  };
  pack("@fontsource/noto-sans-kr@5.3.0", ".");
  pack("@fontsource/noto-sans-mono@5.3.0", "mono");
}

ensureFonts();

const font = (p) => readFileSync(resolve(FONTS, p)).toString("base64");
const F = {
  krLatin400: font("package/files/noto-sans-kr-latin-400-normal.woff2"),
  krLatin700: font("package/files/noto-sans-kr-latin-700-normal.woff2"),
  kr400: font("package/files/noto-sans-kr-korean-400-normal.woff2"),
  kr700: font("package/files/noto-sans-kr-korean-700-normal.woff2"),
  mono400: font("mono/package/files/noto-sans-mono-latin-400-normal.woff2"),
};

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const src = (p) => readFileSync(resolve(REPO, p), "utf8").replace(/\s+$/, "");

function codeBlock(path, lang) {
  const text = src(path);
  const lines = text.split("\n");
  // 각 줄을 독립 행으로 렌더 — 긴 줄이 접혀도 행번호가 어긋나지 않는다
  const rows = lines
    .map((line, i) => `<div class="r"><i>${i + 1}</i><s>${esc(line) || "&nbsp;"}</s></div>`)
    .join("");
  return `<figure class="code">
  <figcaption><span class="path">${esc(path)}</span><span class="meta">${lines.length} lines · ${lang}</span></figcaption>
  <div class="codebody">${rows}</div>
</figure>`;
}

const sections = [];

// ── 표지 / 개요 ────────────────────────────────────────────────
sections.push(`
<section class="cover">
  <div class="eyebrow">공공데이터 오픈API 활용신청 첨부자료</div>
  <h1>amuguna<br><span class="sub">개인 프로필 기반 공공 금융정보 매칭 서비스</span></h1>
  <table class="facts">
    <tr><th>제출 목적</th><td>공공데이터포털(data.go.kr) 오픈API 활용신청 및 운영계정 전환 신청 증빙</td></tr>
    <tr><th>서비스명</th><td>amuguna (아무거나)</td></tr>
    <tr><th>출품 대회</th><td>2026 금융 AI Challenge — 금융보안원 주최 / 금융위원회 후원 / 데이콘 운영</td></tr>
    <tr><th>활용 유형</th><td>비영리 · 공모전 출품용 웹서비스 (개인/팀 개발)</td></tr>
    <tr><th>기술 스택</th><td>TypeScript (Node.js 배치 + Next.js 웹) / PostgreSQL + pgvector</td></tr>
    <tr><th>소스 저장소</th><td>github.com/ofseo03/amuguna</td></tr>
    <tr><th>담당자 연락처</th><td>ofseo03@gmail.com</td></tr>
    <tr><th>작성일</th><td>2026-08-11</td></tr>
  </table>
  <p class="note">본 문서는 신청 API를 <b>실제로 어떻게 호출하고 처리하는지</b>를 코드와 데이터 계약으로 제시하기 위해 작성되었습니다.
  수집기 소스코드 전문과 API 응답 처리 구조, 호출량 산정 근거를 포함합니다.</p>
</section>`);

// ── 1. 활용 목적 ────────────────────────────────────────────────
sections.push(`
<section>
  <h2>1. 활용 목적</h2>
  <p>정부·지자체·공공기관이 제공하는 지원금·정책자금·금융상품 정보는 부처별 사이트에 흩어져 있고,
  자격요건은 <i>"만 19~34세, 중위소득 150% 이하, 무주택, 해당 시군 6개월 이상 거주"</i> 같은 조합형입니다.
  그 결과 <b>받을 수 있는데 몰라서 신청하지 못하는 사각지대</b>가 발생합니다.</p>

  <p>본 서비스는 이용자가 입력한 <b>인적사항 5필드</b>(연령·성별·직업·거주지·소득분위)와
  <b>"원하는 것" 한 줄</b>을 받아, 두 축의 교집합으로 정보를 좁힙니다.</p>

  <table class="grid">
    <tr><th>축</th><th>질문</th><th>입력</th><th>판정 방식</th></tr>
    <tr><td><b>자격</b></td><td>내가 대상인가?</td><td>인적사항 5필드</td><td>정형 조건 대조 (SQL)</td></tr>
    <tr><td><b>의도</b></td><td>내가 찾는 것인가?</td><td>원하는 것 한 줄</td><td>의미 유사도 (벡터 검색)</td></tr>
  </table>

  <p>자격만 맞추면 수백 건의 무관한 정보가 쏟아지고, 의도만 맞추면 대상이 아닌 것을 권하게 됩니다.
  두 축이 서로 다른 것을 측정하기 때문에 <b>교집합이 곧 정보</b>가 됩니다.</p>

  <div class="callout">
    <b>공공데이터 활용의 핵심</b><br>
    신청 API는 이 서비스의 <b>유일한 정보 원천</b>입니다. 임의로 생성하거나 추정한 정보는 노출하지 않으며,
    모든 결과 카드에 <b>원문 출처 URL과 수집 시각</b>을 함께 표시하여 이용자가 원본을 직접 확인할 수 있게 합니다.
  </div>
</section>`);

// ── 2. 신청 API 목록 ───────────────────────────────────────────
sections.push(`
<section>
  <h2>2. 활용신청 대상 오픈API</h2>
  <p>공공데이터포털 인증키 1개로 아래 데이터셋을 활용합니다.</p>

  <h3>2.1 지원금·복지 (자격요건 원천)</h3>
  <table class="grid api">
    <tr><th>데이터셋 ID</th><th>명칭</th><th>활용 내용</th></tr>
    <tr><td>15113968</td><td>행정안전부_대한민국 공공서비스(혜택) 정보</td><td>중앙부처·지자체·공공기관·교육청 혜택 전체의 목록과 상세를 수집해 매칭 대상 모집단을 구성</td></tr>
    <tr><td>15090532</td><td>한국사회보장정보원_중앙부처복지서비스</td><td>상세조회의 지원대상·선정기준·신청방법 텍스트에서 자격요건을 추출</td></tr>
    <tr><td>15108347</td><td>한국사회보장정보원_지자체복지서비스</td><td>지자체 단위 복지서비스. 거주지 기준 필터링의 원천</td></tr>
  </table>

  <h3>2.2 서민·정책금융 상품 (대회 주제 직결)</h3>
  <table class="grid api">
    <tr><th>데이터셋 ID</th><th>명칭</th><th>활용 내용</th></tr>
    <tr><td>15094787</td><td>금융위원회_서민금융상품기본정보</td><td>서민금융 대출·자산형성·사회적금융 상품의 지원대상·금리·한도·상환방식을 상품 카드로 제공</td></tr>
    <tr><td>15106208</td><td>서민금융진흥원_대출상품한눈에 정보 서비스</td><td>자금용도·지원대상 기준 상품 매칭</td></tr>
    <tr><td>15119396</td><td>한국주택금융공사_전세자금보증상품 추천서비스</td><td>전세보증금 관련 이용자에게 보증상품·지역별 최대임차보증금액 안내</td></tr>
    <tr><td>15082039</td><td>한국주택금융공사_u-보금자리론대출정보</td><td>만기별 금리 정보</td></tr>
    <tr><td>15074508</td><td>서민금융진흥원_서민대출상품 취급기관 정보</td><td>상품에서 실제 신청 창구로 연결</td></tr>
    <tr><td>15037733</td><td>서민금융진흥원_서민금융통합지원센터 현황</td><td>디지털 취약계층 이용자에게 가까운 오프라인 창구를 함께 안내</td></tr>
  </table>

  <h3>2.3 확장</h3>
  <table class="grid api">
    <tr><th>데이터셋 ID</th><th>명칭</th><th>활용 내용</th></tr>
    <tr><td>15143273</td><td>한국고용정보원_온통청년_청년정책API</td><td>청년 대상 정책 보강</td></tr>
    <tr><td>15125364</td><td>창업진흥원_K-Startup 조회서비스</td><td>창업·소상공인 지원사업 보강</td></tr>
    <tr><td>15098547</td><td>한국부동산원_청약홈 분양정보 조회 서비스</td><td>주거 관련 공고 보강</td></tr>
    <tr><td>15000115</td><td>법제처 국가법령정보 공유서비스</td><td>제도의 근거 법령 원문 링크</td></tr>
  </table>
</section>`);

// ── 3. 시스템 구성 ─────────────────────────────────────────────
sections.push(`
<section>
  <h2>3. 시스템 구성 및 데이터 흐름</h2>

  <pre class="diagram">[배치 · 1일 1회 심야]

  공공데이터포털 오픈API 호출
        │
        ▼
  raw_documents  (응답 원문 보관, 덮어쓰지 않음 → 버전 이력)
        │
    ┌───┴──────────────┬───────────────────┐
    ▼                  ▼                   ▼
 ① 자격요건 파싱     ② 임베딩            ③ 요약·절차 생성
   정규식 → LLM 보완   본문 청크 → 벡터     신규·수정 건만 1회
    ▼                  ▼                   ▼
 eligibility_rules  program_embeddings  programs.summary
                     (pgvector)          programs.apply_steps
    └──────────────────┴───────────────────┘
                 ▼
           PostgreSQL (단일 DB)

[이용자 요청 · 외부 API 호출 없음]

  인적사항 5필드 ──▶ (A) SQL 자격 필터    → 집합 A
  원하는 것 한 줄 ─▶ (B) 임베딩 top-k     → 집합 B
                 ▼
              A ∩ B  →  스코어링 정렬  →  결과 카드
                          (원문 출처 URL + 수집 시각 표시)</pre>

  <div class="callout">
    <b>이용자 요청 시점에는 공공API를 호출하지 않습니다.</b><br>
    모든 조회는 사전 수집된 데이터베이스만 대상으로 합니다. 이용자 트래픽이 그대로 API 호출량으로
    전가되지 않으므로 <b>포털 서비스에 부하를 주지 않으며</b>, 동시에 외부 장애로부터 서비스가 격리됩니다.
  </div>

  <h3>3.1 증분 수집 — 호출량 절감 설계</h3>
  <p>소스가 수정일 파라미터를 지원하면 전일 이후 변경분만 조회합니다.
  지원하지 않으면 <code>content_hash</code> 비교로 변경분만 재처리합니다.</p>
  <table class="grid">
    <tr><th>상황</th><th>판정</th><th>처리</th></tr>
    <tr><td>external_id 없음</td><td>신규</td><td>원문 저장 → 파싱 → 임베딩 → 등록</td></tr>
    <tr><td>있음 + 해시 동일</td><td>무변경</td><td>수집시각만 갱신. <b>추가 처리 없음</b></td></tr>
    <tr><td>있음 + 해시 상이</td><td>수정</td><td>원문 이력 추가 → 재파싱 → 재임베딩 → 갱신</td></tr>
    <tr><td>전량 대조에서 누락</td><td>종료</td><td>expired 처리 (행 삭제 없음)</td></tr>
  </table>
  <p><code>content_hash</code>는 응답 전체가 아니라 <b>비교 대상 필드만</b>(제목·본문·기간·금액)으로 계산합니다.
  조회수나 응답 생성 시각처럼 매 호출 바뀌는 휘발성 필드를 해시에 포함하면 전 건이 매일 "수정"으로
  판정되어 증분 수집의 이점이 사라지기 때문입니다.</p>

  <h3>3.2 호출량 산정 (운영계정 전환 사유)</h3>
  <table class="grid">
    <tr><th>구분</th><th>산정</th></tr>
    <tr><td>수집 주기</td><td>1일 1회 (심야 배치, GitHub Actions cron)</td></tr>
    <tr><td>목록 조회</td><td>1회 100건 · 페이지네이션 — 소스당 일 5~50회</td></tr>
    <tr><td>상세 조회</td><td>신규·수정 건에 한해 건당 1회</td></tr>
    <tr><td>주 1회 전량 대조</td><td>ID 목록만 조회 (상세 호출 없음)</td></tr>
    <tr><td>요청 간 간격</td><td>동일 도메인 1초 1요청, 동시 연결 1개</td></tr>
    <tr><td>재시도</td><td>408/429/5xx에 한해 최대 2회, 지수 백오프 (250ms → 500ms)</td></tr>
  </table>
  <p><b>중앙부처복지서비스(15090532) 운영계정 전환을 요청드리는 사유:</b>
  개발계정 한도 100회/일에서 상세조회를 건당 1회 사용하면 <b>하루 100건이 상한</b>이 되어,
  초기 전량 적재에만 수십 일이 소요됩니다. 대회 심사 구간(2026-09-07 ~ 09-11)에
  서비스가 정상 동작하려면 초기 적재가 그 전에 완료되어야 합니다.</p>
</section>`);

// ── 4. 수집기 코드 ─────────────────────────────────────────────
sections.push(`
<section>
  <h2>4. 수집기 소스코드</h2>
  <p>공공데이터포털 API를 직접 호출하는 코드 전문입니다. 언어는 TypeScript(Node.js)입니다.</p>

  <h3>4.1 공통 수집기 — 호출·재시도·응답 검증</h3>
  <p>모든 수집기가 상속하는 기반 클래스입니다. 인증키 주입, 타임아웃, 재시도 정책,
  응답 봉투(<code>resultCode</code>) 검증, 페이지네이션 종료 조건을 담당합니다.
  User-Agent에 서비스명과 연락처를 명시하여 포털 측에서 호출 주체를 식별할 수 있게 했습니다.</p>
  ${codeBlock("web/ingest/collectors/base.ts", "TypeScript")}

  <h3>4.2 한국사회보장정보원 복지서비스 수집기</h3>
  <p>목록조회(<code>NationalWelfarelistV001</code>)를 호출하고, 응답 항목을 서비스 내부 모델로 변환합니다.
  <code>srchModDt</code>(수정일) 파라미터로 증분 수집하며, 응답 필드명이 케이스별로 다를 수 있어
  후보 키를 순서대로 시도합니다(<code>firstOf</code>).</p>
  ${codeBlock("web/ingest/collectors/social-security.ts", "TypeScript")}

  <h3>4.3 지원사업 공고 수집기</h3>
  ${codeBlock("web/ingest/collectors/bizinfo.ts", "TypeScript")}

  <h3>4.4 금융상품 공시 수집기</h3>
  <p>기본정보(<code>baseList</code>)와 옵션정보(<code>optionList</code>)를 상품코드로 결합하는 구조를 처리합니다.</p>
  ${codeBlock("web/ingest/collectors/finlife.ts", "TypeScript")}

  <h3>4.5 수집기 등록</h3>
  ${codeBlock("web/ingest/collectors/index.ts", "TypeScript")}

  <h3>4.6 설정 — 인증키 주입</h3>
  <p>인증키는 <b>소스코드에 포함하지 않고</b> 환경변수(<code>DATA_GO_KR_API_KEY</code>)로만 주입합니다.
  저장소에는 키가 커밋되지 않으며, 실행 환경(GitHub Actions Secrets)에서 공급합니다.</p>
  ${codeBlock("web/ingest/config.ts", "TypeScript")}
</section>`);

// ── 5. JSON ────────────────────────────────────────────────────
sections.push(`
<section>
  <h2>5. API 응답 처리 계약 (JSON)</h2>
  <p>키 발급 전 개발·테스트를 위해 <b>API 응답 봉투 구조를 그대로 모사한 픽스처</b>를 사용했습니다.
  실제 API를 호출하지 않고도 파싱·저장 로직을 검증하기 위한 것으로,
  키 발급 후에는 실제 응답으로 필드 명세를 확정합니다.</p>

  <h3>5.1 복지서비스 응답 구조</h3>
  ${codeBlock("ingest/fixtures/social_security.json", "JSON")}

  <h3>5.2 지원사업 공고 응답 구조</h3>
  ${codeBlock("ingest/fixtures/bizinfo.json", "JSON")}

  <h3>5.3 금융상품 공시 응답 구조</h3>
  ${codeBlock("ingest/fixtures/finlife.json", "JSON")}
</section>`);

sections.push(`
<section>
  <h2>6. 자격 판정 기준 데이터 (JSON)</h2>
  <p>API 응답의 서술형 자격요건을 정형 조건으로 변환할 때 사용하는 기준 데이터입니다.
  행정표준코드(법정동코드)와 통계청 자료를 근거로 구성했습니다.</p>

  <h3>6.1 지역 코드</h3>
  ${codeBlock("shared/regions.json", "JSON")}

  <h3>6.2 직업 분류</h3>
  ${codeBlock("shared/occupations.json", "JSON")}

  <h3>6.3 소득분위 기준</h3>
  ${codeBlock("shared/income_deciles.json", "JSON")}

  <h3>6.4 중위소득 비율 환산표</h3>
  ${codeBlock("shared/midincome_to_decile.json", "JSON")}
</section>`);

// ── 7. 준수사항 ────────────────────────────────────────────────
sections.push(`
<section>
  <h2>7. 이용 준수사항</h2>
  <table class="grid">
    <tr><th>항목</th><th>준수 내용</th></tr>
    <tr><td>출처 표시</td><td>모든 결과 화면에 데이터 출처 기관명, 원문 URL, 수집 시각을 표시합니다. 별도의 출처 안내 페이지를 운영합니다.</td></tr>
    <tr><td>호출 부하</td><td>1일 1회 심야 배치. 이용자 요청 시점에는 API를 호출하지 않습니다. 도메인당 1초 1요청, 동시 연결 1개.</td></tr>
    <tr><td>재시도</td><td>408/429/5xx에 한해 최대 2회, 지수 백오프. 4xx는 즉시 중단하여 무효 요청을 반복하지 않습니다.</td></tr>
    <tr><td>인증키 관리</td><td>소스코드·저장소에 키를 포함하지 않습니다. 환경변수로만 주입하며 공개 저장소에 커밋되지 않습니다.</td></tr>
    <tr><td>데이터 가공</td><td>원문을 임의로 수정하지 않습니다. 요약을 생성하는 경우에도 원문 링크를 항상 병기하여 이용자가 원본을 확인할 수 있게 합니다.</td></tr>
    <tr><td>개인정보</td><td>회원가입·로그인이 없습니다. 입력받은 인적사항은 매칭 연산에만 사용하며 90일 후 자동 삭제합니다. 공공API로 개인정보를 전송하지 않습니다.</td></tr>
    <tr><td>영리성</td><td>비영리. 공모전 출품 및 공익 목적이며 광고·유료화 계획이 없습니다.</td></tr>
    <tr><td>장애 대응</td><td>수집 실패 시 직전 성공 데이터를 유지합니다. 빈 결과를 노출하지 않습니다.</td></tr>
  </table>

  <p class="foot">본 문서에 포함된 소스코드와 데이터는 github.com/ofseo03/amuguna 에서 확인하실 수 있습니다.<br>
  문의: ofseo03@gmail.com</p>
</section>`);

const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<title>amuguna — 공공데이터 오픈API 활용신청 첨부자료</title>
<style>
@font-face{font-family:'NSK';src:url(data:font/woff2;base64,${F.krLatin400}) format('woff2');font-weight:400;unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215;}
@font-face{font-family:'NSK';src:url(data:font/woff2;base64,${F.kr400}) format('woff2');font-weight:400;}
@font-face{font-family:'NSK';src:url(data:font/woff2;base64,${F.krLatin700}) format('woff2');font-weight:700;unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215;}
@font-face{font-family:'NSK';src:url(data:font/woff2;base64,${F.kr700}) format('woff2');font-weight:700;}
@font-face{font-family:'NSM';src:url(data:font/woff2;base64,${F.mono400}) format('woff2');font-weight:400;}

@page{size:A4;margin:16mm 14mm 18mm;}
*{box-sizing:border-box;}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact;}
body{font-family:'NSK',sans-serif;font-size:9.6pt;line-height:1.65;color:#1a1d21;margin:0;word-break:keep-all;}

h1{font-size:26pt;line-height:1.25;margin:0 0 6mm;font-weight:700;letter-spacing:-.02em;}
h1 .sub{display:block;font-size:12pt;font-weight:400;color:#4a5158;margin-top:3mm;letter-spacing:0;}
h2{font-size:14pt;font-weight:700;margin:0 0 5mm;padding-bottom:2.5mm;border-bottom:2px solid #1a1d21;letter-spacing:-.01em;}
h3{font-size:10.8pt;font-weight:700;margin:7mm 0 3mm;color:#15306b;}
p{margin:0 0 3.5mm;}
b{font-weight:700;}
i{font-style:normal;color:#4a5158;}
code{font-family:'NSM','NSK',monospace;font-size:8.6pt;background:#eef0f3;padding:.5mm 1.2mm;border-radius:2px;}

section{page-break-before:always;}
section.cover{page-break-before:auto;}

.eyebrow{font-size:9pt;font-weight:700;color:#15306b;letter-spacing:.08em;margin-bottom:4mm;}
.cover{padding-top:14mm;}
.cover .facts{margin-top:10mm;}
.note{margin-top:9mm;padding:4mm 5mm;background:#f5f6f8;border-left:3px solid #15306b;font-size:9pt;color:#31363c;}

table{width:100%;border-collapse:collapse;margin:0 0 5mm;font-size:9pt;}
.facts th{width:26%;text-align:left;vertical-align:top;padding:2.6mm 3mm;background:#f5f6f8;border:1px solid #d8dce1;font-weight:700;}
.facts td{padding:2.6mm 3mm;border:1px solid #d8dce1;}
.grid th{background:#eaedf1;border:1px solid #cdd3da;padding:2.4mm 2.8mm;text-align:left;font-weight:700;font-size:8.8pt;}
.grid td{border:1px solid #cdd3da;padding:2.4mm 2.8mm;vertical-align:top;}
.grid tr{page-break-inside:avoid;}
.api td:first-child{font-family:'NSM',monospace;white-space:nowrap;width:16mm;font-size:8.4pt;}
.api td:nth-child(2){width:34%;font-weight:700;}

.callout{margin:5mm 0;padding:4mm 5mm;background:#eef3fb;border:1px solid #c3d3ec;border-radius:3px;font-size:9pt;page-break-inside:avoid;}

.diagram{font-family:'NSM','NSK',monospace;font-size:8pt;line-height:1.5;background:#f5f6f8;border:1px solid #d8dce1;border-radius:3px;padding:4mm;white-space:pre;overflow:hidden;margin:0 0 5mm;page-break-inside:avoid;}

figure.code{margin:0 0 6mm;border:1px solid #cdd3da;border-radius:3px;overflow:hidden;}
figcaption{display:flex;justify-content:space-between;gap:4mm;background:#1a1d21;color:#fff;padding:2mm 3mm;font-size:8pt;}
figcaption .path{font-family:'NSM',monospace;font-weight:700;}
figcaption .meta{color:#9aa3ad;white-space:nowrap;}
.codebody{background:#fbfcfd;font-family:'NSM','NSK',monospace;font-size:7.4pt;line-height:1.5;padding:2mm 0;}
.codebody .r{display:flex;align-items:flex-start;}
.codebody .r i{flex:0 0 9mm;text-align:right;padding-right:2.4mm;margin-right:2.4mm;color:#98a2ad;font-style:normal;border-right:1px solid #e4e8ec;user-select:none;}
.codebody .r s{flex:1;text-decoration:none;padding-right:3mm;white-space:pre-wrap;overflow-wrap:anywhere;}

.foot{margin-top:9mm;padding-top:4mm;border-top:1px solid #d8dce1;font-size:8.6pt;color:#5a616a;}
</style></head>
<body>
${sections.join("\n")}
</body></html>`;

writeFileSync(resolve(HERE, "apply.html"), html);
console.log("wrote", resolve(HERE, "apply.html"), `(${html.length} bytes)`);
