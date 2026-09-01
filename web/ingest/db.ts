import postgres from "postgres";

import { sslOption } from "../src/lib/db";
import { toPgVectorLiteral } from "../src/lib/embedding";
import { PARSER_HASH_PREFIX } from "./models";

export const PROGRAM_COLUMNS = [
  "external_id",
  "raw_document_id",
  "title",
  "body_text",
  "summary",
  "apply_steps",
  "form",
  "issuer",
  "issuer_level",
  "benefit_amount_text",
  "benefit_amount_min",
  "benefit_amount_max",
  "apply_url",
  "apply_method",
  "starts_at",
  "ends_at",
  "is_always_open",
  "source_url",
  "fetched_at",
  "status",
] as const;

export const RULE_COLUMNS = [
  "age_min",
  "age_max",
  "gender",
  "regions",
  "occupations",
  "income_decile_max",
  "median_income_percent_max",
  "extra_conditions",
  "parse_method",
  "parse_evidence",
  "confidence",
] as const;

export type ProgramValues = {
  external_id: string;
  raw_document_id: number;
  title: string;
  body_text: string;
  summary: string;
  apply_steps: string[];
  form: string;
  issuer: string;
  issuer_level: string;
  benefit_amount_text: string;
  benefit_amount_min: number | null;
  benefit_amount_max: number | null;
  apply_url: string;
  apply_method: string;
  starts_at: string | null;
  ends_at: string | null;
  is_always_open: boolean;
  source_url: string;
  fetched_at: Date;
  status: "active" | "expired" | "needs_review";
};

export type RuleValues = {
  age_min: number | null;
  age_max: number | null;
  gender: "M" | "F" | null;
  regions: string[] | null;
  occupations: string[] | null;
  income_decile_max: number | null;
  median_income_percent_max: number | null;
  extra_conditions: Array<Record<string, string>>;
  parse_method: "regex" | "llm" | "mixed";
  parse_evidence: Record<string, unknown>;
  confidence: number;
};

export type RawDocument = {
  id: number;
  external_id: string;
  source_key: string;
  source_url: string;
  content_hash: string;
  raw_body: Record<string, unknown>;
  fetched_at: Date;
};

export type ProgramRow = ProgramValues & {
  id: number;
  first_seen_at: Date;
  last_changed_at: Date;
};

export type EmbeddingRow = {
  program_id: number;
  chunk_idx: number;
  embedding: number[];
  provider: string;
  embedded_at: Date;
};

export type ReviewState = {
  needsReview: boolean;
  reviewReason: string | null;
};

export type InsertRawDocument = Omit<RawDocument, "id">;

