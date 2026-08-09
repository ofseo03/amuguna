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
 * **질의 벡터는 색인 벡터와 같은 공간에서 나와야 한다.** 수집 파이프라인
 * (`ingest/embedder.py`)은 EMBEDDING_PROVIDER 가 voyage/openai 이고 키가 있으면
 * 실제로 그 API 를 호출해 그 벡터를 저장한다. 그런데 여기서 mock bigram 벡터를
 * 만들어 비교하면 서로 무관한 두 공간을 재는 셈이라 유사도가 난수와 다를 바 없다 —
 * 그것도 '실 임베딩을 켠' 바로 그 설정에서.
 *
 * 실 provider 연동은 W1 한국어 성능 실측 후로 미뤄져 아직 없다. 그래서 그 구성에서는
 * **mock 으로 대신하지 않고 벡터를 포기한다**(vector: null + degraded). 호출부는
 * 집합 A(자격 필터)만으로 렌더하고 사용자에게 안내 문구를 띄운다
 * (SPEC §8 신뢰성 — "임베딩 API 실패 시 → 집합 A만으로 렌더"). 조용히 틀린 순위를
 * 보여주는 것보다 의도 축이 빠진 것을 드러내는 편이 낫다.
 *
 * provider 를 붙일 때는 이 함수에서 같은 모델을 호출하도록 바꾸면 된다.
 */
export async function embedQuery(
  text: string,
): Promise<{ vector: Float64Array | null; provider: EmbeddingProvider; degraded: boolean }> {
  const provider = resolveProvider();
  if (provider === "mock") {
    // 색인도 mock 알고리즘으로 만들어졌다 (양쪽이 바이트 단위로 같은 계약).
    return { vector: mockEmbed(text), provider: "mock", degraded: false };
  }
  // TODO(W1): voyage/openai 질의 임베딩 연동. 연동 전까지는 의도 축을 끈다.
  console.warn(
    `[embedding] EMBEDDING_PROVIDER=${provider} 는 질의 경로에 아직 연결되지 않았습니다. ` +
      "색인 벡터와 다른 공간을 비교하지 않도록 의도 검색을 끕니다 (degraded).",
  );
  return { vector: null, provider, degraded: true };
}
