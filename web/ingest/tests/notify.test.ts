import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  confirmationHtml,
  digestHtml,
  emailConfigFromEnv,
  escapeHtml,
  runNotificationDigest,
  sendResend,
} from "../notify";

test("notification HTML escapes program text and keeps tokens out of API JSON contracts", async () => {
  assert.equal(escapeHtml('<img src=x onerror="x">'), "&lt;img src=x onerror=&quot;x&quot;&gt;");
  const digest = digestHtml("https://app.example", "token_value", [
    { title: '<script>alert(1)</script>', source_url: "https://source.example/a?b=1", isNew: true },
  ]);
  assert.match(digest, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(digest, /<script>/);
  assert.match(confirmationHtml("https://app.example", "token_value"), /confirm=token_value/);

  const subscribe = await readFile(new URL("../../src/app/api/subscribe/route.ts", import.meta.url), "utf8");
  const unsubscribe = await readFile(new URL("../../src/app/api/unsubscribe/[token]/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(subscribe, /unsubscribeToken\s*:/);
  assert.doesNotMatch(unsubscribe, /export async function GET/);
});

test("Resend uses an idempotency key and rejects invalid delivery configuration", async () => {
  assert.throws(
    () => emailConfigFromEnv({ NODE_ENV: "test", RESEND_API_KEY: "key", EMAIL_FROM: "bad", APP_BASE_URL: "https://app.example" }),
    /EMAIL_FROM/,
  );
  const config = emailConfigFromEnv({
    NODE_ENV: "test" as const,
    RESEND_API_KEY: "key",
    EMAIL_FROM: "notifications@example.com",
    APP_BASE_URL: "https://app.example/",
  });
  assert.equal(config.appBaseUrl, "https://app.example");

  let request: Request | undefined;
  await sendResend(
    config,
    { to: "person@example.com", subject: "subject", html: "<p>ok</p>", idempotencyKey: "digest:1:2026-08-13" },
    async (input, init) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ id: "sent" }), { status: 200 });
    },
  );
  assert.equal(request?.headers.get("Idempotency-Key"), "digest:1:2026-08-13");
  assert.equal(request?.headers.get("Authorization"), "Bearer key");
});

test("digest uses the last successful watermark and skips an already-sent delivery", async () => {
  const confirmedAt = new Date("2026-08-01T00:00:00Z");
  const lastDigestAt = new Date("2026-08-12T18:00:00Z");
  const queries: Array<{ text: string; values: unknown[] }> = [];
  let alreadySent = false;
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      queries.push({ text, values });
      if (text.includes("FROM profiles AS p")) return [{
        id: "0f8fad5b-d9cb-469f-a165-70867728950e",
        email: "person@example.com",
        unsubscribe_token: "unsubscribe_token_value",
        email_confirmed_at: confirmedAt,
        last_digest_cutoff: lastDigestAt,
        age: 28,
        gender: "F",
        occupation: "employee_office",
        region_code: "11620",
        income_decile: 3,
        median_income_percent: 80,
      }];
      if (text.includes("to_char(now()")) return [{ date_key: "2026-08-13", cutoff: new Date("2026-08-13T00:00:00Z") }];
      if (text.includes("FROM match_programs")) return [{
        title: "새 지원",
        source_url: "https://source.example/program",
        is_new: true,
      }];
      if (text.includes("INSERT INTO notification_outbox")) {
        return [{ id: 1, sent_at: alreadySent ? new Date() : null }];
      }
      return [];
    },
    { end: async () => undefined },
  );
  let deliveries = 0;
  const connect = (() => sql) as unknown as Parameters<typeof runNotificationDigest>[2];
  const env = {
    NODE_ENV: "test" as const,
    DATABASE_URL: "postgres://localhost/app",
    APP_BASE_URL: "https://app.example",
    RESEND_API_KEY: "key",
    EMAIL_FROM: "notifications@example.com",
  };
  const fetchImpl = async () => {
    deliveries++;
    return new Response(JSON.stringify({ id: "sent" }), { status: 200 });
  };

  assert.equal(await runNotificationDigest(env, fetchImpl, connect), 1);
  const programQuery = queries.find(({ text }) => text.includes("FROM match_programs"));
  assert.ok(programQuery?.values.includes(lastDigestAt));
  assert.match(programQuery?.text ?? "", /ends_at\s*=\s*\(\(now\(\)/);
  assert.doesNotMatch(programQuery?.text ?? "", /LIMIT 20/);
  assert.equal(deliveries, 1);

  alreadySent = true;
  assert.equal(await runNotificationDigest(env, fetchImpl, connect), 0);
  assert.equal(deliveries, 1);
});

