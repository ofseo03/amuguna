import type { Collector } from "./collectors/base";
import { CollectorError } from "./collectors/base";
import type { Database, ProgramValues, RuleValues } from "./db";
import { Embedder } from "./embedder";
import { applyFallback, LLMFallback, Summarizer } from "./llm";
import type { CollectedProgram, EligibilityRules } from "./models";
import {
  computeConfidence,
  eligibilitySourceText,
  parseProgram,
  resolveParseMethod,
} from "./parser";

export const FIELD_NAMES = [
  "age_min",
  "age_max",
  "gender",
  "regions",
  "occupations",
  "income_decile_max",
] as const;

export class SourceStats {
  fetched = 0;
  created = 0;
  updated = 0;
  unchanged = 0;
  expired = 0;
  errors: string[] = [];

  constructor(readonly sourceKey: string) {}

  get changed(): number {
    return this.created + this.updated;
  }
}

export class ParseStats {
  parsed = 0;
  fieldHits: Record<string, number> = {};
  methods: Record<string, number> = {};
  needsReview = 0;
  reviewReasons: Record<string, number> = {};
  blocked = 0;
  withExtraConditions = 0;
  confidenceSum = 0;

  record(rules: EligibilityRules): void {
    this.parsed++;
    for (const name of FIELD_NAMES) {
      const value = rules[name];
      if (value !== null && (!Array.isArray(value) || value.length)) {
        this.fieldHits[name] = (this.fieldHits[name] ?? 0) + 1;
      }
    }
    this.methods[rules.parse_method] = (this.methods[rules.parse_method] ?? 0) + 1;
    if (rules.needs_review) {
      this.needsReview++;
      const reason = rules.review_reason ?? "unknown";
      this.reviewReasons[reason] = (this.reviewReasons[reason] ?? 0) + 1;
    }
    if (rules.blocksActivation) this.blocked++;
    if (rules.extra_conditions.length) this.withExtraConditions++;
    this.confidenceSum += rules.confidence;
  }

  coverage(name: string): number {
    return this.parsed ? (this.fieldHits[name] ?? 0) / this.parsed : 0;
  }

  get meanConfidence(): number {
    return this.parsed ? this.confidenceSum / this.parsed : 0;
  }
}

export class RunReport {
  sources = new Map<string, SourceStats>();
  parse = new ParseStats();
  embeddingsWritten = 0;
  chunksWritten = 0;
  llmParseCalls = 0;
  llmSummaryCalls = 0;
  reconciled = false;
  startedAt = new Date();

  constructor(
    readonly embeddingProvider: string,
    readonly dryRun: boolean,
  ) {}

  get totals(): SourceStats {
    const total = new SourceStats("TOTAL");
    for (const stats of this.sources.values()) {
      total.fetched += stats.fetched;
      total.created += stats.created;
      total.updated += stats.updated;
      total.unchanged += stats.unchanged;
      total.expired += stats.expired;
      total.errors.push(...stats.errors);
    }
    return total;
  }
}

export class Pipeline {
  readonly report: RunReport;

  constructor(
    private readonly db: Database,
    private readonly options: {
      embedder: Embedder;
      summarizer?: Summarizer;
      llm?: LLMFallback | null;
      dryRun?: boolean;
    },
  ) {
    this.options.summarizer ??= new Summarizer();
    this.report = new RunReport(options.embedder.vectorSpace, options.dryRun ?? false);
  }

