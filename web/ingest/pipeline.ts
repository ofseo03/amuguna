import { kstDate } from "../src/lib/eligibility";
import type { Collector } from "./collectors/base";
import { CollectorError } from "./collectors/base";
import type { Database, ProgramValues, RuleValues } from "./db";
import { buildCardCopy } from "./card-copy";
import { Embedder } from "./embedder";
import type { CollectedProgram } from "./models";
import { EligibilityRules } from "./models";
import { computeConfidence, parseProgram } from "./parser";

export const FIELD_NAMES = [
  "age_min",
  "age_max",
  "gender",
  "regions",
  "occupations",
  "income_decile_max",
  "median_income_percent_max",
] as const;

const MVP_SOURCE_LIMIT = 100;
const MVP_SOURCE_KEYS = new Set(["finlife", "gov24"]);

export class SourceStats {
  fetched = 0;
  observed = 0;
  created = 0;
  updated = 0;
  unchanged = 0;
  expired = 0;
  errors: string[] = [];
  incrementalStrategy: string | null = null;
  previousFetched: number | null = null;
  volumeDrop = false;

  constructor(readonly sourceKey: string) {}

  get changed(): number {
    return this.created + this.updated;
  }
}

export class ParseStats {
  parsed = 0;
  fieldHits: Record<string, number> = {};
  methods: Record<string, number> = {};
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
      total.observed += stats.observed;
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
      dryRun?: boolean;
      today?: string;
    },
  ) {
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
    if (rawId === null) throw new Error(`원본 문서를 찾을 수 없음: ${program.external_id}`);

    const rules = parseProgram(program);
    const hasAgeAlternatives = rules.extra_conditions.some(
      (condition) => condition.kind === "age_alternatives",
    );
    if (hasAgeAlternatives) {
      rules.age_min = null;
      rules.age_max = null;
      delete rules.parse_evidence.age_min;
      delete rules.parse_evidence.age_max;
      rules.confidence = computeConfidence(rules);
    }
    this.report.parse.record(rules);

    const bodyText = program.embeddingSource();
    const card = buildCardCopy(program);
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
      status: "active",
    };
    const programId = await db.upsertProgram(values);
    await db.replaceRules(programId, rules.toRow() as RuleValues);

    // 자동 추출이 불완전해도 임베딩은 만든다 — 벡터가 없으면 의도 축(집합 B)에서
    // 영원히 검색되지 않아 사실상 숨긴 것과 같아진다.
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

  async reconcile(
    collector: Collector,
    db: Database = this.db,
    stats?: SourceStats,
    fetchedIds?: Set<string>,
  ): Promise<number> {
    let sourceIds: Set<string>;
    if (fetchedIds) {
      sourceIds = fetchedIds;
    } else {
      try {
        sourceIds = await collector.listExternalIds();
      } catch (error) {
        if (!(error instanceof CollectorError)) throw error;
        console.error(`${collector.sourceKey} 전량 대조 실패: ${error.message}`);
        stats?.errors.push(`reconcile: ${error.message}`);
        return 0;
      }
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
    const limited = MVP_SOURCE_KEYS.has(collector.sourceKey);
    console.log(`[${collector.sourceKey}] 수집 시작${since ? ` (기준일 ${since})` : ""}`);
    let stats = this.report.sources.get(collector.sourceKey);
    if (!stats) {
      stats = new SourceStats(collector.sourceKey);
      stats.incrementalStrategy = collector.incrementalStrategy;
      stats.previousFetched = await this.db.sourceBaseline(collector.sourceKey);
      if (limited && stats.previousFetched !== null) {
        stats.previousFetched = Math.min(stats.previousFetched, MVP_SOURCE_LIMIT);
      }
      this.report.sources.set(collector.sourceKey, stats);
    }
    let programs: CollectedProgram[];
    const today = this.options.today ?? kstDate(new Date());
    try {
      programs = await collector.fetch({
        since,
        knownIds: await this.db.knownExternalIds(collector.sourceKey),
        maxItems: limited ? MVP_SOURCE_LIMIT : undefined,
        today,
      });
    } catch (error) {
      if (!(error instanceof CollectorError)) throw error;
      console.error(`${collector.sourceKey} 수집 실패, 기존 데이터 유지: ${error.message}`);
      stats.errors.push(error.message);
      return stats;
    }

    stats.fetched = programs.length;
    console.log(
      `[${collector.sourceKey}] 수집 완료: ${programs.length}건 (API ${collector.httpCalls}회)`,
    );
    stats.observed = limited ? programs.length : (collector.observedCount ?? programs.length);
    const expected = stats.previousFetched ?? stats.observed;
    stats.volumeDrop =
      stats.previousFetched !== null &&
      stats.previousFetched > 0 &&
      stats.observed <= expected * 0.5;
    const now = new Date();
    const past = programs.filter((program) => program.ends_at !== null && program.ends_at < today);
    const activeCount = programs.length - past.length;
    let processed = 0;
    console.log(`[${collector.sourceKey}] DB 적재·임베딩 시작: ${activeCount}건`);
    await this.db.transaction(async (sourceDb) => {
      stats!.expired += await sourceDb.expirePrograms(past.map((program) => program.external_id));
      for (const program of programs) {
        if (program.ends_at !== null && program.ends_at < today) continue;
        try {
          await sourceDb.transaction((recordDb) => this.process(recordDb, program, stats!, now));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`${program.external_id} 처리 실패: ${message}`);
          stats!.errors.push(`${program.external_id}: ${message}`);
        }
        processed++;
        if (processed % 10 === 0 || processed === activeCount) {
          console.log(`[${collector.sourceKey}] DB 적재·임베딩 진행: ${processed}/${activeCount}`);
        }
      }
      if (reconcile && !stats!.volumeDrop) {
        console.log(`[${collector.sourceKey}] 전량 대조 시작`);
        stats!.expired += await this.reconcile(
          collector,
          sourceDb,
          stats,
          limited ? new Set(programs.map((program) => program.external_id)) : undefined,
        );
        console.log(`[${collector.sourceKey}] 전량 대조 완료`);
      }
      if (limited) {
        stats!.expired += await sourceDb.expireProgramsBeyondLimit(
          collector.sourceKey,
          MVP_SOURCE_LIMIT,
        );
      }
    });
    stats.errors.push(...collector.errors);
    if (!stats.errors.length && !stats.volumeDrop) {
      await this.db.recordSourceBaseline(collector.sourceKey, stats.observed);
    }
    console.log(
      `[${collector.sourceKey}] 완료: 생성 ${stats.created}, 갱신 ${stats.updated}, 유지 ${stats.unchanged}, 만료 ${stats.expired}`,
    );
    return stats;
  }

  /**
   * 벡터 공간이 바뀌었을 때 DB에 있는 전 공고를 다시 임베딩한다.
   *
   * 수집기를 거치지 않고 staging 에 전량을 완성한 뒤 active pointer 를 바꾼다.
   * 새 임베딩 호출이 실패해도 기존 활성 벡터는 남는다. `--source` 일부 실행과 일일
   * 상세 한도로 이미 적재된 건을 건너뛰는 중앙부처복지에서도 전량 대상이 보장된다.
   */
  private async embedPrograms(programIds: readonly number[], staged = false): Promise<void> {
    for (const [index, programId] of programIds.entries()) {
      const input = await this.db.embeddingInput(programId);
      if (input) {
        const [title, summary, body] = input;
        const result = await this.options.embedder.embedProgram({ title, summary, body });
        if (staged) {
          await this.db.stageEmbeddings(programId, result.vectors, this.options.embedder.vectorSpace);
        } else {
          await this.db.replaceEmbeddings(programId, result.vectors, this.options.embedder.vectorSpace);
        }
        this.report.embeddingsWritten++;
        this.report.chunksWritten += result.vectors.length;
      }
      const completed = index + 1;
      if (completed % 10 === 0 || completed === programIds.length) {
        console.log(`[embedding] 진행: ${completed}/${programIds.length}`);
      }
    }
  }

  private async reindexAll(): Promise<void> {
    await this.db.withEmbeddingReindexLock(async () => {
      await this.db.clearStagedEmbeddings(this.options.embedder.vectorSpace);
      const programIds = await this.db.programIds();
      console.log(`[embedding] 전체 재색인 시작: ${programIds.length}건`);
      await this.embedPrograms(programIds, true);
      await this.db.activateEmbeddingSpace(this.options.embedder.vectorSpace);
      console.log("[embedding] 전체 재색인 완료");
    });
  }

  async run(
    collectors: readonly Collector[],
    options: { since?: string; reconcile?: boolean } = {},
  ): Promise<RunReport> {
    console.log(
      `[pipeline] 시작: ${collectors.map((collector) => collector.sourceKey).join(", ")} (${options.reconcile ? "전량 대조" : "증분 수집"})`,
    );
    await this.db.expireProgramsPastDeadline(this.options.today ?? kstDate(new Date()));
    const activeVectorSpace = await this.db.activeEmbeddingSpace();
    if (activeVectorSpace !== this.options.embedder.vectorSpace) {
      if (activeVectorSpace !== null && !options.reconcile) {
        throw new Error("임베딩 provider·모델 변경은 --weekly-reconcile로 전량 재색인해야 합니다");
      }
      if (activeVectorSpace === null && (await this.db.programIds()).length && !options.reconcile) {
        throw new Error("활성 임베딩 공간이 없어 --weekly-reconcile 전량 재색인이 필요합니다");
      }
      await this.reindexAll();
    } else {
      // 현재 활성 공간에서만 누락된 벡터를 보충한다. 공간 전환은 위 staging 경로가
      // 담당하므로 이 경로는 중단된 개별 적재만 복구한다.
      const missing = await this.db.programIdsWithoutEmbeddings();
      if (missing.length) {
        console.warn(`임베딩이 없는 공고 ${missing.length}건을 이어서 색인합니다`);
        await this.embedPrograms(missing);
      }
    }
    for (const collector of collectors) await this.runSource(collector, options);
    await this.db.commit();
    console.log("[pipeline] 완료");
    return this.report;
  }
}

