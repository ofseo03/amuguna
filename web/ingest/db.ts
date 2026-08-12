import postgres from "postgres";

import { sslOption } from "../src/lib/db";
import { toPgVectorLiteral } from "../src/lib/embedding";

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

export type InsertRawDocument = Omit<RawDocument, "id">;

export interface Database {
  transaction<T>(fn: (db: Database) => Promise<T>): Promise<T>;
  latestContentHash(externalId: string): Promise<string | null>;
  insertRawDocument(values: InsertRawDocument): Promise<number>;
  getProgramId(externalId: string): Promise<number | null>;
  upsertProgram(values: ProgramValues): Promise<number>;
  touchProgram(externalId: string, fetchedAt: Date): Promise<void>;
  reactivateProgram(
    externalId: string,
    fetchedAt: Date,
  ): Promise<[title: string, summary: string, bodyText: string] | null>;
  embeddingInput(
    programId: number,
  ): Promise<[title: string, summary: string, bodyText: string] | null>;
  replaceRules(programId: number, values: RuleValues): Promise<void>;
  embeddingProvider(programId: number): Promise<string | null>;
  embeddingProviders(): Promise<Set<string>>;
  replaceEmbeddings(
    programId: number,
    vectors: readonly (readonly number[])[],
    provider: string,
  ): Promise<void>;
  deleteEmbeddings(programId: number): Promise<void>;
  deleteAllEmbeddings(): Promise<void>;
  /**
   * 재색인 대상. 수집기와 무관하게 DB 에 있는 공고를 다시 임베딩할 때 쓴다.
   * `expired` 는 만료 시 임베딩을 지우므로 되살리지 않는다 — 되살리면 만료 공고가
   * 벡터 top-k 자리를 잡아먹는다.
   */
  programIds(): Promise<number[]>;
  /** 임베딩이 없는 공고. 중단된 재색인을 다음 회차가 이어받는 데 쓴다. */
  programIdsWithoutEmbeddings(): Promise<number[]>;
  activeExternalIds(sourceKey: string): Promise<Set<string>>;
  /**
   * 이미 적재되어 다시 상세를 받을 필요가 없는 external_id.
   * `expired` 는 제외한다 — 원본에 다시 올라오면 재조회해 되살려야 하기 때문이다.
   * 만료 판정용 `activeExternalIds` 와 목적이 다르므로 분리해 둔다.
   */
  knownExternalIds(sourceKey: string): Promise<Set<string>>;
  expirePrograms(externalIds: Iterable<string>): Promise<number>;
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
  rules = new Map<number, RuleValues & { program_id: number }>();
  embeddings = new Map<number, EmbeddingRow[]>();
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

  async replaceRules(programId: number, values: RuleValues): Promise<void> {
    assertExactKeys(values, RULE_COLUMNS, "eligibility_rules");
    this.rules.set(programId, { program_id: programId, ...structuredClone(values) });
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
    return new Set(
      [...this.embeddings.values()].flat().map((row) => row.provider || "unknown"),
    );
  }

  async deleteEmbeddings(programId: number): Promise<void> {
    this.embeddings.delete(programId);
  }

  async deleteAllEmbeddings(): Promise<void> {
    this.embeddings.clear();
  }

  async programIds(): Promise<number[]> {
    return [...this.programs.values()]
      .filter((row) => row.status !== "expired")
      .map((row) => row.id)
      .sort((a, b) => a - b);
  }

  async programIdsWithoutEmbeddings(): Promise<number[]> {
    return (await this.programIds()).filter((id) => !this.embeddings.get(id)?.length);
  }

  async knownExternalIds(sourceKey: string): Promise<Set<string>> {
    const prefix = `${sourceKey}:`;
    return new Set(
      [...this.programs.values()]
        .filter((row) => row.status !== "expired" && row.external_id.startsWith(prefix))
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

  async commit(): Promise<void> {
    this.committed++;
  }

  async close(): Promise<void> {}
}

type RootSql = ReturnType<typeof postgres>;
type QuerySql = RootSql | postgres.TransactionSql;

function dsnSslMode(dsn: string): string | null {
  try {
    return new URL(dsn).searchParams.get("sslmode");
  } catch {
    // Do not try to fully parse libpq keyword DSNs here.  This is only enough
    // to avoid overriding an explicit sslmode before the driver validates it.
    const match = /(?:^|\s)sslmode\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/iu.exec(dsn);
    return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
  }
}

function isLocalDsn(dsn: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(dsn).hostname);
  } catch {
    const match = /(?:^|\s)host\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/iu.exec(dsn);
    const host = match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
    return ["localhost", "127.0.0.1", "::1"].includes(host) || host.startsWith("/");
  }
}