  private async process(
    db: Database,
    program: CollectedProgram,
    stats: SourceStats,
    now: Date,
  ): Promise<void> {
    const contentHash = program.contentHash();
    const previousHash = await db.latestContentHash(program.external_id);
    const existingId = await db.getProgramId(program.external_id);

    if (existingId !== null && previousHash === contentHash) {
      const restored = await db.reactivateProgram(program.external_id, now);
      if (restored) {
        const [title, summary, body] = restored;
        const result = await this.options.embedder.embedProgram({ title, summary, body });
        await db.replaceEmbeddings(existingId, result.vectors, this.options.embedder.vectorSpace);
        this.report.embeddingsWritten++;
        this.report.chunksWritten += result.vectors.length;
        stats.unchanged++;
        return;
      }
      if ((await db.embeddingProvider(existingId)) !== this.options.embedder.vectorSpace) {
        const input = await db.embeddingInput(existingId);
        if (!input) throw new Error(`program not found: ${existingId}`);
        const [title, summary, body] = input;
        const result = await this.options.embedder.embedProgram({ title, summary, body });
        await db.replaceEmbeddings(existingId, result.vectors, this.options.embedder.vectorSpace);
        this.report.embeddingsWritten++;
        this.report.chunksWritten += result.vectors.length;
      }
      await db.touchProgram(program.external_id, now);
      stats.unchanged++;
      return;
    }

    const rawId = await db.insertRawDocument({
      external_id: program.external_id,
      source_key: program.source_key,
      source_url: program.source_url,
      content_hash: contentHash,
      raw_body: program.raw_body,
      fetched_at: now,
    });

    const rules = parseProgram(program);
    const hasAgeAlternatives = rules.extra_conditions.some(
      (condition) => condition.kind === "age_alternatives",
    );
    if (this.options.llm) {
      const before = this.options.llm.calls;
      await applyFallback(rules, eligibilitySourceText(program), this.options.llm);
      this.report.llmParseCalls += this.options.llm.calls - before;
    }
    if (hasAgeAlternatives) {
      rules.age_min = null;
      rules.age_max = null;
      delete rules.parse_evidence.age_min;
      delete rules.parse_evidence.age_max;
      rules.parse_method = resolveParseMethod(rules.parse_evidence);
      rules.confidence = computeConfidence(rules);
    }
    this.report.parse.record(rules);

    const bodyText = program.embeddingSource();
    const card = await this.options.summarizer!.generate(program);
    this.report.llmSummaryCalls = this.options.summarizer!.calls;
    const values: ProgramValues = {
      external_id: program.external_id,
      raw_document_id: rawId,
      title: program.title,
      body_text: bodyText,
      summary: card.summary,
      apply_steps: card.apply_steps,
      form: program.form,
      issuer: program.issuer,
      issuer_level: program.issuer_level,
      benefit_amount_text: program.benefit_amount_text,
      benefit_amount_min: program.benefit_amount_min,
      benefit_amount_max: program.benefit_amount_max,
      apply_url: program.apply_url,
      apply_method: program.apply_method,
      starts_at: program.starts_at,
      ends_at: program.ends_at,
      is_always_open: program.is_always_open,
      source_url: program.source_url,
      fetched_at: now,
      status: rules.blocksActivation ? "needs_review" : "active",
    };
    const programId = await db.upsertProgram(values);
    await db.replaceRules(programId, rules.toRow() as RuleValues);

    const result = await this.options.embedder.embedProgram({
      title: program.title,
      summary: card.summary,
      body: bodyText,
    });
    await db.replaceEmbeddings(programId, result.vectors, this.options.embedder.vectorSpace);
    this.report.embeddingsWritten++;
    this.report.chunksWritten += result.vectors.length;
    if (previousHash === null) stats.created++;
    else stats.updated++;
  }

  async reconcile(collector: Collector, db: Database = this.db): Promise<number> {
    let sourceIds: Set<string>;
    try {
      sourceIds = await collector.listExternalIds();
    } catch (error) {
      if (!(error instanceof CollectorError)) throw error;
      console.error(`${collector.sourceKey} 전량 대조 실패: ${error.message}`);
      return 0;
    }
    if (!sourceIds.size) {
      console.warn(`${collector.sourceKey} 전량 대조 결과가 비어 있어 만료 처리를 건너뜁니다`);
      return 0;
    }
    const ours = await db.activeExternalIds(collector.sourceKey);
    const gone = [...ours].filter((id) => !sourceIds.has(id));
    const count = await db.expirePrograms(gone);
    this.report.reconciled = true;
    return count;
  }

  async runSource(
    collector: Collector,
    { since, reconcile = false }: { since?: string; reconcile?: boolean } = {},
  ): Promise<SourceStats> {
    let stats = this.report.sources.get(collector.sourceKey);
    if (!stats) {
      stats = new SourceStats(collector.sourceKey);
      this.report.sources.set(collector.sourceKey, stats);
    }
    let programs: CollectedProgram[];
    try {
      programs = await collector.fetch({
        since,
        knownIds: await this.db.knownExternalIds(collector.sourceKey),
      });
    } catch (error) {
      if (!(error instanceof CollectorError)) throw error;
      console.error(`${collector.sourceKey} 수집 실패, 기존 데이터 유지: ${error.message}`);
      stats.errors.push(error.message);
      return stats;
    }

    stats.fetched = programs.length;
    const now = new Date();
    await this.db.transaction(async (sourceDb) => {
      for (const program of programs) {
        try {
          await sourceDb.transaction((recordDb) => this.process(recordDb, program, stats!, now));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`${program.external_id} 처리 실패: ${message}`);
          stats!.errors.push(`${program.external_id}: ${message}`);
        }
      }
      if (reconcile) stats!.expired += await this.reconcile(collector, sourceDb);
    });
    return stats;
  }

  /**
   * 벡터 공간이 바뀌었을 때 DB에 있는 전 공고를 다시 임베딩한다.
   *
   * 수집기를 거치지 않는 것이 핵심이다. 예전처럼 전량 삭제만 하고 재생성을 수집
   * 결과에 맡기면, 이번 회차에 수집기가 돌려주지 않은 공고는 임베딩이 사라진 채
   * 남는다 — `--source` 로 일부만 돌린 경우, 그리고 일일 한도 때문에 이미 적재된
   * 건을 건너뛰는 중앙부처복지가 정확히 그 경우다.
   */
  private async embedPrograms(programIds: readonly number[]): Promise<void> {
    for (const programId of programIds) {
      const input = await this.db.embeddingInput(programId);
      if (!input) continue;
      const [title, summary, body] = input;
      const result = await this.options.embedder.embedProgram({ title, summary, body });
      await this.db.replaceEmbeddings(
        programId,
        result.vectors,
        this.options.embedder.vectorSpace,
      );
      this.report.embeddingsWritten++;
      this.report.chunksWritten += result.vectors.length;
    }
  }

  private async reindexAll(): Promise<void> {
    await this.db.deleteAllEmbeddings();
    await this.embedPrograms(await this.db.programIds());
  }

  async run(
    collectors: readonly Collector[],
    options: { since?: string; reconcile?: boolean } = {},
  ): Promise<RunReport> {
    const providers = await this.db.embeddingProviders();
    if ([...providers].some((provider) => provider !== this.options.embedder.vectorSpace)) {
      if (!options.reconcile) {
        throw new Error("임베딩 provider·모델 변경은 --weekly-reconcile로 전량 재색인해야 합니다");
      }
      await this.reindexAll();
    } else {
      // 재색인은 전량 삭제 후 다시 채우는 구조라 트랜잭션으로 묶이지 않는다. 중간에
      // 임베딩 API 가 죽으면 남은 공고는 벡터가 없는 채로 끝나고, 다음 회차는 남아
      // 있는 행이 전부 현재 벡터 공간이라 provider 불일치를 못 본다 — 그대로 두면
      // 영영 복구되지 않는다. 그래서 벡터가 빠진 공고를 매 회차 이어서 채운다.
      const missing = await this.db.programIdsWithoutEmbeddings();
      if (missing.length) {
        console.warn(`임베딩이 없는 공고 ${missing.length}건을 이어서 색인합니다`);
        await this.embedPrograms(missing);
      }
    }
    for (const collector of collectors) await this.runSource(collector, options);
    await this.db.commit();
    return this.report;
  }
}

