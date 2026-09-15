// src/website/mailer.ts
//
// Outbound transactional mail. The only sender in this repo, and deliberately
// minimal: it exists so account verification can prove an address is reachable
// before an account exists.
//
// Resend's REST API rather than an SMTP client, so there is no new dependency —
// the codebase already talks HTTP everywhere.

/** Thrown when mail is required but the provider is not fully configured. */
export class MailNotConfiguredError extends Error {
  constructor(missing: string[] = []) {
    super(
      missing.length
        ? `Email delivery is not configured (missing ${missing.join(', ')})`
        : 'Email delivery is not configured',
    );
    this.name = 'MailNotConfiguredError';
  }
}

/** Thrown when the provider rejected or failed the send. */
export class MailDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailDeliveryError';
  }
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 10_000;

function apiKey(): string | undefined {
  return process.env.RESEND_API_KEY || undefined;
}

/**
 * Fallback sender for local experiments only. It is Resend's shared sandbox
 * address, which only delivers to the account that owns the API key — useful
 * on a laptop, wrong for a deployment, which is why production must set
 * MAIL_FROM explicitly (see missingConfig).
 */
const DEV_SENDER = 'Awesome MCP <onboarding@resend.dev>';

function sender(): string {
  return process.env.MAIL_FROM || DEV_SENDER;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Settings a real send needs but does not have.
 *
 * MAIL_FROM counts as missing only in production. Without this, a deployment
 * that set the API key but not the sender passed the caller's preflight, built
 * pending state, and then failed at the provider — surfacing as a generic 500
 * after the work was already done, or worse, delivering mail from an identity
 * nobody chose.
 */
function missingConfig(): string[] {
  const missing: string[] = [];
  if (!apiKey()) missing.push('RESEND_API_KEY');
  if (!process.env.MAIL_FROM && isProduction()) missing.push('MAIL_FROM');
  return missing;
}

/** True when a send would actually go out. Callers preflight with this. */
export function isMailConfigured(): boolean {
  return missingConfig().length === 0;
}

/**
 * Outside production, an unconfigured mailer prints what it would have sent
 * instead of failing, so a developer can complete a sign-up locally without
 * standing up a mail provider. Production never takes this path — see
 * sendMail — because a missing key there must surface as an error rather than
 * silently swallow a verification link the user is waiting for.
 */
function isDevFallbackAllowed(): boolean {
  return !isProduction();
}

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Send one message.
 *
 * Throws MailNotConfiguredError when there is no provider and we are not
 * allowed to fall back, and MailDeliveryError when the provider refused. Both
 * are meaningful to the caller: a verification flow must not report success
 * for a link that was never sent.
 */
export async function sendMail(message: MailMessage): Promise<void> {
  const missing = missingConfig();
  if (missing.length && isProduction()) throw new MailNotConfiguredError(missing);

  const key = apiKey();
  if (!key) {
    if (!isDevFallbackAllowed()) throw new MailNotConfiguredError(missing);
    // Body, not just the subject: the verification link lives in the text part
    // and this is the only way to reach it without a provider.
    console.error(
      `[mailer] RESEND_API_KEY unset — not sending. to=${message.to} subject="${message.subject}"\n${message.text}`,
    );
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: sender(),
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Provider error bodies can echo the recipient; keep the status and a
      // short excerpt, and let the caller decide what the user sees.
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      throw new MailDeliveryError(`Resend responded ${response.status}: ${detail}`);
    }
  } catch (err: any) {
    if (err instanceof MailDeliveryError) throw err;
    const reason = err?.name === 'AbortError' ? `timed out after ${SEND_TIMEOUT_MS}ms` : err?.message;
    throw new MailDeliveryError(`Could not reach the mail provider: ${reason}`);
  } finally {
    clearTimeout(timeout);
  }
}
