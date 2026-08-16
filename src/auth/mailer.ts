import nodemailer, { Transporter } from 'nodemailer';

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST) return null;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 587,
    secure: process.env.SMTP_SECURE === 'true',
    // Both must be set — a lone SMTP_USER (or lone SMTP_PASS) would otherwise
    // half-populate `auth` with an undefined pass/user, which nodemailer
    // treats as "attempt auth with a missing credential" rather than "no
    // auth", failing in a way that's confusing to debug from an env var typo.
    auth: process.env.SMTP_USER && process.env.SMTP_PASS
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  return transporter;
}

export async function sendOtpEmail(email: string, code: string): Promise<void> {
  const t = getTransporter();

  if (!t) {
    // issue #156: In production, missing SMTP configuration must be a hard error,
    // not a silent success with secret codes dumped in plaintext logs.
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SMTP_HOST is not configured in production.');
    }
    // No SMTP configured yet (e.g. local dev before real credentials are added) —
    // fall back to logging so the flow is still usable end-to-end.
    // Redact identifying user part (CLAUDE.md §6: log domain, not full email).
    const domain = email.includes('@') ? email.split('@')[1] : 'unknown';
    console.log(`[auth] SMTP not configured — OTP for *@${domain} is ${code}`);
    return;
  }

  await t.sendMail({
    from: process.env.SMTP_FROM || 'no-reply@sanctions.local',
    to: email,
    subject: 'Your Sanctions Checker login code',
    text: `Your one-time login code is ${code}. It expires in 10 minutes.`,
  });
}

export function _resetMailerForTests(): void {
  transporter = null;
}
