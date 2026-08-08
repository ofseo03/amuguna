/**
 * 질의 임베딩 (SPEC §7.2).
 *
 * 사용자가 입력한 문장만 임베딩한다 — 인적사항은 절대 넣지 않는다.
 * 인적사항을 섞으면 SQL 자격 축과 벡터 의도 축이 같은 것을 재게 되어 교집합이 무의미해진다.
 *
 * EMBEDDING_PROVIDER=mock (기본) 일 때 쓰는 mock 임베딩은
 * 수집 팀(Python)이 문서를 색인할 때 쓰는 알고리즘과 **바이트 단위로 동일**해야 한다.
 * 하나라도 어긋나면 유사도가 전부 무의미해지므로 이 함수는 임의로 수정하지 않는다.
 */

export const EMBEDDING_DIM = 1024;

/**
 * 계약된 mock 임베딩 알고리즘 (Python 수집 파이프라인과 동일):
 *   NFC 정규화 → 소문자화 → 코드포인트 시퀀스
 *   인접 코드포인트 쌍 (c1, c2) 마다 idx = (c1*31 + c2) % 1024 위치를 +1
 *   코드포인트가 2개 미만이면 v[0] = 1
 *   L2 정규화
 */
export function mockEmbed(text: string): Float64Array {
  const normalized = text.normalize("NFC").toLowerCase();
  const cps: number[] = [];
  for (const ch of normalized) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined) cps.push(cp);
  }

  const v = new Float64Array(EMBEDDING_DIM);
  if (cps.length < 2) {
    v[0] = 1;
  } else {
    for (let i = 0; i + 1 < cps.length; i++) {
      const idx = (cps[i] * 31 + cps[i + 1]) % EMBEDDING_DIM;
      v[idx] += 1;
    }
  }

  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < EMBEDDING_DIM; i++) v[i] /= norm;
  }
  return v;
}

/** 정규화된 벡터 전제. 정규화가 깨져 있어도 안전하도록 분모를 방어한다. */
export function cosine(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** pgvector 리터럴 — '[0.1,0.2,...]'::vector 형태로 바인딩한다 (DB 계약). */
export function toPgVectorLiteral(v: Float64Array | number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < v.length; i++) parts.push(v[i].toFixed(8));
  return `[${parts.join(",")}]`;
}

export type EmbeddingProvider = "voyage" | "openai" | "mock";

export function resolveProvider(): EmbeddingProvider {
  if (process.env.MOCK_EMBEDDINGS === "1") return "mock";
  const p = (process.env.EMBEDDING_PROVIDER ?? "mock").toLowerCase();
  if (p === "voyage" || p === "openai") return p;
  return "mock";
}

/**
 * 질의 벡터 생성.
 *
 * 실 provider(voyage/openai)는 W1 한국어 성능 실측 후 확정 예정이라 아직 미연결이다.
 * 키가 없거나 호출이 실패하면 mock으로 폴백한다 —
 * SPEC §8 신뢰성: "임베딩 API 실패 시 → 집합 A만으로 렌더 (degraded)" 의
 * 앞단으로, 완전 실패 전에 결정론적 폴백을 한 번 더 둔다.
 */
export async function embedQuery(
  text: string,
): Promise<{ vector: Float64Array; provider: EmbeddingProvider; degraded: boolean }> {
  const provider = resolveProvider();
  if (provider === "mock" || !process.env.EMBEDDING_API_KEY) {
    return { vector: mockEmbed(text), provider: "mock", degraded: provider !== "mock" };
  }
  try {
    // 실 provider 연동 지점 (W1 확정 후 구현).
    // 현재는 계약된 mock 알고리즘으로 결정론적 동작을 보장한다.
    return { vector: mockEmbed(text), provider, degraded: false };
  } catch {
    return { vector: mockEmbed(text), provider: "mock", degraded: true };
  }
}
