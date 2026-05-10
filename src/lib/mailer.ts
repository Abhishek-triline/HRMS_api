/**
 * Mailer stub — Phase 0.
 *
 * MAIL_TRANSPORT=filesystem  → writes .eml file to MAIL_DIR (default /tmp/mail).
 *   Useful for dev/test without a real SMTP server.
 *
 * MAIL_TRANSPORT=smtp        → sends via nodemailer using
 *   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS.
 *
 * Production deployments MUST set MAIL_TRANSPORT=smtp and provide credentials.
 */

import fs from 'fs';
import path from 'path';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { logger } from './logger.js';

export type MailPayload = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

const MAIL_TRANSPORT = process.env['MAIL_TRANSPORT'] ?? 'filesystem';
const MAIL_FROM = process.env['MAIL_FROM'] ?? 'Nexora HRMS <no-reply@triline.in>';
const MAIL_DIR = process.env['MAIL_DIR'] ?? '/tmp/mail';

// Build the nodemailer transporter lazily (only when MAIL_TRANSPORT=smtp)
let smtpTransporter: Transporter | undefined;

function getSmtpTransporter(): Transporter {
  if (!smtpTransporter) {
    smtpTransporter = nodemailer.createTransport({
      host: process.env['SMTP_HOST'],
      port: Number(process.env['SMTP_PORT'] ?? 587),
      auth: {
        user: process.env['SMTP_USER'],
        pass: process.env['SMTP_PASS'],
      },
    });
  }
  return smtpTransporter;
}

/**
 * SEC-009: strip CRLF (and lone CR / lone LF) from values that are interpolated
 * directly into RFC 5322 headers. Without this, a malicious display name or
 * subject containing "\r\nBcc: attacker@evil.com" would inject an extra header.
 * Bodies are NOT sanitised — multi-line text content is legitimate there.
 */
function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function buildEmlContent(payload: MailPayload & { from: string }): string {
  const date = new Date().toUTCString();
  const boundary = `----=_Part_${Date.now()}`;
  const lines: string[] = [
    `From: ${sanitizeHeader(payload.from)}`,
    `To: ${sanitizeHeader(payload.to)}`,
    `Subject: ${sanitizeHeader(payload.subject)}`,
    `Date: ${date}`,
    `MIME-Version: 1.0`,
  ];

  if (payload.html) {
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    lines.push('');
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/plain; charset=utf-8');
    lines.push('');
    lines.push(payload.text);
    lines.push('');
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/html; charset=utf-8');
    lines.push('');
    lines.push(payload.html);
    lines.push('');
    lines.push(`--${boundary}--`);
  } else {
    lines.push('Content-Type: text/plain; charset=utf-8');
    lines.push('');
    lines.push(payload.text);
  }

  return lines.join('\r\n');
}

async function sendViaFilesystem(payload: MailPayload): Promise<void> {
  if (!fs.existsSync(MAIL_DIR)) {
    fs.mkdirSync(MAIL_DIR, { recursive: true });
  }

  const filename = `${Date.now()}_${payload.to.replace(/[^a-z0-9]/gi, '_')}.eml`;
  const filepath = path.join(MAIL_DIR, filename);
  const content = buildEmlContent({ ...payload, from: MAIL_FROM });

  fs.writeFileSync(filepath, content, 'utf8');
  logger.info({ to: payload.to, subject: payload.subject, file: filepath }, 'mail.written');
}

async function sendViaSmtp(payload: MailPayload): Promise<void> {
  const transporter = getSmtpTransporter();
  // SEC-009: nodemailer encodes headers safely on its own, but we still
  // strip CRLF defensively so a tampered subject can't smuggle headers.
  await transporter.sendMail({
    from: sanitizeHeader(MAIL_FROM),
    to: sanitizeHeader(payload.to),
    subject: sanitizeHeader(payload.subject),
    text: payload.text,
    html: payload.html,
  });
  logger.info({ to: payload.to, subject: payload.subject }, 'mail.sent');
}

/**
 * Send an email through the configured transport.
 * In development (MAIL_TRANSPORT=filesystem) the mail is written to MAIL_DIR.
 * Never throws — logs the error and swallows so the caller's flow continues.
 */
export async function sendMail(payload: MailPayload): Promise<void> {
  try {
    if (MAIL_TRANSPORT === 'smtp') {
      await sendViaSmtp(payload);
    } else {
      await sendViaFilesystem(payload);
    }
  } catch (err: unknown) {
    logger.error({ err, to: payload.to, subject: payload.subject }, 'mail.error');
  }
}