export function postgresOptions(dsn: string): postgres.Options<Record<string, never>> {
  const sslMode = dsnSslMode(dsn);
  return {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 20,
    prepare: false,
    ...(sslMode === null && process.env.PGSSLROOTCERT
      ? { ssl: sslOption() }
      : sslMode === null && !isLocalDsn(dsn)
        ? { ssl: "verify-full" as const }
        : {}),
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

  async replaceRules(programId: number, values: RuleValues): Promise<void> {
    assertExactKeys(values, RULE_COLUMNS, "eligibility_rules");
    await this.sql`
      INSERT INTO eligibility_rules (
        program_id, age_min, age_max, gender, regions, occupations,
        income_decile_max, extra_conditions, parse_method, parse_evidence, confidence
      ) VALUES (
        ${programId}, ${values.age_min}, ${values.age_max}, ${values.gender},
        ${values.regions ? this.sql.array(values.regions) : null}::text[],
        ${values.occupations ? this.sql.array(values.occupations) : null}::text[],
        ${values.income_decile_max}, ${JSON.stringify(values.extra_conditions)}::jsonb,
        ${values.parse_method}, ${JSON.stringify(values.parse_evidence)}::jsonb, ${values.confidence}
      )
      ON CONFLICT (program_id) DO UPDATE SET
        age_min = EXCLUDED.age_min,
        age_max = EXCLUDED.age_max,
        gender = EXCLUDED.gender,
        regions = EXCLUDED.regions,
        occupations = EXCLUDED.occupations,
        income_decile_max = EXCLUDED.income_decile_max,
        extra_conditions = EXCLUDED.extra_conditions,
        parse_method = EXCLUDED.parse_method,
        parse_evidence = EXCLUDED.parse_evidence,
        confidence = EXCLUDED.confidence
    `;
  }

  async replaceEmbeddings(
    programId: number,
    vectors: readonly (readonly number[])[],
    provider: string,
  ): Promise<void> {
    await this.deleteEmbeddings(programId);
    for (let chunkIdx = 0; chunkIdx < vectors.length; chunkIdx++) {
      const literal = toPgVectorLiteral([...vectors[chunkIdx]]);
      await this.sql`
        INSERT INTO program_embeddings (program_id, chunk_idx, embedding, provider, embedded_at)
        VALUES (${programId}, ${chunkIdx}, ${literal}::vector, ${provider}, now())
      `;
    }
  }

  async embeddingProvider(programId: number): Promise<string | null> {
    const rows = await this.sql<{ provider: string }[]>`
      SELECT provider FROM program_embeddings WHERE program_id = ${programId} LIMIT 1
    `;
    return rows[0]?.provider ?? null;
  }

  async embeddingProviders(): Promise<Set<string>> {
    const rows = await this.sql<{ provider: string }[]>`
      SELECT DISTINCT COALESCE(provider, 'unknown') AS provider FROM program_embeddings
    `;
    return new Set(rows.map((row) => row.provider));
  }

  async deleteEmbeddings(programId: number): Promise<void> {
    await this.sql`DELETE FROM program_embeddings WHERE program_id = ${programId}`;
  }

  async deleteAllEmbeddings(): Promise<void> {
    await this.sql`DELETE FROM program_embeddings`;
  }

  async programIds(): Promise<number[]> {
    const rows = await this.sql<{ id: number }[]>`
      SELECT id FROM programs WHERE status <> 'expired' ORDER BY id
    `;
    return rows.map((row) => row.id);
  }

  async programIdsWithoutEmbeddings(): Promise<number[]> {
    const rows = await this.sql<{ id: number }[]>`
      SELECT p.id FROM programs p
      WHERE p.status <> 'expired'
        AND NOT EXISTS (SELECT 1 FROM program_embeddings e WHERE e.program_id = p.id)
      ORDER BY p.id
    `;
    return rows.map((row) => row.id);
  }

  // starts_with 를 쓴다. LIKE 는 `_` 를 와일드카드로 보므로 social_security /
  // local_welfare 같은 키가 다른 소스와 겹칠 수 있고, InMemory 의 startsWith 와도 어긋난다.
  async knownExternalIds(sourceKey: string): Promise<Set<string>> {
    const rows = await this.sql<{ external_id: string }[]>`
      SELECT external_id FROM programs
      WHERE status <> 'expired' AND starts_with(external_id, ${`${sourceKey}:`})
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

  async commit(): Promise<void> {
    // postgres.js commits transaction callbacks automatically.
  }

  async close(): Promise<void> {
    if (this.root) await this.root.end({ timeout: 5 });
  }
}
