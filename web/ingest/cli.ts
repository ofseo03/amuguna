import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { COLLECTORS, DEFAULT_SOURCE_KEYS } from "./collectors";
import { settingsFromEnv } from "./config";
import { InMemoryDatabase, PostgresDatabase } from "./db";
import { Embedder } from "./embedder";
import { LLMFallback, Summarizer, fallbackModels } from "./llm";
import { checkVolumeDrop, Pipeline, renderReport, reportToJson } from "./pipeline";

const HELP = `amuguna 공공 금융정보 수집·파싱 배치

사용법:
  npm run ingest -- --fixtures --dry-run [--no-llm]
  npm run ingest -- --since YYYY-MM-DD [--source bizinfo]
  npm run ingest -- --weekly-reconcile

옵션:
  --fixtures            실 API 대신 ingest/fixtures/*.json 사용
  --dry-run             Postgres 대신 메모리 DB 사용
  --source NAME         특정 소스만 실행 (반복 가능, 오류 시 유효 이름 표시)
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

  const keys =
    values.source ?? (values.fixtures ? Object.keys(COLLECTORS).sort() : [...DEFAULT_SOURCE_KEYS]);
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
  if (!noLlm && !settings.openrouter_api_key) {
    // 키가 없으면 요약·절차가 전부 폴백(원문 첫 문장 절단)으로 생성된다. 호출이 0회라
    // 실패율 경고(§8)에도 걸리지 않으므로 여기서 알리지 않으면 아무도 모르고 지나간다.
    console.warn(
      "[llm] OPENROUTER_API_KEY 가 없습니다. 요약과 신청 절차가 전부 폴백 문구로" +
        " 생성됩니다 — 의도한 것이 아니면 키를 설정하거나 --no-llm 을 명시하세요.",
    );
  }
  if (!noLlm && settings.openrouter_api_key && !fallbackModels().length) {
    // 기본 모델은 무료 티어라 예고 없이 rate limit·deprecation 이 온다. 폴백이 없으면
    // 그 순간 신규·수정 공고의 요약이 전부 원문 첫 문장 절단으로 떨어진다 (SPEC §8).
    console.warn(
      "[llm] 대체 모델이 지정되지 않았습니다. LLM_FALLBACK_MODELS 에 검증된 모델 ID 를" +
        " 쉼표로 넣어 두면 기본 모델이 죽어도 배치가 완주합니다.",
    );
  }
  const pipeline = new Pipeline(db, {
    embedder: new Embedder(settings),
    summarizer: new Summarizer(noLlm ? { openrouter_api_key: "" } : settings),
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
    const volumeDrops = checkVolumeDrop(report, previous);
    for (const warning of volumeDrops) console.error(`[ERROR] ${warning}`);

    if (values["json-report"]) {
      await writeFile(values["json-report"], JSON.stringify(reportToJson(report), null, 2), "utf8");
      console.log(`\nJSON 리포트 저장: ${values["json-report"]}`);
    }
    const total = report.totals;
    return total.errors.length || volumeDrops.length ? 1 : 0;
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