export interface Database {
  transaction<T>(fn: (db: Database) => Promise<T>): Promise<T>;
  latestContentHash(externalId: string): Promise<string | null>;
  insertRawDocument(values: InsertRawDocument): Promise<number>;
  getProgramId(externalId: string): Promise<number | null>;
  programStatus(externalId: string): Promise<ProgramValues["status"] | null>;
  upsertProgram(values: ProgramValues): Promise<number>;
  touchProgram(externalId: string, fetchedAt: Date): Promise<void>;
  reactivateProgram(
    externalId: string,
    fetchedAt: Date,
  ): Promise<[title: string, summary: string, bodyText: string] | null>;
  embeddingInput(
    programId: number,
  ): Promise<[title: string, summary: string, bodyText: string] | null>;
  replaceRules(programId: number, values: RuleValues, review?: ReviewState): Promise<void>;
  embeddingProvider(programId: number): Promise<string | null>;
  embeddingProviders(): Promise<Set<string>>;
  activeEmbeddingSpace(): Promise<string | null>;
  replaceEmbeddings(
    programId: number,
    vectors: readonly (readonly number[])[],
    provider: string,
  ): Promise<void>;
  deleteEmbeddings(programId: number): Promise<void>;
  deleteAllEmbeddings(): Promise<void>;
  clearStagedEmbeddings(vectorSpace: string): Promise<void>;
  stageEmbeddings(
    programId: number,
    vectors: readonly (readonly number[])[],
    vectorSpace: string,
  ): Promise<void>;
  activateEmbeddingSpace(vectorSpace: string): Promise<void>;
  withEmbeddingReindexLock<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * 재색인 대상. 수집기와 무관하게 DB 에 있는 공고를 다시 임베딩할 때 쓴다.
   * 활성 공고만 대상으로 한다. `expired`와 `needs_review`가 벡터 top-k 자리를
   * 잡아먹지 않게 두 상태 모두 제외한다.
   */
  programIds(): Promise<number[]>;
  /** 임베딩이 없는 공고. 중단된 재색인을 다음 회차가 이어받는 데 쓴다. */
  programIdsWithoutEmbeddings(): Promise<number[]>;
  activeExternalIds(sourceKey: string): Promise<Set<string>>;
  /**
   * 이미 적재되어 다시 상세를 받을 필요가 없는 external_id.
   * 현재 파서 버전으로 처리된 행만 포함해, 버전 변경 시 호출 한도 안에서 재수집한다.
   * `expired` 는 제외한다 — 원본에 다시 올라오면 재조회해 되살려야 하기 때문이다.
   * 만료 판정용 `activeExternalIds` 와 목적이 다르므로 분리해 둔다.
   */
  knownExternalIds(sourceKey: string): Promise<Set<string>>;
  expirePrograms(externalIds: Iterable<string>): Promise<number>;
  expireProgramsPastDeadline(today: string): Promise<number>;
  expireProgramsBeyondLimit(sourceKey: string, limit: number): Promise<number>;
  sourceBaseline(sourceKey: string): Promise<number | null>;
  recordSourceBaseline(sourceKey: string, fetchedCount: number): Promise<void>;
  commit(): Promise<void>;
  close(): Promise<void>;
}

function assertExactKeys(
  values: Record<string, unknown>,
  expected: readonly string[],
  table: string,
): void {
  const actual = Object.keys(values);
  const mismatch = [
    ...actual.filter((key) => !expected.includes(key)),
    ...expected.filter((key) => !actual.includes(key)),
  ];
  if (mismatch.length) throw new Error(`${table} column mismatch: ${mismatch.sort().join(", ")}`);
}

export class InMemoryDatabase implements Database {
  rawDocuments: RawDocument[] = [];
  programs = new Map<number, ProgramRow>();
  rules = new Map<number, RuleValues & ReviewState & { program_id: number }>();
  embeddings = new Map<number, EmbeddingRow[]>();
  stagedEmbeddings = new Map<string, Map<number, EmbeddingRow[]>>();
  activeVectorSpace: string | null = null;
  baselines = new Map<string, number>();
  committed = 0;
  private byExternal = new Map<string, number>();
  private nextProgramId = 1;
  private nextRawId = 1;

