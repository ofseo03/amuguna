/**
 * 질의 임베딩 (SPEC §7.2).
 *
 * 사용자가 입력한 문장만 임베딩한다 — 인적사항은 절대 넣지 않는다.
 * 인적사항을 섞으면 SQL 자격 축과 벡터 의도 축이 같은 것을 재게 되어 교집합이 무의미해진다.
 *
 * EMBEDDING_PROVIDER=mock (기본) 일 때 쓰는 mock 임베딩은
 * `web/ingest/embedder.ts`가 문서를 색인할 때 쓰는 알고리즘과 **바이트 단위로 동일**해야 한다.
 * 하나라도 어긋나면 유사도가 전부 무의미해지므로 이 함수는 임의로 수정하지 않는다.
 */

export const EMBEDDING_DIM = 1024;
export const VOYAGE_MODEL = "voyage-4-large";
export const OPENAI_MODEL = "text-embedding-3-small";

/**
 * 웹 질의와 TypeScript 수집 배치가 공유하는 mock 임베딩 알고리즘:
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

/* ------------------------------------------------------------------ */
/* 질의 벡터 캐시                                                        */
/* ------------------------------------------------------------------ */

/**
 * 같은 문장은 같은 벡터를 만드는데 매 요청 임베딩 API 를 부르고 있었다.
 * 검색 1회 = 과금 1회이므로 반복 질의가 곧 낭비다 — 특히 온보딩의 예시 문구 4종은
 * 누르기만 하면 그대로 전송되므로 사용자 수만큼 같은 문장이 반복된다.
 *
 * 캐시 키에 **provider 와 모델명을 포함한다.** 모델을 바꾸면 벡터 공간이 달라지는데,
 * 문장만으로 키를 잡으면 예전 공간의 벡터가 새 공간의 색인과 비교되어 유사도가
 * 통째로 무의미해진다 — 값이 틀리는 게 아니라 조용히 엉뚱해지는 종류의 오류다.
 */
const QUERY_CACHE_MAX = 500;
const queryCache = new Map<string, Float64Array>();

/**
 * 질의 정규화 — 표기만 다른 같은 질문을 한 항목으로 모은다.
 * 임베딩 모델이 대소문자·공백에 사실상 불변이므로 캐시 적중률만 올라간다.
 */
export function normalizeQuery(text: string): string {
  return text.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export function queryCacheKey(text: string, space: string): string {
  return `${space} :: ${normalizeQuery(text)}`;
}

function cacheGet(key: string): Float64Array | null {
  const hit = queryCache.get(key);
  if (!hit) return null;
  // LRU: 다시 넣어 최근 사용으로 올린다
  queryCache.delete(key);
  queryCache.set(key, hit);
  return hit;
}

function cacheSet(key: string, vector: Float64Array): void {
  queryCache.set(key, vector);
  while (queryCache.size > QUERY_CACHE_MAX) {
    // Map 은 삽입 순서를 지키므로 첫 항목이 가장 오래 안 쓰인 것이다
    const oldest = queryCache.keys().next().value;
    if (oldest === undefined) break;
    queryCache.delete(oldest);
  }
}

/** 테스트·운영 점검용 */
export function queryCacheSize(): number {
  return queryCache.size;
}

export function clearQueryCache(): void {
  queryCache.clear();
}

/**
 * 질의 임베딩 호출 상한.
 *
 * `/api/match` 한 요청의 예산은 임베딩 1회 + SQL + (최초 검색만) OpenRouter 12초다 (SPEC §8 성능).
 * 여기가 60초였을 때는 provider 가 느려지면 서버리스 함수 한도가 먼저 끊어 504 가 났고,
 * 아래 catch 의 degraded 경로(집합 A 만으로 렌더)는 영원히 실행되지 않았다.
 * 정상 응답은 1초 안쪽이지만 provider 측 일시 지연을 흡수하도록 15초를 준다.
 * 넘기면 곧바로 자격 축만으로 내려간다. `/api/match` 의 maxDuration 이 이 값을 전제한다.
 */
const QUERY_EMBED_TIMEOUT_MS = 15_000;

export type EmbeddingProvider = "voyage" | "openai" | "mock";

export function resolveProvider(): EmbeddingProvider {
  if (process.env.MOCK_EMBEDDINGS === "1") return "mock";
  const p = (process.env.EMBEDDING_PROVIDER ?? "mock").toLowerCase();
  if (p === "voyage" || p === "openai") return p;
  return "mock";
}

export function vectorSpace(provider: EmbeddingProvider = resolveProvider()): string {
  return provider === "mock"
    ? "mock"
    : `${provider}:${provider === "voyage" ? VOYAGE_MODEL : OPENAI_MODEL}`;
}

/**
 * 질의 벡터 생성.
 *
 * 실 provider는 수집과 같은 벡터 공간을 쓰고, Voyage 질의는 query input_type으로 구분한다.
 * 실 provider가 실패하면 null을 돌려 집합 A만으로 렌더한다 (SPEC §8).
 */
export async function embedQuery(
  text: string,
): Promise<{ vector: Float64Array | null; provider: EmbeddingProvider; degraded: boolean }> {
  const provider = resolveProvider();
  // mock 은 순수 계산이라 캐시할 이유가 없다 (API 호출도 과금도 없다)
  if (provider === "mock") return { vector: mockEmbed(text), provider, degraded: false };
  if (!process.env.EMBEDDING_API_KEY) return { vector: null, provider, degraded: true };

  const cacheKey = queryCacheKey(text, vectorSpace(provider));
  const cached = cacheGet(cacheKey);
  if (cached) return { vector: cached, provider, degraded: false };

  try {
    const response = await fetch(
      provider === "voyage"
        ? "https://api.voyageai.com/v1/embeddings"
        : "https://api.openai.com/v1/embeddings",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.EMBEDDING_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          provider === "voyage"
            ? {
                model: VOYAGE_MODEL,
                input: [text],
                input_type: "query",
                output_dimension: EMBEDDING_DIM,
              }
            : {
                model: OPENAI_MODEL,
                input: [text],
                dimensions: EMBEDDING_DIM,
              },
        ),
        signal: AbortSignal.timeout(QUERY_EMBED_TIMEOUT_MS),
      },
    );
    if (!response.ok) throw new Error(`embedding API ${response.status}`);
    const embedding = (
      (await response.json()) as { data?: Array<{ embedding?: unknown }> }
    ).data?.[0]?.embedding;
    if (
      !Array.isArray(embedding) ||
      embedding.length !== EMBEDDING_DIM ||
      !embedding.every(
        (value: unknown) => typeof value === "number" && Number.isFinite(value),
      ) ||
      !embedding.some((value: unknown) => value !== 0)
    ) {
      throw new Error("invalid embedding response");
    }
    const vector = Float64Array.from(embedding as number[]);
    // 검증을 통과한 벡터만 캐시한다 — 실패분을 캐시하면 장애가 캐시 수명만큼 늘어난다
    cacheSet(cacheKey, vector);
    return { vector, provider, degraded: false };
  } catch {
    return { vector: null, provider, degraded: true };
  }
}
