// src/website/authEmails.ts
//
// Bodies for the two mails the sign-up flow can send. Kept apart from the
// transport and the routes so the wording — the part a user actually judges
// the product by — is reviewable in one place.
import type { MailMessage } from './mailer.js';

/** Minimal escaping for the few values interpolated into the HTML parts. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const WRAPPER_OPEN =
  '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;' +
  'font-size:15px;line-height:1.6;color:#1a1a1a;max-width:520px">';
const WRAPPER_CLOSE = '</div>';

/**
 * The verification mail. The link is the whole payload, so it appears as a
 * button and again as literal text — mail clients that strip or rewrite
 * anchors would otherwise leave the recipient stuck.
 */
export function verificationEmail(to: string, verifyUrl: string, ttlHours: number): MailMessage {
  const safeUrl = escapeHtml(verifyUrl);
  return {
    to,
    subject: 'Confirm your email to finish signing up',
    html:
      WRAPPER_OPEN +
      '<h2 style="font-size:18px;margin:0 0 12px">Confirm your email</h2>' +
      '<p style="margin:0 0 20px">Click the button below to finish creating your ' +
      'account. Your account is not created until you do.</p>' +
      `<p style="margin:0 0 20px"><a href="${safeUrl}" ` +
      'style="display:inline-block;background:#0070f3;color:#fff;text-decoration:none;' +
      `padding:11px 20px;border-radius:8px;font-weight:500">Confirm email</a></p>` +
      '<p style="margin:0 0 20px;color:#555">Or paste this link into your browser:<br>' +
      `<span style="word-break:break-all">${safeUrl}</span></p>` +
      `<p style="margin:0;color:#777;font-size:13px">The link expires in ${ttlHours} hours. ` +
      "If you didn't request this, you can ignore this email — nothing was created.</p>" +
      WRAPPER_CLOSE,
    text:
      'Confirm your email\n\n' +
      'Open this link to finish creating your account. Your account is not ' +
      'created until you do:\n\n' +
      `${verifyUrl}\n\n` +
      `The link expires in ${ttlHours} hours.\n` +
      "If you didn't request this, you can ignore this email — nothing was created.\n",
  };
}

/**
 * Sent when someone tries to register an address that already has an account.
 *
 * This mail is what lets the endpoint answer identically either way: the
 * person who owns the address still finds out, while the caller learns
 * nothing. It deliberately carries no link to click — there is nothing to
 * confirm, and a recipient who did not do this should not be handed an action.
 */
export function alreadyRegisteredEmail(to: string, signInUrl: string): MailMessage {
  const safeUrl = escapeHtml(signInUrl);
  return {
    to,
    subject: 'Someone tried to sign up with your email',
    html:
      WRAPPER_OPEN +
      '<h2 style="font-size:18px;margin:0 0 12px">Your address is already registered</h2>' +
      '<p style="margin:0 0 20px">Someone just tried to create an account with this ' +
      'email address. It already has an account, so nothing changed and no new ' +
      'account was created.</p>' +
      `<p style="margin:0 0 20px">If that was you, sign in instead: ` +
      `<a href="${safeUrl}" style="color:#0070f3">${safeUrl}</a></p>` +
      '<p style="margin:0;color:#777;font-size:13px">If it was not you, no action is ' +
      'needed — your account and password are untouched.</p>' +
      WRAPPER_CLOSE,
    text:
      'Your address is already registered\n\n' +
      'Someone just tried to create an account with this email address. It ' +
      'already has an account, so nothing changed and no new account was created.\n\n' +
      `If that was you, sign in instead: ${signInUrl}\n\n` +
      'If it was not you, no action is needed — your account and password are untouched.\n',
  };
}
