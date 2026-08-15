import { Router } from 'express';
import { createOtp, verifyOtp } from '../../auth/otpStore';
import { sendOtpEmail } from '../../auth/mailer';
import { createSession, destroySession } from '../../auth/session';
import { requireAuth, SESSION_COOKIE_NAME } from '../../auth/middleware';
import { isAdminEmail } from '../../auth/admins';
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

  if (!isTestLogin && !(await verifyOtp(email, code))) {
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
 */
authRouter.post('/logout', async (req, res) => {
  const sessionId = req.cookies?.[SESSION_COOKIE_NAME];
  if (sessionId) await destroySession(sessionId);
  res.clearCookie(SESSION_COOKIE_NAME);
  res.json({ ok: true });
});
