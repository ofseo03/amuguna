import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { FIXTURES_DIR, settingsFromEnv, type Settings } from "../config";
import type { CollectedProgram } from "../models";

export const USER_AGENT =
  "amuguna-ingest/0.1 (contact: ofseo03@gmail.com)";

export class CollectorError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CollectorError";
  }
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CollectorOptions {
  settings?: Settings;
  useFixtures?: boolean;
  fetchImpl?: FetchLike;
  pageSize?: number;
  retries?: number;
  timeoutMs?: number;
  maxDetailCalls?: number;
}

export interface FetchOptions {
  since?: string | null;
  maxPages?: number;
  /**
   * 이미 적재된 external_id. 건당 상세 조회가 필요한 소스만 참고해, 일일 호출
   * 한도를 신규 건에 몰아준다. 상세 호출이 없는 소스는 그대로 무시한다.
   */
  knownIds?: ReadonlySet<string>;
}

export type CollectorConstructor = new (options?: CollectorOptions) => Collector;

export abstract class Collector {
  abstract readonly sourceKey: string;
  abstract readonly endpoint: string;
  abstract readonly idListEndpoint: string;
  readonly defaultForm: string = "subsidy";
  readonly incrementalStrategy: string | null = null;

  readonly settings: Settings;
  readonly useFixtures: boolean;
  readonly pageSize: number;
  readonly retries: number;
  readonly timeoutMs: number;
  httpCalls = 0;

  private readonly fetchImpl: FetchLike;