test("digest retries pending mail and one failed recipient does not block the next", async () => {
  const firstId = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const secondId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const confirmedAt = new Date("2026-08-01T00:00:00Z");
  const queries: string[] = [];
  const recipient = (id: string, email: string) => ({
    id,
    email,
    unsubscribe_token: "unsubscribe_token_value",
    email_confirmed_at: confirmedAt,
    last_digest_cutoff: null,
    age: 28,
    gender: null,
    occupation: "employee_office",
    region_code: "11620",
    income_decile: null,
    median_income_percent: null,
  });
  const sql = Object.assign(
    async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      queries.push(query);
      if (query.includes("SELECT o.id, o.profile_id")) return [{
        id: 1,
        profile_id: firstId,
        email: "first@example.com",
        delivery_key: "digest:first:2026-08-12",
        payload: { subject: "retry", html: "<p>retry</p>" },
      }];
      if (query.includes("FROM profiles AS p")) {
        return [recipient(firstId, "first@example.com"), recipient(secondId, "second@example.com")];
      }
      if (query.includes("to_char(now()")) {
        return [{ date_key: "2026-08-13", cutoff: new Date("2026-08-13T00:00:00Z") }];
      }
      if (query.includes("FROM match_programs")) {
        return [{ title: "새 지원", source_url: "https://source.example/program", is_new: true }];
      }
      if (query.includes("INSERT INTO notification_outbox")) return [{ id: 2, sent_at: null }];
      return [];
    },
    { end: async () => undefined },
  );
  let deliveries = 0;
  const fetchImpl = async () => {
    deliveries++;
    return new Response("{}", { status: deliveries === 1 ? 500 : 200 });
  };
  const env = {
    NODE_ENV: "test" as const,
    DATABASE_URL: "postgres://localhost/app",
    APP_BASE_URL: "https://app.example",
    RESEND_API_KEY: "key",
    EMAIL_FROM: "notifications@example.com",
  };
  const connect = (() => sql) as unknown as Parameters<typeof runNotificationDigest>[2];

  await assert.rejects(runNotificationDigest(env, fetchImpl, connect), /알림 1건 발송 실패/);
  assert.equal(deliveries, 2);
  assert.equal(queries.filter((query) => query.includes("FROM match_programs")).length, 1);
});

test("one recipient query failure does not block the next recipient", async () => {
  const confirmedAt = new Date("2026-08-01T00:00:00Z");
  let programQueries = 0;
  const sql = Object.assign(
    async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("SELECT o.id, o.profile_id")) return [];
      if (query.includes("FROM profiles AS p")) return [
        {
          id: "0f8fad5b-d9cb-469f-a165-70867728950e",
          email: "first@example.com",
          unsubscribe_token: "first_token_value_12345",
          email_confirmed_at: confirmedAt,
          last_digest_cutoff: null,
          age: 28, gender: null, occupation: "employee_office", region_code: "11620",
          income_decile: null, median_income_percent: null,
        },
        {
          id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
          email: "second@example.com",
          unsubscribe_token: "second_token_value_1234",
          email_confirmed_at: confirmedAt,
          last_digest_cutoff: null,
          age: 28, gender: null, occupation: "employee_office", region_code: "11620",
          income_decile: null, median_income_percent: null,
        },
      ];
      if (query.includes("to_char(now()")) {
        return [{ date_key: "2026-08-13", cutoff: new Date("2026-08-13T00:00:00Z") }];
      }
      if (query.includes("FROM match_programs")) {
        programQueries++;
        if (programQueries === 1) throw new Error("recipient query failed");
        return [{ title: "새 지원", source_url: "https://source.example/program", is_new: true }];
      }
      if (query.includes("INSERT INTO notification_outbox")) return [{ id: 2, sent_at: null }];
      return [];
    },
    { end: async () => undefined },
  );
  const connect = (() => sql) as unknown as Parameters<typeof runNotificationDigest>[2];
  let deliveries = 0;
  const env = {
    NODE_ENV: "test" as const,
    DATABASE_URL: "postgres://localhost/app",
    APP_BASE_URL: "https://app.example",
    RESEND_API_KEY: "key",
    EMAIL_FROM: "notifications@example.com",
  };

  await assert.rejects(
    runNotificationDigest(env, async () => {
      deliveries++;
      return new Response("{}", { status: 200 });
    }, connect),
    /알림 1건 발송 실패/,
  );
  assert.equal(programQueries, 2);
  assert.equal(deliveries, 1);
});
