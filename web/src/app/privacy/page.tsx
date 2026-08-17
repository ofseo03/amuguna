/** 개인정보처리방침 (SPEC §9 화면 6, §8 개인정보). */
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "개인정보처리방침",
  description:
    "아무거나의 개인정보 수집 항목과 보유 기간, 자유입력 처리 방침을 안내합니다.",
};

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-3xl font-bold text-ink">개인정보처리방침</h1>
      <p className="mt-3 text-ink-2">
        아무거나(이하 &ldquo;서비스&rdquo;)는 개인정보 수집을 최소화하는 것을
        설계 원칙으로 삼습니다. 회원가입이 없고, 이름·전화번호·주민등록번호를
        수집하지 않습니다. 입력하신 인적사항은 <strong>브라우저 쿠키에만</strong>{" "}
        담기며 데이터베이스에 저장하지 않습니다. 다만 &ldquo;원하는 것&rdquo;
        입력 문장은 의미 검색을 위해 외부 임베딩 서비스로 전송됩니다 — 자세한
        내용은 아래 3항을 확인해 주세요.
      </p>
      <p className="mt-2 text-sm text-ink-3">최종 개정일: 2026년 8월 17일</p>

      <Section title="1. 수집하는 정보">
        <div className="mb-4 rounded-xl border-2 border-brand bg-brand-soft p-5">
          <p className="font-bold text-ink">
            서비스 데이터베이스에 저장되는 개인정보는 없습니다.
          </p>
          <p className="mt-2">
            데이터베이스에는 공공 API 에서 수집한 지원사업 정보만 보관합니다.
            입력하신 인적사항은 서명한 쿠키에 담겨 브라우저에만 남고, 검색은 그
            쿠키를 읽어 처리합니다.
          </p>
        </div>
        <Table
          head={["구분", "항목", "저장 위치", "보유 기간"]}
          rows={[
            [
              "인적사항 (익명)",
              "나이(만), 성별, 직업 대분류, 거주 시·군·구, 소득분위, 계산된 기준중위소득 비율",
              "브라우저 쿠키",
              "90일 (쿠키 만료). 더 일찍 지우시려면 브라우저에서 쿠키 삭제",
            ],
            [
              "익명 세션 식별자",
              "임의 생성 UUID (쿠키)",
              "브라우저 쿠키",
              "90일 (쿠키 만료)",
            ],
            [
              "세션 식별자 · IP 주소",
              "요청 빈도 제한 계수",
              "서버 메모리 (디스크·DB 기록 없음)",
              "1분 단위 집계. 서버 재시작 시 소멸",
            ],
          ]}
        />
        <p className="mt-4">
          거주지역은 <strong>시·군·구 단위까지만</strong> 받습니다. 상세 주소,
          건물명, 동·호수는 묻지 않습니다.
        </p>
        <p className="mt-3">
          요청 빈도 제한은 한 사람이 짧은 시간에 과도하게 요청해 서비스가
          멈추는 것을 막기 위한 것입니다. 세션 식별자와 IP 주소를 메모리에서만
          세고, 파일이나 데이터베이스에 기록하지 않습니다.
        </p>
      </Section>

      <Section title="2. 수집하지 않는 정보">
        <ul className="grid gap-2">
          {[
            "이름 · 생년월일 · 주민등록번호 · 외국인등록번호",
            "전화번호 · 상세 주소",
            "계좌번호 · 카드번호 등 금융거래정보",
            "실제 월 소득 금액과 가구원 수 (브라우저에서 비율만 계산하고 전송·저장하지 않음)",
          ].map((t) => (
            <li key={t} className="rounded-lg border border-line bg-bg-soft px-4 py-2">
              ✕ {t}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="3. 자유입력(“원하는 것”)의 처리">
        <div className="rounded-xl border-2 border-brand bg-brand-soft p-5">
          <p className="font-bold text-ink">
            입력하신 문장은 서버에 저장하지 않습니다.
          </p>
          <p className="mt-2">
            검색 요청을 처리하는 그 순간에만 사용하며, 데이터베이스에 기록하거나
            로그로 남기지 않습니다. 결과 화면을 새로고침해도 같은 결과를 보실 수
            있도록 <strong>브라우저 탭 메모리(sessionStorage)</strong> 에만
            잠시 두며, 탭을 닫으면 사라집니다. 이 값은 사용자 기기 안에만 있고
            서버로 다시 보내지 않는 한 서버는 알지 못합니다.
          </p>
          <p className="mt-2">
            그럼에도 질병명·채무 상황 등 민감한 개인사는 입력하지 마시기를
            권합니다. 입력란에도 같은 안내를 표시하고 있습니다.
          </p>
        </div>
        <div className="mt-4 rounded-xl border-2 border-warn bg-warn-soft p-5">
          <p className="font-bold text-warn">
            다만 문장의 뜻을 파악하기 위해 외부 임베딩 서비스로 전송됩니다.
          </p>
          <p className="mt-2">
            &ldquo;원하는 것&rdquo; 문장은 의미가 비슷한 공고를 찾기 위해 벡터로
            바꿔야 하고, 이 변환은 외부 사업자의 API 를 호출해 이루어집니다.
            저장은 하지 않지만 <strong>전송은 일어납니다.</strong> 그래서 민감한
            내용을 적지 마시기를 거듭 권합니다.
          </p>
          <ul className="mt-3 list-disc pl-6">
            <li>전송 대상: 임베딩 API 제공사 (Voyage AI 또는 OpenAI, 운영 설정에 따름)</li>
            <li>전송 항목: &ldquo;원하는 것&rdquo; 입력 문장 (인적사항은 보내지 않습니다)</li>
            <li>목적: 문장을 벡터로 변환해 의미가 가까운 공고를 찾기 위함</li>
            <li>해당 사업자의 보관 정책은 각 사업자의 약관을 따르며 본 서비스가 통제하지 않습니다</li>
          </ul>
          <p className="mt-3 text-sm">
            공고 요약·신청 절차 문구를 만드는 언어모델 호출은 수집 배치에서만
            일어나며, 사용자 입력이 그 경로로 전달되지 않습니다.
          </p>
        </div>
      </Section>

      <Section title="4. 이용 목적">
        <ul className="list-disc pl-6">
          <li>입력하신 인적사항과 공고문 자격요건을 대조해 대상 여부를 판정</li>
          <li>결과 정렬(스코어링)과 근접탈락 안내 문구 생성</li>
        </ul>
        <p className="mt-3">
          수집한 정보를 광고·마케팅에 사용하지 않으며, 판매하지 않습니다.
          인적사항을 외부에 제공하는 경로는 없습니다. 유일한 외부 전송은 위 3항의
          &ldquo;원하는 것&rdquo; 문장을 벡터로 바꾸기 위한 임베딩 API 호출이며,
          그 목적 외에는 사용하지 않습니다.
        </p>
      </Section>

      <Section title="5. 보유 및 파기">
        <ul className="list-disc pl-6">
          <li>
            데이터베이스에 저장하는 개인정보가 없으므로 <strong>파기 절차가 필요한
            대상이 없습니다</strong>.
          </li>
          <li>
            인적사항과 세션 식별자는 브라우저 쿠키에만 있고 <strong>90일 뒤 만료</strong>
            됩니다. 브라우저 설정에서 쿠키를 삭제하시면 그 전에도 즉시 사라집니다.
          </li>
          <li>
            요청 빈도 제한용 세션 식별자·IP 는 서버 메모리에만 두며 서버가
            재시작되면 사라집니다. 별도로 기록하지 않습니다.
          </li>
        </ul>
      </Section>

      <Section title="6. 이용자의 권리">
        <p>
          브라우저에서 쿠키를 삭제하시면 입력하신 정보가 즉시 사라집니다.
          데이터베이스에 보관하는 정보가 없으므로 회원가입·탈퇴 절차나 별도의
          삭제 요청 절차가 없습니다.
        </p>
      </Section>

      <Section title="7. 안전성 확보 조치">
        <ul className="list-disc pl-6">
          <li>전 구간 HTTPS 통신 강제</li>
          <li>프로필 쿠키는 httpOnly + 서명 처리 — 스크립트가 읽거나 변조할 수 없습니다</li>
          <li>모든 전송값 서버 측 재검증 (나이 0~120, 지역코드 화이트리스트, 소득분위 1~10, 기준중위소득 비율, 자유입력 200자)</li>
          <li>Content-Security-Policy 등 보안 헤더 적용</li>
          <li>익명 세션 + IP 기준 검색 횟수 제한</li>
          <li>사용자 입력이 대규모 언어모델(LLM)에 전달되는 경로가 없습니다 — 요약·절차는 수집 배치에서 미리 생성한 값입니다</li>
        </ul>
      </Section>

      <Section title="8. 정확성에 대한 고지">
        <p>
          제공되는 정보는 공공기관이 공개한 자료를 자동으로 수집·정리한
          것입니다. 원문 갱신 시점과 수집 시점의 차이, 자동 추출의 한계로 실제와
          다를 수 있습니다.{" "}
          <strong>
            본 정보는 참고용이며 최종 자격 판정은 소관 기관 확인이 필요합니다.
          </strong>{" "}
          모든 카드에 원문 링크와 수집 시각을 함께 표시하고 있으니 반드시
          확인해 주세요.
        </p>
      </Section>

      <Section title="9. 문의">
        <p>
          개인정보 처리에 관한 문의는 서비스 저장소의 이슈로 남겨주시기
          바랍니다. 본 서비스는 2026 금융 AI Challenge 출품을 위한 프로토타입으로
          운영됩니다.
        </p>
      </Section>

      <p className="mt-10">
        <Link href="/sources" className="underline hover:text-brand">
          데이터 출처와 갱신 주기 보기 →
        </Link>
      </p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-xl font-bold text-ink">{title}</h2>
      <div className="mt-3 grid gap-3 text-ink-2">{children}</div>
    </section>
  );
}

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-125 border-collapse text-left text-sm">
        <thead>
          <tr className="border-b-2 border-line">
            {head.map((h) => (
              <th key={h} scope="col" className="px-3 py-2 font-bold text-ink">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line-soft">
              {r.map((c, j) => (
                <td key={j} className="px-3 py-2 align-top text-ink-2">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
