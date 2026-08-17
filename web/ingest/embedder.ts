import {
  EMBEDDING_DIM,
  mockEmbed,
  OPENAI_MODEL,
  VOYAGE_MODEL,
  type EmbeddingProvider,
} from "../src/lib/embedding";

export { OPENAI_MODEL };

export const TARGET_CHUNK_CHARS = 500;
export const MAX_CHUNK_CHARS = 900;
export const MAX_CHUNKS = 20;

function splitLongParagraph(paragraph: string, limit: number): string[] {
  const sentences = paragraph
    .split(/(?<=[.!?。])\s+|(?<=다\.)\s*/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  if (!sentences.length) return [paragraph.slice(0, limit)];

  const out: string[] = [];
  let buffer = "";
  for (let sentence of sentences) {
    while (sentence.length > limit) {
      out.push(sentence.slice(0, limit));
      sentence = sentence.slice(limit);
    }
    if (buffer && buffer.length + sentence.length + 1 > limit) {
      out.push(buffer);
      buffer = sentence;
    } else {
      buffer = `${buffer} ${sentence}`.trim();
    }
  }
  if (buffer) out.push(buffer);
  return out;
}

export function chunkText(
  body: string,
  options: { title?: string; summary?: string; target?: number } = {},
): string[] {
  const { title = "", summary = "", target = TARGET_CHUNK_CHARS } = options;
  const paragraphs: string[] = [];
  for (const raw of (body ?? "").trim().split(/\n\s*\n/u)) {
    const paragraph = raw.trim();
    if (!paragraph) continue;
    paragraphs.push(
      ...(paragraph.length > MAX_CHUNK_CHARS
        ? splitLongParagraph(paragraph, target)
        : [paragraph]),
    );
  }

  const chunks: string[] = [];
  let buffer = "";
  for (const paragraph of paragraphs) {
    if (buffer && buffer.length + paragraph.length + 1 > target) {
      chunks.push(buffer);
      buffer = paragraph;
    } else {
      buffer = `${buffer}\n${paragraph}`.trim();
    }
  }
  if (buffer) chunks.push(buffer);

  const header = [title.trim(), summary.trim()].filter(Boolean).join("\n");
  if (!chunks.length) return header ? [header] : [];
  if (header) chunks[0] = `${header}\n${chunks[0]}`;
  return chunks.slice(0, MAX_CHUNKS);
}

export type EmbeddingResult = {
  chunks: string[];
  vectors: number[][];
  provider: EmbeddingProvider;
};

export type EmbeddingSettings = {
  embeddingProvider?: string;
  embeddingApiKey?: string;
  mockEmbeddings?: boolean;
  embedding_provider?: string;
  embedding_api_key?: string;
  mock_embeddings?: boolean;
};

function settingsFromEnv(): {
  embeddingProvider: string;
  embeddingApiKey: string;
  mockEmbeddings: boolean;
} {
  return {
    embeddingProvider: (process.env.EMBEDDING_PROVIDER ?? "mock").toLowerCase(),
    embeddingApiKey: process.env.EMBEDDING_API_KEY ?? "",
    mockEmbeddings: process.env.MOCK_EMBEDDINGS === "1",
  };
}

export class Embedder {
  readonly provider: EmbeddingProvider;
  /**
   * 저장·비교에 쓰는 벡터 공간 식별자. provider 만으로는 같은 provider 안에서의
   * 모델 교체(voyage-3 → voyage-4-large)를 구분하지 못해, 옛 벡터가 새 질의 벡터와
   * 비교되며 유사도가 조용히 망가진다. 모델명을 포함해 재색인이 트리거되게 한다.
   */
  readonly vectorSpace: string;
  readonly apiKey: string;
  apiCalls = 0;

  constructor(settings: EmbeddingSettings = {}) {
    const env = settingsFromEnv();
    const requested = (
      settings.embeddingProvider ?? settings.embedding_provider ?? env.embeddingProvider
    ).toLowerCase();
    // Shared Settings also marks a missing real-provider key as mock_embeddings=true.
    // Do not honor that legacy downgrade unless the selected provider is actually mock.
    const forceMock = (settings.mockEmbeddings ?? env.mockEmbeddings) || requested === "mock";
    if (!forceMock && requested !== "mock" && requested !== "voyage" && requested !== "openai") {
      throw new Error(`unknown EMBEDDING_PROVIDER: ${requested}`);
    }
    this.provider = forceMock ? "mock" : (requested as EmbeddingProvider);
    this.vectorSpace =
      this.provider === "mock"
        ? "mock"
        : `${this.provider}:${this.provider === "voyage" ? VOYAGE_MODEL : OPENAI_MODEL}`;
    this.apiKey = settings.embeddingApiKey ?? settings.embedding_api_key ?? env.embeddingApiKey;
  }

  private async embedRemote(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) throw new Error(`EMBEDDING_API_KEY is required for ${this.provider}`);
    this.apiCalls++;
    const response = await fetch(
      this.provider === "voyage"
        ? "https://api.voyageai.com/v1/embeddings"
        : "https://api.openai.com/v1/embeddings",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          this.provider === "voyage"
            ? {
                model: VOYAGE_MODEL,
                input: texts,
                input_type: "document",
                output_dimension: EMBEDDING_DIM,
              }
            : {
                model: OPENAI_MODEL,
                input: texts,
                dimensions: EMBEDDING_DIM,
              },
        ),
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!response.ok) throw new Error(`embedding API ${response.status}`);
    const data = (await response.json()) as { data?: Array<{ embedding?: unknown }> };
    if (!Array.isArray(data.data) || data.data.length !== texts.length) {
      throw new Error("invalid embedding response count");
    }
    return data.data.map(({ embedding }) => {
      if (
        !Array.isArray(embedding) ||
        embedding.length !== EMBEDDING_DIM ||
        !embedding.every((value) => typeof value === "number" && Number.isFinite(value)) ||
        !embedding.some((value) => value !== 0)
      ) {
        throw new Error("invalid embedding response vector");
      }
      return embedding as number[];
    });
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    if (this.provider === "mock") return texts.map((text) => Array.from(mockEmbed(text)));
    // Never write mock vectors under a real provider: let the record transaction roll back.
    return this.embedRemote(texts);
  }

  async embedProgram({
    title,
    summary,
    body,
  }: {
    title: string;
    summary: string;
    body: string;
  }): Promise<EmbeddingResult> {
    const chunks = chunkText(body, { title, summary });
    return { chunks, vectors: await this.embedTexts(chunks), provider: this.provider };
  }
}