export function checkVolumeDrop(
  report: RunReport,
  previous?: Record<string, number> | null,
): string[] {
  if (!previous) return [];
  const warnings: string[] = [];
  for (const [key, stats] of report.sources) {
    const before = previous[key];
    if (before && stats.fetched < before * 0.5) {
      warnings.push(`${key}: 전일 ${before}건 → 금일 ${stats.fetched}건 (50% 이상 감소)`);
    }
  }
  return warnings;
}

export function reportToJson(report: RunReport): Record<string, unknown> {
  return {
    dry_run: report.dryRun,
    embedding_provider: report.embeddingProvider,
    reconciled: report.reconciled,
    started_at: report.startedAt.toISOString(),
    sources: Object.fromEntries(
      [...report.sources].map(([key, stats]) => [
        key,
        {
          fetched: stats.fetched,
          created: stats.created,
          updated: stats.updated,
          unchanged: stats.unchanged,
          expired: stats.expired,
          errors: stats.errors,
        },
      ]),
    ),
    parse: {
      parsed: report.parse.parsed,
      field_hits: report.parse.fieldHits,
      methods: report.parse.methods,
      needs_review: report.parse.needsReview,
      review_reasons: report.parse.reviewReasons,
      status_needs_review: report.parse.blocked,
      with_extra_conditions: report.parse.withExtraConditions,
      mean_confidence: Number(report.parse.meanConfidence.toFixed(4)),
    },
    embeddings: { programs: report.embeddingsWritten, chunks: report.chunksWritten },
    llm_calls: { parse: report.llmParseCalls, summary: report.llmSummaryCalls },
  };
}

export function renderReport(report: RunReport): string {
  const lines = [
    `=== amuguna ingest — ${report.dryRun ? "DRY-RUN (in-memory)" : "LIVE"} ===`,
    `시작: ${report.startedAt.toISOString()}`,
    `임베딩 provider: ${report.embeddingProvider}`,
    "",
    "source              fetched    new  changed   same  expired   err",
  ];
  for (const stats of report.sources.values()) {
    lines.push(
      `${stats.sourceKey.padEnd(20)}${String(stats.fetched).padStart(7)}` +
        `${String(stats.created).padStart(7)}${String(stats.updated).padStart(9)}` +
        `${String(stats.unchanged).padStart(7)}${String(stats.expired).padStart(9)}` +
        `${String(stats.errors.length).padStart(6)}`,
    );
  }
  const total = report.totals;
  lines.push(
    `${"TOTAL".padEnd(20)}${String(total.fetched).padStart(7)}` +
      `${String(total.created).padStart(7)}${String(total.updated).padStart(9)}` +
      `${String(total.unchanged).padStart(7)}${String(total.expired).padStart(9)}` +
      `${String(total.errors.length).padStart(6)}`,
    "",
    `파싱: ${report.parse.parsed}건 / needs_review ${report.parse.needsReview}건 / 평균 confidence ${report.parse.meanConfidence.toFixed(3)}`,
    `임베딩: 프로그램 ${report.embeddingsWritten}건 / 청크 ${report.chunksWritten}행`,
    `LLM 호출: 자격요건 ${report.llmParseCalls}회 / 요약 ${report.llmSummaryCalls}회`,
  );
  if (total.errors.length) lines.push("", ...total.errors.slice(0, 10).map((error) => `오류: ${error}`));
  return lines.join("\n");
}
