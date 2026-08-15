import nodemailer, { Transporter } from 'nodemailer';

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST) return null;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  return transporter;
}

export async function sendOtpEmail(email: string, code: string): Promise<void> {
  const t = getTransporter();

  if (!t) {
    // No SMTP configured yet (e.g. local dev before real credentials are added) —
    // fall back to logging so the flow is still usable end-to-end.
    console.log(`[auth] SMTP not configured — OTP for ${email} is ${code}`);
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