  async transaction<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    const snapshot = structuredClone({
      rawDocuments: this.rawDocuments,
      programs: this.programs,
      rules: this.rules,
      embeddings: this.embeddings,
      stagedEmbeddings: this.stagedEmbeddings,
      activeVectorSpace: this.activeVectorSpace,
      baselines: this.baselines,
      byExternal: this.byExternal,
      nextProgramId: this.nextProgramId,
      nextRawId: this.nextRawId,
    });
    try {
      return await fn(this);
    } catch (error) {
      this.rawDocuments = snapshot.rawDocuments;
      this.programs = snapshot.programs;
      this.rules = snapshot.rules;
      this.embeddings = snapshot.embeddings;
      this.stagedEmbeddings = snapshot.stagedEmbeddings;
      this.activeVectorSpace = snapshot.activeVectorSpace;
      this.baselines = snapshot.baselines;
      this.byExternal = snapshot.byExternal;
      this.nextProgramId = snapshot.nextProgramId;
      this.nextRawId = snapshot.nextRawId;
      throw error;
    }
  }

  async latestContentHash(externalId: string): Promise<string | null> {
    let latest: RawDocument | undefined;
    for (const row of this.rawDocuments) {
      if (
        row.external_id === externalId &&
        (!latest || row.fetched_at.getTime() >= latest.fetched_at.getTime())
      ) {
        latest = row;
      }
    }
    return latest?.content_hash ?? null;
  }

  async insertRawDocument(values: InsertRawDocument): Promise<number> {
    const id = this.nextRawId++;
    this.rawDocuments.push({ id, ...structuredClone(values) });
    return id;
  }

  async getProgramId(externalId: string): Promise<number | null> {
    return this.byExternal.get(externalId) ?? null;
  }

  async programStatus(externalId: string): Promise<ProgramValues["status"] | null> {
    const id = this.byExternal.get(externalId);
    return id === undefined ? null : this.programs.get(id)?.status ?? null;
  }

  async upsertProgram(values: ProgramValues): Promise<number> {
    assertExactKeys(values, PROGRAM_COLUMNS, "programs");
    const existingId = this.byExternal.get(values.external_id);
    const now = values.fetched_at ?? new Date();
    if (existingId !== undefined) {
      const existing = this.programs.get(existingId);
      if (!existing) throw new Error(`program index is corrupt: ${existingId}`);
      this.programs.set(existingId, {
        ...existing,
        ...structuredClone(values),
        last_changed_at: now,
      });
      return existingId;
    }
    const id = this.nextProgramId++;
    this.byExternal.set(values.external_id, id);
    this.programs.set(id, {
      id,
      ...structuredClone(values),
      first_seen_at: now,
      last_changed_at: now,
    });
    return id;
  }

  async touchProgram(externalId: string, fetchedAt: Date): Promise<void> {
    const id = this.byExternal.get(externalId);
    const row = id === undefined ? undefined : this.programs.get(id);
    if (row) row.fetched_at = fetchedAt;
  }

  async reactivateProgram(
    externalId: string,
    fetchedAt: Date,
  ): Promise<[string, string, string] | null> {
    const id = this.byExternal.get(externalId);
    const row = id === undefined ? undefined : this.programs.get(id);
    if (!row || row.status !== "expired") return null;
    row.status = "active";
    row.fetched_at = fetchedAt;
    return [row.title, row.summary ?? "", row.body_text ?? ""];
  }

  async embeddingInput(programId: number): Promise<[string, string, string] | null> {
    const row = this.programs.get(programId);
    return row ? [row.title, row.summary ?? "", row.body_text ?? ""] : null;
  }

  async replaceRules(
    programId: number,
    values: RuleValues,
    review: ReviewState = { needsReview: false, reviewReason: null },
  ): Promise<void> {
    assertExactKeys(values, RULE_COLUMNS, "eligibility_rules");
    this.rules.set(programId, { program_id: programId, ...structuredClone(values), ...review });
  }

  async replaceEmbeddings(
    programId: number,
    vectors: readonly (readonly number[])[],
    provider: string,
  ): Promise<void> {
    await this.deleteEmbeddings(programId);
    const embeddedAt = new Date();
    this.embeddings.set(
      programId,
      vectors.map((embedding, chunk_idx) => ({
        program_id: programId,
        chunk_idx,
        embedding: [...embedding],
        provider,
        embedded_at: embeddedAt,
      })),
    );
  }

  async embeddingProvider(programId: number): Promise<string | null> {
    return this.embeddings.get(programId)?.[0]?.provider ?? null;
  }

  async embeddingProviders(): Promise<Set<string>> {
    return this.activeVectorSpace ? new Set([this.activeVectorSpace]) : new Set();
  }

  async activeEmbeddingSpace(): Promise<string | null> {
    return this.activeVectorSpace;
  }

  async deleteEmbeddings(programId: number): Promise<void> {
    this.embeddings.delete(programId);
  }

  async deleteAllEmbeddings(): Promise<void> {
    this.embeddings.clear();
  }

  async clearStagedEmbeddings(vectorSpace: string): Promise<void> {
    this.stagedEmbeddings.delete(vectorSpace);
  }

  async stageEmbeddings(
    programId: number,
    vectors: readonly (readonly number[])[],
    vectorSpace: string,
  ): Promise<void> {
    let staged = this.stagedEmbeddings.get(vectorSpace);
    if (!staged) {
      staged = new Map();
      this.stagedEmbeddings.set(vectorSpace, staged);
    }
    const embeddedAt = new Date();
    staged.set(
      programId,
      vectors.map((embedding, chunk_idx) => ({
        program_id: programId,
        chunk_idx,
        embedding: [...embedding],
        provider: vectorSpace,
        embedded_at: embeddedAt,
      })),
    );
  }

  async activateEmbeddingSpace(vectorSpace: string): Promise<void> {
    const expected = await this.programIds();
    const staged = this.stagedEmbeddings.get(vectorSpace);
    const stagedIds = [...(staged?.entries() ?? [])]
      .filter(([, rows]) => rows.length > 0)
      .map(([programId]) => programId)
      .sort((a, b) => a - b);
    if (expected.length !== stagedIds.length || expected.some((id, index) => id !== stagedIds[index])) {
      throw new Error(`재색인 벡터가 완전하지 않습니다: ${vectorSpace}`);
    }
    this.embeddings = structuredClone(staged ?? new Map());
    this.activeVectorSpace = vectorSpace;
  }

  async withEmbeddingReindexLock<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  async programIds(): Promise<number[]> {
    return [...this.programs.values()]
      .filter((row) => row.status === "active")
      .map((row) => row.id)
      .sort((a, b) => a - b);
  }

  async programIdsWithoutEmbeddings(): Promise<number[]> {
    return (await this.programIds()).filter((id) => !this.embeddings.get(id)?.length);
  }

  async knownExternalIds(sourceKey: string): Promise<Set<string>> {
    const prefix = `${sourceKey}:`;
    const currentRawIds = new Set(
      this.rawDocuments
        .filter(({ content_hash }) => content_hash.startsWith(PARSER_HASH_PREFIX))
        .map(({ id }) => id),
    );
    return new Set(
      [...this.programs.values()]
        .filter(
          (row) =>
            row.status === "active" &&
            row.external_id.startsWith(prefix) &&
            currentRawIds.has(row.raw_document_id),
        )
        .map((row) => row.external_id),
    );
  }

  async activeExternalIds(sourceKey: string): Promise<Set<string>> {
    const prefix = `${sourceKey}:`;
    return new Set(
      [...this.programs.values()]
        .filter((row) => row.status === "active" && row.external_id.startsWith(prefix))
        .map((row) => row.external_id),
    );
  }

  async expirePrograms(externalIds: Iterable<string>): Promise<number> {
    let count = 0;
    for (const externalId of externalIds) {
      const id = this.byExternal.get(externalId);
      const row = id === undefined ? undefined : this.programs.get(id);
      if (id === undefined || !row || row.status === "expired") continue;
      row.status = "expired";
      this.embeddings.delete(id);
      count++;
    }
    return count;
  }

  async expireProgramsPastDeadline(today: string): Promise<number> {
    return this.expirePrograms(
      [...this.programs.values()]
        .filter((row) => row.status === "active" && row.ends_at !== null && row.ends_at < today)
        .map((row) => row.external_id),
    );
  }

  async expireProgramsBeyondLimit(sourceKey: string, limit: number): Promise<number> {
    const prefix = `${sourceKey}:`;
    const excess = [...this.programs.values()]
      .filter((row) => row.status === "active" && row.external_id.startsWith(prefix))
      .sort((a, b) => b.fetched_at.getTime() - a.fetched_at.getTime() || b.id - a.id)
      .slice(limit)
      .map((row) => row.external_id);
    return this.expirePrograms(excess);
  }

  async sourceBaseline(sourceKey: string): Promise<number | null> {
    return this.baselines.get(sourceKey) ?? null;
  }

  async recordSourceBaseline(sourceKey: string, fetchedCount: number): Promise<void> {
    this.baselines.set(sourceKey, fetchedCount);
  }

  async commit(): Promise<void> {
    this.committed++;
  }

  async close(): Promise<void> {}
}

