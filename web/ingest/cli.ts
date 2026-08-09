import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { COLLECTORS } from "./collectors";
import { settingsFromEnv } from "./config";
import { InMemoryDatabase, PostgresDatabase } from "./db";
import { Embedder } from "./embedder";
import { LLMFallback, Summarizer } from "./llm";
import { checkVolumeDrop, Pipeline, renderReport, reportToJson } from "./pipeline";

const HELP = `amuguna 공공 금융정보 수집·파싱 배치

사용법:
  npm run ingest -- --fixtures --dry-run [--no-llm]
  npm run ingest -- --since YYYY-MM-DD [--source bizinfo]
  npm run ingest -- --weekly-reconcile

옵션:
  --fixtures            실 API 대신 ingest/fixtures/*.json 사용
  --dry-run             Postgres 대신 메모리 DB 사용
  --source NAME         특정 소스만 실행 (반복 가능)
  --since YYYY-MM-DD    증분 수집 기준일
  --weekly-reconcile    원본에서 사라진 공고를 expired 처리
  --no-llm              LLM 보완·요약 비활성화
  --previous-counts JSON  전일 소스별 건수
  --json-report PATH    JSON 리포트 저장
  --help                도움말
`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      fixtures: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      source: { type: "string", multiple: true },
      since: { type: "string" },
      "weekly-reconcile": { type: "boolean", default: false },
      "no-llm": { type: "boolean", default: false },
      "previous-counts": { type: "string" },
      "json-report": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values.since && !/^\d{4}-\d{2}-\d{2}$/.test(values.since)) {
    throw new Error("--since는 YYYY-MM-DD 형식이어야 합니다");
  }

  const keys = values.source ?? Object.keys(COLLECTORS).sort();
  for (const key of keys) {
    if (!Object.hasOwn(COLLECTORS, key)) {
      throw new Error(`알 수 없는 --source: ${key} (${Object.keys(COLLECTORS).sort().join(", ")})`);
    }
  }

  const settings = settingsFromEnv();
  const db = values["dry-run"]
    ? new InMemoryDatabase()
    : settings.database_url
      ? new PostgresDatabase(settings.database_url)
      : null;
  if (!db) throw new Error("DATABASE_URL이 필요합니다. DB 쓰기 없이 실행하려면 --dry-run을 지정하세요.");

  const noLlm = values["no-llm"];
  const pipeline = new Pipeline(db, {
    embedder: new Embedder(settings),
    summarizer: new Summarizer(noLlm ? { anthropic_api_key: "" } : settings),
    llm: noLlm ? null : new LLMFallback(settings),
    dryRun: values["dry-run"],
  });
  const collectors = keys.map(
    (key) => new COLLECTORS[key]({ settings, useFixtures: values.fixtures }),
  );

  try {
    const report = await pipeline.run(collectors, {
      since: values.since,
      reconcile: values["weekly-reconcile"],
    });
    console.log(renderReport(report));

    const previous = values["previous-counts"]
      ? (JSON.parse(values["previous-counts"]) as Record<string, number>)
      : null;
    for (const warning of checkVolumeDrop(report, previous)) console.warn(`[WARN] ${warning}`);

    if (values["json-report"]) {
      await writeFile(values["json-report"], JSON.stringify(reportToJson(report), null, 2), "utf8");
      console.log(`\nJSON 리포트 저장: ${values["json-report"]}`);
    }
    const total = report.totals;
    const handled = total.created + total.updated + total.unchanged;
    return total.errors.length && handled === 0 ? 1 : 0;
  } finally {
    await db.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
