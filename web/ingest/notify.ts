/**
 * Daily KST notification digest. Run after ingestion with:
 *   node --import tsx ingest/notify.ts
 */
import { pathToFileURL } from "node:url";

import postgres from "postgres";

import { postgresOptions } from "./db";

export type EmailConfig = {
  appBaseUrl: string;
  apiKey: string;
  from: string;
};

type FetchLike = typeof fetch;
type PostgresConnect = (
  dsn: string,
  options: ReturnType<typeof postgresOptions>,
) => ReturnType<typeof postgres>;

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

export function emailConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EmailConfig {
  const apiKey = env.RESEND_API_KEY?.trim() ?? "";
  const from = env.EMAIL_FROM?.trim() ?? "";
  const rawBaseUrl = env.APP_BASE_URL?.trim() ?? "";
  if (!apiKey) throw new Error("RESEND_API_KEY가 필요합니다.");
  if (!/^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/.test(from)) {
    throw new Error("EMAIL_FROM은 표시명 없는 유효한 이메일 주소여야 합니다.");
  }
  let url: URL;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new Error("APP_BASE_URL은 절대 URL이어야 합니다.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol === "http:" && !["localhost", "127.0.0.1"].includes(url.hostname))
  ) {
    throw new Error("APP_BASE_URL은 자격 증명·query 없는 HTTPS URL이어야 합니다.");
  }
  return { appBaseUrl: url.toString().replace(/\/$/, ""), apiKey, from };
}

export async function sendResend(
  config: EmailConfig,
  message: { to: string; subject: string; html: string; idempotencyKey: string },
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const response = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + config.apiKey,
      "Content-Type": "application/json",
      "Idempotency-Key": message.idempotencyKey,
    },
    body: JSON.stringify({ from: config.from, to: [message.to], subject: message.subject, html: message.html }),
  });
  if (!response.ok) throw new Error("Resend 발송 실패: HTTP " + response.status);
}

