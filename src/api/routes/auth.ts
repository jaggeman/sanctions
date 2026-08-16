import { Router } from 'express';
import { createOtp, verifyOtp, isInCooldown } from '../../auth/otpStore';
import { consumeGlobalOtpBudget, consumeIpOtpBudget } from '../../auth/otpBudget';
import { sendOtpEmail } from '../../auth/mailer';
import { createSession, destroySession } from '../../auth/session';
import { requireAuth, SESSION_COOKIE_NAME } from '../../auth/middleware';
import { isAdminEmail } from '../../auth/admins';
import { isAllowedEmail } from '../../auth/emailAllowlist';
import { TEST_LOGIN_EMAIL, TEST_LOGIN_CODE, isTestLoginEnabled, isTestLoginEmail } from '../../auth/testAccount';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

export const authRouter = Router();

/**
 * POST /api/auth/request-otp
 * Generates and emails a one-time login code.
 */
authRouter.post('/request-otp', async (req, res): Promise<any> => {
  const { email } = req.body;

  if (!email || typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
    return res.status(400).json({ error: 'A valid "email" is required.' });
  }

  if (isTestLoginEnabled() && isTestLoginEmail(email)) {
    console.log(`[auth] Test login code for ${TEST_LOGIN_EMAIL} is ${TEST_LOGIN_CODE}`);
    return res.json({ ok: true });
  }

  // issue #33: reject an address whose domain isn't allow-listed with the
  // SAME response as a real send — no email, no OTP created, but nothing in
  // the response reveals that. Checked here (not just in verify-otp) so this
  // endpoint can't be used to email codes to arbitrary strangers, which is a
  // spam vector independent of the access question.
  if (!isAllowedEmail(email)) {
    return res.json({ ok: true });
  }

  // issue #144 & issue #62: per-IP rate limiting and global send budget.
  // Both budgets are only charged if the request is not already blocked by
  // the per-email cooldown, preventing an attacker flooding a single address
  // from exhausting either budget for other addresses.
  if (!(await isInCooldown(email))) {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    if (!(await consumeIpOtpBudget(clientIp))) {
      return res.status(429).json({ error: 'Too many login codes have been requested from this IP address. Please try again shortly.' });
    }
    if (!(await consumeGlobalOtpBudget())) {
      return res.status(429).json({ error: 'Too many login codes have been requested. Please try again shortly.' });
    }
  }

  // Narrow, accepted race: two concurrent first-ever requests for the same
  // brand-new email can both pass isInCooldown (neither sees the other's
  // write yet), each consuming a global-budget slot. createOtp itself has
  // the same pre-existing non-atomic read-then-write shape for its own
  // cooldown check, so this doesn't introduce a new class of gap — just
  // inherits the existing one, and is low-probability/low-impact enough
  // not to warrant a cross-document transaction here.
  const code = await createOtp(email);
  if (!code) {
    return res.status(429).json({ error: 'A code was already sent recently. Please wait before requesting another.' });
  }

  try {
    await sendOtpEmail(email, code);
    res.json({ ok: true });
  } catch (error: any) {
    console.error('Failed to send OTP email:', error);
    res.status(500).json({ error: 'Failed to send login code. Please try again.' });
  }
});

/**
 * POST /api/auth/verify-otp
 * Verifies a one-time code and starts a session.
 */
authRouter.post('/verify-otp', async (req, res): Promise<any> => {
  const { email, code } = req.body;

  if (!email || typeof email !== 'string' || !code || typeof code !== 'string') {
    return res.status(400).json({ error: '"email" and "code" are required.' });
  }

  const isTestLogin = isTestLoginEnabled() && isTestLoginEmail(email) && code === TEST_LOGIN_CODE;

  // issue #33: same allow-list check as request-otp, defense in depth — even
  // if a valid code somehow exists for a disallowed address, it can't be
  // exchanged for a session. Same 401 shape as an invalid/expired code.
  if (!isTestLogin && (!isAllowedEmail(email) || !(await verifyOtp(email, code)))) {
    return res.status(401).json({ error: 'Invalid or expired code.' });
  }

  const sessionId = await createSession(email.trim().toLowerCase());
  res.cookie(SESSION_COOKIE_NAME, sessionId, SESSION_COOKIE_OPTIONS);
  res.json({ ok: true });
});

/**
 * GET /api/auth/session
 * Returns the currently logged-in email plus admin status (isAdminEmail(),
 * checked fresh from ADMIN_EMAILS on every call — see src/auth/admins.ts,
 * issue #17), or 401 if not authenticated.
 */
authRouter.get('/session', requireAuth, (req, res) => {
  const email = (req as any).userEmail;
  res.json({ email, isAdmin: isAdminEmail(email) });
});

/**
 * POST /api/auth/logout
 * Deliberately not gated by requireAuth (issue #108, explicit decision):
 * it only ever destroys the session matching whatever `SESSION_COOKIE_NAME`
 * cookie the caller presents, so at most a caller logs out their own (possibly
 * already-invalid) session — there is no cross-account effect to guard
 * against, and requiring a still-valid session just to end that session
 * would reject the exact "my session already looks broken" case logout
 * exists to recover from.
 */
authRouter.post('/logout', async (req, res) => {
  const sessionId = req.cookies?.[SESSION_COOKIE_NAME];
  if (sessionId) await destroySession(sessionId);
  res.clearCookie(SESSION_COOKIE_NAME);
  res.json({ ok: true });
});