type RootSql = ReturnType<typeof postgres>;
type QuerySql = RootSql | postgres.TransactionSql;

export function postgresOptions(dsn: string): postgres.Options<Record<string, never>> {
  const ssl = sslOption(dsn);
  return {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 20,
    prepare: false,
    ...(ssl === undefined ? {} : { ssl }),
  };
}

export class PostgresDatabase implements Database {
  private readonly sql: QuerySql;
  private readonly root: RootSql | null;

  constructor(dsn: string, scopedSql?: QuerySql, root: RootSql | null = null) {
    if (scopedSql) {
      this.sql = scopedSql;
      this.root = root;
    } else {
      const sql = postgres(dsn, postgresOptions(dsn));
      this.sql = sql;
      this.root = sql;
    }
  }

  static connect(dsn: string): PostgresDatabase {
    return new PostgresDatabase(dsn);
  }

  async transaction<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    if ("begin" in this.sql) {
      return this.sql.begin((tx) => fn(new PostgresDatabase("", tx))) as Promise<T>;
    }
    return this.sql.savepoint((tx) => fn(new PostgresDatabase("", tx))) as Promise<T>;
  }

  async latestContentHash(externalId: string): Promise<string | null> {
    const rows = await this.sql<{ content_hash: string }[]>`
      SELECT content_hash FROM raw_documents
      WHERE external_id = ${externalId}
      ORDER BY fetched_at DESC LIMIT 1
    `;
    return rows[0]?.content_hash ?? null;
  }

  async insertRawDocument(values: InsertRawDocument): Promise<number> {
    const rows = await this.sql<{ id: number | string }[]>`
      INSERT INTO raw_documents
        (external_id, source_key, source_url, fetched_at, content_hash, raw_body)
      VALUES
        (${values.external_id}, ${values.source_key}, ${values.source_url}, ${values.fetched_at},
         ${values.content_hash}, ${JSON.stringify(values.raw_body)})
      RETURNING id
    `;
    return Number(rows[0].id);
  }

  async getProgramId(externalId: string): Promise<number | null> {
    const rows = await this.sql<{ id: number | string }[]>`
      SELECT id FROM programs WHERE external_id = ${externalId}
    `;
    return rows[0] ? Number(rows[0].id) : null;
  }

  async programStatus(externalId: string): Promise<ProgramValues["status"] | null> {
    const rows = await this.sql<{ status: ProgramValues["status"] }[]>`
      SELECT status FROM programs WHERE external_id = ${externalId}
    `;
    return rows[0]?.status ?? null;
  }

  async upsertProgram(values: ProgramValues): Promise<number> {
    assertExactKeys(values, PROGRAM_COLUMNS, "programs");
    const now = values.fetched_at ?? new Date();
    const rows = await this.sql<{ id: number | string }[]>`
      INSERT INTO programs (
        external_id, raw_document_id, first_seen_at, last_changed_at,
        title, body_text, summary, apply_steps, form, issuer, issuer_level,
        benefit_amount_text, benefit_amount_min, benefit_amount_max,
        apply_url, apply_method, starts_at, ends_at, is_always_open,
        source_url, fetched_at, status
      ) VALUES (
        ${values.external_id}, ${values.raw_document_id}, ${now}, ${now},
        ${values.title}, ${values.body_text}, ${values.summary}, ${this.sql.json(values.apply_steps)},
        ${values.form}, ${values.issuer}, ${values.issuer_level},
        ${values.benefit_amount_text}, ${values.benefit_amount_min}, ${values.benefit_amount_max},
        ${values.apply_url}, ${values.apply_method}, ${values.starts_at}, ${values.ends_at},
        ${values.is_always_open}, ${values.source_url}, ${values.fetched_at}, ${values.status}
      )
      ON CONFLICT (external_id) DO UPDATE SET
        raw_document_id = EXCLUDED.raw_document_id,
        last_changed_at = EXCLUDED.last_changed_at,
        title = EXCLUDED.title,
        body_text = EXCLUDED.body_text,
        summary = EXCLUDED.summary,
        apply_steps = EXCLUDED.apply_steps,
        form = EXCLUDED.form,
        issuer = EXCLUDED.issuer,
        issuer_level = EXCLUDED.issuer_level,
        benefit_amount_text = EXCLUDED.benefit_amount_text,
        benefit_amount_min = EXCLUDED.benefit_amount_min,
        benefit_amount_max = EXCLUDED.benefit_amount_max,
        apply_url = EXCLUDED.apply_url,
        apply_method = EXCLUDED.apply_method,
        starts_at = EXCLUDED.starts_at,
        ends_at = EXCLUDED.ends_at,
        is_always_open = EXCLUDED.is_always_open,
        source_url = EXCLUDED.source_url,
        fetched_at = EXCLUDED.fetched_at,
        status = EXCLUDED.status
      RETURNING id
    `;
    return Number(rows[0].id);
  }

  async touchProgram(externalId: string, fetchedAt: Date): Promise<void> {
    await this.sql`UPDATE programs SET fetched_at = ${fetchedAt} WHERE external_id = ${externalId}`;
  }

  async reactivateProgram(
    externalId: string,
    fetchedAt: Date,
  ): Promise<[string, string, string] | null> {
    const rows = await this.sql<{ title: string; summary: string; body_text: string }[]>`
      UPDATE programs SET status = 'active', fetched_at = ${fetchedAt}
      WHERE external_id = ${externalId} AND status = 'expired'
      RETURNING title, COALESCE(summary, '') AS summary, COALESCE(body_text, '') AS body_text
    `;
    const row = rows[0];
    return row ? [row.title, row.summary, row.body_text] : null;
  }

  async embeddingInput(programId: number): Promise<[string, string, string] | null> {
    const rows = await this.sql<{ title: string; summary: string; body_text: string }[]>`
      SELECT title, COALESCE(summary, '') AS summary, COALESCE(body_text, '') AS body_text
      FROM programs WHERE id = ${programId}
    `;
    const row = rows[0];
    return row ? [row.title, row.summary, row.body_text] : null;
  }

  async replaceRules(
    programId: number,
    values: RuleValues,
    review: ReviewState = { needsReview: false, reviewReason: null },
  ): Promise<void> {
    assertExactKeys(values, RULE_COLUMNS, "eligibility_rules");
    await this.sql`
      INSERT INTO eligibility_rules (
        program_id, age_min, age_max, gender, regions, occupations,
        income_decile_max, median_income_percent_max,
        extra_conditions, parse_method, parse_evidence, confidence, needs_review, review_reason
      ) VALUES (
        ${programId}, ${values.age_min}, ${values.age_max}, ${values.gender},
        ${values.regions ? this.sql.array(values.regions) : null}::text[],
        ${values.occupations ? this.sql.array(values.occupations) : null}::text[],
        ${values.income_decile_max}, ${values.median_income_percent_max},
        ${JSON.stringify(values.extra_conditions)}::jsonb,
        ${values.parse_method}, ${JSON.stringify(values.parse_evidence)}::jsonb, ${values.confidence},
        ${review.needsReview}, ${review.reviewReason}
      )
      ON CONFLICT (program_id) DO UPDATE SET
        age_min = EXCLUDED.age_min,
        age_max = EXCLUDED.age_max,
        gender = EXCLUDED.gender,
        regions = EXCLUDED.regions,
        occupations = EXCLUDED.occupations,
        income_decile_max = EXCLUDED.income_decile_max,
        median_income_percent_max = EXCLUDED.median_income_percent_max,
        extra_conditions = EXCLUDED.extra_conditions,
        parse_method = EXCLUDED.parse_method,
        parse_evidence = EXCLUDED.parse_evidence,
        confidence = EXCLUDED.confidence,
        needs_review = EXCLUDED.needs_review,
        review_reason = EXCLUDED.review_reason
    `;
  }

  async replaceEmbeddings(
    programId: number,
    vectors: readonly (readonly number[])[],
    provider: string,
  ): Promise<void> {
    await this.transaction(async (db) => {
      const sql = (db as PostgresDatabase).sql;
      await sql`DELETE FROM program_embeddings WHERE program_id = ${programId}`;
      for (let chunkIdx = 0; chunkIdx < vectors.length; chunkIdx++) {
        const literal = toPgVectorLiteral([...vectors[chunkIdx]]);
        await sql`
          INSERT INTO program_embeddings (program_id, chunk_idx, embedding, provider, embedded_at)
          VALUES (${programId}, ${chunkIdx}, ${literal}::vector, ${provider}, now())
        `;
      }
    });
  }

  async embeddingProvider(programId: number): Promise<string | null> {
    const rows = await this.sql<{ provider: string }[]>`
      SELECT provider FROM program_embeddings WHERE program_id = ${programId} LIMIT 1
    `;
    return rows[0]?.provider ?? null;
  }

  async embeddingProviders(): Promise<Set<string>> {
    const rows = await this.sql<{ provider: string }[]>`
      SELECT active_vector_space AS provider
      FROM ingest_embedding_state
      WHERE singleton
    `;
    return new Set(rows.flatMap((row) => (row.provider ? [row.provider] : [])));
  }

  async activeEmbeddingSpace(): Promise<string | null> {
    const rows = await this.sql<{ active_vector_space: string | null }[]>`
      SELECT active_vector_space FROM ingest_embedding_state WHERE singleton
    `;
    return rows[0]?.active_vector_space ?? null;
  }

  async deleteEmbeddings(programId: number): Promise<void> {
    await this.sql`DELETE FROM program_embeddings WHERE program_id = ${programId}`;
  }

  async deleteAllEmbeddings(): Promise<void> {
    await this.sql`DELETE FROM program_embeddings`;
  }

  async clearStagedEmbeddings(vectorSpace: string): Promise<void> {
    await this.sql`
      DELETE FROM program_embedding_staging WHERE vector_space = ${vectorSpace}
    `;
  }

  async stageEmbeddings(
    programId: number,
    vectors: readonly (readonly number[])[],
    vectorSpace: string,
  ): Promise<void> {
    await this.sql`
      DELETE FROM program_embedding_staging
      WHERE program_id = ${programId} AND vector_space = ${vectorSpace}
    `;
    for (let chunkIdx = 0; chunkIdx < vectors.length; chunkIdx++) {
      const literal = toPgVectorLiteral([...vectors[chunkIdx]]);
      await this.sql`
        INSERT INTO program_embedding_staging (program_id, vector_space, chunk_idx, embedding, embedded_at)
        VALUES (${programId}, ${vectorSpace}, ${chunkIdx}, ${literal}::vector, now())
      `;
    }
  }

  async activateEmbeddingSpace(vectorSpace: string): Promise<void> {
    if (this.root) {
      return this.transaction((db) => db.activateEmbeddingSpace(vectorSpace));
    }
    await this.sql`SELECT pg_advisory_xact_lock(hashtext('amuguna_embedding_reindex'))`;
    await this.sql`LOCK TABLE programs, program_embedding_staging, program_embeddings IN SHARE ROW EXCLUSIVE MODE`;
    const rows = await this.sql<{ complete: boolean }[]>`
      SELECT NOT EXISTS (
        (SELECT id AS program_id FROM programs WHERE status = 'active'
         EXCEPT
         SELECT DISTINCT program_id FROM program_embedding_staging WHERE vector_space = ${vectorSpace})
        UNION ALL
        (SELECT DISTINCT program_id FROM program_embedding_staging WHERE vector_space = ${vectorSpace}
         EXCEPT
         SELECT id AS program_id FROM programs WHERE status = 'active')
      ) AS complete
    `;
    if (!rows[0]?.complete) {
      throw new Error(`재색인 벡터가 완전하지 않습니다: ${vectorSpace}`);
    }
    await this.sql`DELETE FROM program_embeddings`;
    await this.sql`
      INSERT INTO program_embeddings (program_id, chunk_idx, embedding, provider, embedded_at)
      SELECT s.program_id, s.chunk_idx, s.embedding, s.vector_space, s.embedded_at
      FROM program_embedding_staging AS s
      JOIN programs AS p ON p.id = s.program_id AND p.status = 'active'
      WHERE s.vector_space = ${vectorSpace}
    `;
    await this.sql`
      UPDATE ingest_embedding_state
      SET active_vector_space = ${vectorSpace}, updated_at = now()
      WHERE singleton
    `;
  }

  async withEmbeddingReindexLock<T>(fn: () => Promise<T>): Promise<T> {
    // 활성 교체 트랜잭션의 xact lock과 정확한 ID 집합 검증이 최종 경계를 맡는다.
    // session lock은 transaction-pooler에서 같은 연결로 unlock됨을 보장할 수 없다.
    return fn();
  }

  async programIds(): Promise<number[]> {
    const rows = await this.sql<{ id: number }[]>`
      SELECT id FROM programs WHERE status = 'active' ORDER BY id
    `;
    return rows.map((row) => row.id);
  }

  async programIdsWithoutEmbeddings(): Promise<number[]> {
    const rows = await this.sql<{ id: number }[]>`
      SELECT p.id FROM programs p
      WHERE p.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM program_embeddings e WHERE e.program_id = p.id)
      ORDER BY p.id
    `;
    return rows.map((row) => row.id);
  }

  // starts_with 를 쓴다. LIKE 는 `_` 를 와일드카드로 보므로 social_security /
  // local_welfare 같은 키가 다른 소스와 겹칠 수 있고, InMemory 의 startsWith 와도 어긋난다.
  async knownExternalIds(sourceKey: string): Promise<Set<string>> {
    const rows = await this.sql<{ external_id: string }[]>`
      SELECT p.external_id
      FROM programs p
      JOIN raw_documents d ON d.id = p.raw_document_id
      WHERE p.status = 'active'
        AND starts_with(p.external_id, ${`${sourceKey}:`})
        AND starts_with(d.content_hash, ${PARSER_HASH_PREFIX})
    `;
    return new Set(rows.map((row) => row.external_id));
  }

  async activeExternalIds(sourceKey: string): Promise<Set<string>> {
    const rows = await this.sql<{ external_id: string }[]>`
      SELECT external_id FROM programs
      WHERE status = 'active' AND starts_with(external_id, ${`${sourceKey}:`})
    `;
    return new Set(rows.map((row) => row.external_id));
  }

  async expirePrograms(externalIds: Iterable<string>): Promise<number> {
    const ids = [...externalIds];
    if (!ids.length) return 0;
    const rows = await this.sql<{ id: number | string }[]>`
      UPDATE programs SET status = 'expired'
      WHERE external_id = ANY(${this.sql.array(ids)}::text[]) AND status <> 'expired'
      RETURNING id
    `;
    if (rows.length) {
      await this.sql`
        DELETE FROM program_embeddings
        WHERE program_id = ANY(${this.sql.array(rows.map((row) => Number(row.id)))}::bigint[])
      `;
    }
    return rows.length;
  }

  async expireProgramsPastDeadline(today: string): Promise<number> {
    const rows = await this.sql<{ id: number | string }[]>`
      UPDATE programs SET status = 'expired'
      WHERE status = 'active' AND ends_at < ${today}::date
      RETURNING id
    `;
    if (rows.length) {
      await this.sql`
        DELETE FROM program_embeddings
        WHERE program_id = ANY(${this.sql.array(rows.map((row) => Number(row.id)))}::bigint[])
      `;
    }
    return rows.length;
  }

  async expireProgramsBeyondLimit(sourceKey: string, limit: number): Promise<number> {
    const rows = await this.sql<{ id: number | string }[]>`
      WITH excess AS (
        SELECT id FROM programs
        WHERE status = 'active' AND starts_with(external_id, ${`${sourceKey}:`})
        ORDER BY fetched_at DESC, id DESC
        OFFSET ${limit}
      )
      UPDATE programs p SET status = 'expired'
      FROM excess WHERE p.id = excess.id
      RETURNING p.id
    `;
    if (rows.length) {
      await this.sql`
        DELETE FROM program_embeddings
        WHERE program_id = ANY(${this.sql.array(rows.map((row) => Number(row.id)))}::bigint[])
      `;
    }
    return rows.length;
  }

  async sourceBaseline(sourceKey: string): Promise<number | null> {
    const rows = await this.sql<{ fetched_count: number }[]>`
      SELECT fetched_count FROM ingest_source_baselines WHERE source_key = ${sourceKey}
    `;
    return rows[0]?.fetched_count ?? null;
  }

  async recordSourceBaseline(sourceKey: string, fetchedCount: number): Promise<void> {
    await this.sql`
      INSERT INTO ingest_source_baselines (source_key, fetched_count, succeeded_at)
      VALUES (${sourceKey}, ${fetchedCount}, now())
      ON CONFLICT (source_key) DO UPDATE SET
        fetched_count = EXCLUDED.fetched_count,
        succeeded_at = EXCLUDED.succeeded_at
    `;
  }

  async commit(): Promise<void> {
    // postgres.js commits transaction callbacks automatically.
  }

  async close(): Promise<void> {
    if (this.root) await this.root.end({ timeout: 5 });
  }
}