export function confirmationHtml(baseUrl: string, token: string): string {
  const href = baseUrl + "/unsubscribe?confirm=" + encodeURIComponent(token);
  return "<p>아무거나 알림 신청을 확인해 주세요.</p><p><a href=\"" +
    escapeHtml(href) +
    "\">이메일 알림 확인하기</a></p><p>확인 전에는 알림을 보내지 않습니다.</p>";
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

export function digestHtml(
  baseUrl: string,
  unsubscribeToken: string,
  programs: Array<{ title: string; source_url: string; isNew: boolean }>,
): string {
  const items = programs
    .map((program) => {
      const label = program.isNew ? "새로 등록" : "마감 임박 (D-7 기준 선정)";
      const href = safeUrl(program.source_url);
      const title = escapeHtml(program.title);
      return "<li><strong>" + label + "</strong> — " +
        (href ? "<a href=\"" + escapeHtml(href) + "\">" + title + "</a>" : title) +
        "</li>";
    })
    .join("");
  const unsubscribeHref = baseUrl + "/unsubscribe?token=" + encodeURIComponent(unsubscribeToken);
  return "<p>저장된 인적사항 기준으로 새 지원 또는 D-7 기준 마감 임박 공고를 찾았습니다.</p><ul>" +
    items +
    "</ul><p><a href=\"" + escapeHtml(unsubscribeHref) + "\">알림 해지</a></p>";
}

type Recipient = {
  id: string;
  email: string;
  unsubscribe_token: string;
  email_confirmed_at: Date;
  age: number;
  gender: string | null;
  occupation: string;
  region_code: string;
  income_decile: number | null;
  median_income_percent: number | null;
  last_digest_cutoff: Date | null;
};

type DigestProgram = {
  title: string;
  source_url: string;
  is_new: boolean;
};

type DigestMessage = { subject: string; html: string };
type PendingDigest = {
  id: number;
  profile_id: string;
  email: string;
  delivery_key: string;
  payload: unknown;
};

function digestMessage(value: unknown): DigestMessage | null {
  if (!value || typeof value !== "object") return null;
  const { subject, html } = value as Record<string, unknown>;
  return typeof subject === "string" && typeof html === "string" ? { subject, html } : null;
}

export async function runNotificationDigest(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch,
  connect: PostgresConnect = postgres,
): Promise<number> {
  const config = emailConfigFromEnv(env);
  const dsn = env.DATABASE_URL?.trim();
  if (!dsn) throw new Error("DATABASE_URL이 필요합니다.");
  const sql = connect(dsn, postgresOptions(dsn));
  try {
    let sent = 0;
    const failures: string[] = [];
    const failedProfiles = new Set<string>();
    const pending = await sql<PendingDigest[]>`
      SELECT o.id, o.profile_id, p.email, o.delivery_key, o.payload
      FROM notification_outbox AS o
      JOIN profiles AS p ON p.id = o.profile_id
      WHERE o.kind = 'digest'
        AND o.sent_at IS NULL
        AND o.payload IS NOT NULL
        AND p.email IS NOT NULL
        AND p.email_confirmed_at IS NOT NULL
      ORDER BY o.created_at, o.id
    `;
    for (const row of pending) {
      const message = digestMessage(row.payload);
      if (!message) continue;
      try {
        await sendResend(config, {
          to: row.email,
          subject: message.subject,
          html: message.html,
          idempotencyKey: row.delivery_key,
        }, fetchImpl);
        await sql`UPDATE notification_outbox SET sent_at = now(), last_error = NULL WHERE id = ${row.id}`;
        sent++;
      } catch (error) {
        await sql`UPDATE notification_outbox SET last_error = ${String(error).slice(0, 500)} WHERE id = ${row.id}`;
        failedProfiles.add(row.profile_id);
        failures.push(`${row.profile_id}: ${String(error)}`);
      }
    }

    const recipients = await sql<Recipient[]>`
      SELECT p.id, p.email, p.unsubscribe_token, p.email_confirmed_at,
             p.age, p.gender, p.occupation, p.region_code, p.income_decile,
             p.median_income_percent,
             (SELECT max(o.covered_through_at) FROM notification_outbox AS o
               WHERE o.profile_id = p.id AND o.kind = 'digest' AND o.sent_at IS NOT NULL)
               AS last_digest_cutoff
      FROM profiles AS p
      WHERE p.email IS NOT NULL
        AND p.email_confirmed_at IS NOT NULL
        AND p.unsubscribe_token IS NOT NULL
    `;
    const dateRows = await sql<{ date_key: string; cutoff: Date }[]>`
      SELECT to_char(now() AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS date_key,
             now() AS cutoff
    `;
    const dateKey = dateRows[0]?.date_key;
    const cutoff = dateRows[0]?.cutoff;
    if (!dateKey || !cutoff) throw new Error("알림 기준 시각을 계산하지 못했습니다.");

    for (const recipient of recipients) {
      if (failedProfiles.has(recipient.id)) continue;
      let outboxId: number | undefined;
      try {
        const notifiedAfter = recipient.last_digest_cutoff ?? recipient.email_confirmed_at;
        const programs = await sql<DigestProgram[]>`
          SELECT p.title, p.source_url,
                 (p.first_seen_at > ${notifiedAfter} AND p.first_seen_at <= ${cutoff}) AS is_new
          FROM match_programs(
            ${recipient.age}, ${recipient.gender}, region_prefixes(${recipient.region_code}),
            ${recipient.occupation}, ${recipient.income_decile}, ${recipient.median_income_percent},
            NULL::vector(1024), 200
          ) AS match
          JOIN programs AS p ON p.id = match.program_id
          WHERE match.violations = 0
            AND (
              (p.first_seen_at > ${notifiedAfter} AND p.first_seen_at <= ${cutoff})
              OR p.ends_at = ((now() AT TIME ZONE 'Asia/Seoul')::date + 7)
            )
          ORDER BY p.ends_at NULLS LAST, p.id
        `;
        if (!programs.length) continue;

        const deliveryKey = "digest:" + recipient.id + ":" + dateKey;
        const message = {
          subject: "[아무거나] 새 지원·마감 임박 알림",
          html: digestHtml(config.appBaseUrl, recipient.unsubscribe_token, programs.map((program) => ({
            title: program.title,
            source_url: program.source_url,
            isNew: program.is_new,
          }))),
        };
        const outbox = await sql<{ id: number; sent_at: Date | null }[]>`
          INSERT INTO notification_outbox (profile_id, kind, delivery_key, covered_through_at, payload)
          VALUES (${recipient.id}::uuid, 'digest', ${deliveryKey}, ${cutoff}, ${JSON.stringify(message)}::jsonb)
          ON CONFLICT (delivery_key) DO UPDATE
            SET delivery_key = notification_outbox.delivery_key
          RETURNING id, sent_at
        `;
        if (outbox[0]?.sent_at) continue;
        outboxId = outbox[0]?.id;
        if (!outboxId) throw new Error("알림 outbox를 만들지 못했습니다.");
        await sendResend(config, {
          to: recipient.email,
          subject: message.subject,
          html: message.html,
          idempotencyKey: deliveryKey,
        }, fetchImpl);
        await sql`UPDATE notification_outbox SET sent_at = now(), last_error = NULL WHERE id = ${outboxId}`;
        sent++;
      } catch (error) {
        if (outboxId) {
          await sql`UPDATE notification_outbox SET last_error = ${String(error).slice(0, 500)} WHERE id = ${outboxId}`;
        }
        failures.push(`${recipient.id}: ${String(error)}`);
      }
    }
    if (failures.length) {
      throw new Error(`알림 ${failures.length}건 발송 실패: ${failures.join("; ").slice(0, 1000)}`);
    }
    return sent;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  const sent = await runNotificationDigest();
  console.log("notification digest sent: " + sent);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