export function checkVolumeDrop(
  report: RunReport,
  previous?: Record<string, number> | null,
): string[] {
  const warnings: string[] = [];
  for (const [key, stats] of report.sources) {
    const before = previous?.[key] ?? stats.previousFetched;
    if (before && stats.observed <= before * 0.5) {
      warnings.push(`${key}: 기준 ${before}건 → 금일 ${stats.observed}건 (50% 이상 감소)`);
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
          observed: stats.observed,
          created: stats.created,
          updated: stats.updated,
          unchanged: stats.unchanged,
          expired: stats.expired,
          errors: stats.errors,
          previous_fetched: stats.previousFetched,
          volume_drop: stats.volumeDrop,
          incremental_strategy: stats.incrementalStrategy,
        },
      ]),
    ),
    parse: {
      parsed: report.parse.parsed,
      field_hits: report.parse.fieldHits,
      methods: report.parse.methods,
      with_extra_conditions: report.parse.withExtraConditions,
      mean_confidence: Number(report.parse.meanConfidence.toFixed(4)),
    },
    embeddings: { programs: report.embeddingsWritten, chunks: report.chunksWritten },
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
    `파싱: ${report.parse.parsed}건 / 평균 confidence ${report.parse.meanConfidence.toFixed(3)}`,
    `임베딩: 프로그램 ${report.embeddingsWritten}건 / 청크 ${report.chunksWritten}행`,
  );
  if (total.errors.length) lines.push("", ...total.errors.slice(0, 10).map((error) => `오류: ${error}`));
  return lines.join("\n");
}