  constructor(options: CollectorOptions = {}) {
    this.settings = options.settings ?? settingsFromEnv();
    this.useFixtures = options.useFixtures ?? false;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pageSize = options.pageSize ?? 100;
    this.retries = options.retries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  protected abstract queryParams(options: {
    since: string | null;
    page: number;
  }): Record<string, string | number>;

  protected abstract items(payload: unknown): Record<string, unknown>[];

  protected abstract mapItem(item: Record<string, unknown>): CollectedProgram | null;

  get fixturePath(): string {
    return resolve(FIXTURES_DIR, `${this.sourceKey}.json`);
  }

  private async loadJson(path: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch (error) {
      throw new CollectorError(`JSON 파일을 읽을 수 없음: ${path}`, { cause: error });
    }
  }

  protected requireApiKey(name: string, value: string): string {
    if (!value) throw new CollectorError(`${this.sourceKey}: ${name} 미설정`);
    return value;
  }

  protected async request<T>(
    params: Record<string, string | number>,
    parse: (response: Response) => Promise<T>,
    endpoint = this.endpoint,
  ): Promise<T> {
    const url = new URL(endpoint);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      this.httpCalls += 1;
      try {
        const response = await this.fetchImpl(url, {
          headers: { "User-Agent": USER_AGENT },
          redirect: "follow",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          if (!retryable || attempt === this.retries) {
            throw new CollectorError(`${this.sourceKey} 호출 실패: HTTP ${response.status}`);
          }
          lastError = new Error(`HTTP ${response.status}`);
        } else {
          return await parse(response);
        }
      } catch (error) {
        if (error instanceof CollectorError) throw error;
        lastError = error;
        if (attempt === this.retries) break;
      }

      await new Promise((done) => setTimeout(done, 250 * 2 ** attempt));
    }

    throw new CollectorError(`${this.sourceKey} 호출 실패`, { cause: lastError });
  }

  private async getJson(params: Record<string, string | number>): Promise<unknown> {
    return this.request(params, async (response) => (await response.json()) as unknown);
  }

  externalId(nativeId: string): string {
    return `${this.sourceKey}:${nativeId}`;
  }

  private validateEmptyPage(payload: unknown): void {
    if (!isRecord(payload)) {
      throw new CollectorError(`${this.sourceKey}: 오류 또는 잘못된 응답 봉투`);
    }

    let valid = false;
    let message = "";

    if (this.sourceKey === "social_security") {
      const response = isRecord(payload.response) ? payload.response : payload;
      const header = recordOrUndefined(response.header);
      const body = recordOrUndefined(response.body);
      const pageItems = body?.items;
      valid =
        header !== undefined &&
        String(header.resultCode) === "00" &&
        (Array.isArray(pageItems) ||
          (isRecord(pageItems) &&
            (Object.keys(pageItems).length === 0 || Object.hasOwn(pageItems, "item"))));
      message = header ? String(header.resultMsg || "") : "";
    } else if (this.sourceKey === "bizinfo") {
      const response = recordOrUndefined(payload.response) ?? {};
      const header = recordOrUndefined(response.header) ?? {};
      const body = recordOrUndefined(response.body) ?? {};
      const pageItems = Object.hasOwn(payload, "jsonArray") ? payload.jsonArray : body.items;
      const code = payload.resultCode ?? header.resultCode;
      valid = String(code) === "0000" && (Array.isArray(pageItems) || isRecord(pageItems));
      message = String(payload.resultMsg || header.resultMsg || "");
    } else if (this.sourceKey === "finlife") {
      const result = recordOrUndefined(payload.result);
      valid = result !== undefined && String(result.err_cd) === "000" && Array.isArray(result.baseList);
      message = result ? String(result.err_msg || "") : "";
    } else if (this.sourceKey === "gov24") {
      valid = Array.isArray(payload.data);
    } else if (this.sourceKey === "kstartup") {
      valid = Array.isArray(payload.data);
    } else {
      return;
    }

    if (!valid) {
      throw new CollectorError(
        `${this.sourceKey}: 오류 또는 잘못된 응답 봉투${message ? `: ${message}` : ""}`,
      );
    }
  }

  async fetch({ since = null, maxPages = 5 }: FetchOptions = {}): Promise<CollectedProgram[]> {
    const payloads: unknown[] = [];
    if (this.useFixtures) {
      payloads.push(await this.loadJson(this.fixturePath));
    } else {
      for (let page = 1; page <= maxPages; page += 1) {
        const payload = await this.getJson(this.queryParams({ since, page }));
        const pageItems = this.items(payload);
        if (pageItems.length === 0) this.validateEmptyPage(payload);
        payloads.push(payload);
        if (pageItems.length < this.pageSize) break;
      }
    }

    const collected: CollectedProgram[] = [];
    const seen = new Set<string>();
    for (const payload of payloads) {
      for (const item of this.items(payload)) {
        try {
          const program = this.mapItem(item);
          if (!program || seen.has(program.external_id)) continue;
          seen.add(program.external_id);
          collected.push(program);
        } catch (error) {
          console.warn(`${this.sourceKey}: 항목 매핑 실패`, error);
        }
      }
    }
    return collected;
  }

  async listExternalIds(): Promise<Set<string>> {
    if (this.useFixtures) {
      const idsPath = resolve(FIXTURES_DIR, `${this.sourceKey}.ids.json`);
      try {
        const payload = await this.loadJson(idsPath);
        if (!isRecord(payload) || !Array.isArray(payload.ids)) {
          throw new CollectorError(`${this.sourceKey}: 잘못된 ID 픽스처`);
        }
        return new Set(payload.ids.map((id) => this.externalId(String(id))));
      } catch (error) {
        if (!(error instanceof CollectorError) || !error.cause || !isMissingFile(error.cause)) throw error;
      }
    }
    return new Set((await this.fetch({ maxPages: this.useFixtures ? 5 : 50 })).map((p) => p.external_id));
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

export function firstOf(
  item: Record<string, unknown>,
  keys: readonly string[],
  fallback = "",
): string {
  for (const key of keys) {
    const value = item[key];
    if (value !== null && value !== undefined && value !== "") return String(value).trim();
  }
  return fallback;
}

export function parseAmount(text: string): [number | null, number | null] {
  if (!text) return [null, null];
  const units: Record<string, number> = {
    억: 100_000_000,
    천만: 10_000_000,
    백만: 1_000_000,
    만: 10_000,
  };
  const values = [...text.matchAll(/(\d[\d,.]*)\s*(억|천만|백만|만)?\s*원/g)].map(
    (match) => Number.parseFloat(match[1].replaceAll(",", "")) * (units[match[2] ?? ""] ?? 1),
  );
  if (values.length === 0) return [null, null];
  if (values.length === 1) {
    const value = Math.trunc(values[0]);
    if (/최대|이내|한도|까지/.test(text)) return [null, value];
    if (/최소|이상|부터/.test(text)) return [value, null];
    return [value, value];
  }
  return [Math.trunc(Math.min(...values)), Math.trunc(Math.max(...values))];
}
