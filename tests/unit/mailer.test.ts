import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockSendMail, mockCreateTransport } = vi.hoisted(() => {
  const mockSendMail = vi.fn(async () => ({ messageId: 'test-message-id' }));
  const mockCreateTransport = vi.fn(() => ({ sendMail: mockSendMail }));
  return { mockSendMail, mockCreateTransport };
});

vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
}));

const { sendOtpEmail, _resetMailerForTests } = await import('../../src/auth/mailer');

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  _resetMailerForTests();
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_PORT;
  delete process.env.SMTP_SECURE;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  delete process.env.SMTP_FROM;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('sendOtpEmail — no SMTP configured', () => {
  it('issue #156: logs the code with redacted domain in non-production, and never touches nodemailer', async () => {
    process.env.NODE_ENV = 'development';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await sendOtpEmail('user@example.com', '123456');

    expect(mockCreateTransport).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('123456'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('*@example.com'));
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('user@example.com'));
    logSpy.mockRestore();
  });

  it('issue #156: throws in production when SMTP is not configured, and never logs the secret code or email', async () => {
    process.env.NODE_ENV = 'production';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(sendOtpEmail('user@example.com', '123456')).rejects.toThrow(/SMTP.*production/i);

    expect(mockCreateTransport).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});

describe('sendOtpEmail — SMTP configured', () => {
  it('creates a transporter with the configured host/port and calls sendMail with the right recipient/subject/body', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_PORT = '2525';
    process.env.SMTP_SECURE = 'true';
    process.env.SMTP_USER = 'smtp-user';
    process.env.SMTP_PASS = 'smtp-pass';
    process.env.SMTP_FROM = 'sender@example.com';

    await sendOtpEmail('user@example.com', '654321');

    expect(mockCreateTransport).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 2525,
      secure: true,
      auth: { user: 'smtp-user', pass: 'smtp-pass' },
    });

    expect(mockSendMail).toHaveBeenCalledWith({
      from: 'sender@example.com',
      to: 'user@example.com',
      subject: expect.stringContaining('login code'),
      text: expect.stringContaining('654321'),
    });
  });

  it('defaults port to 587 when SMTP_PORT is not set', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';

    await sendOtpEmail('user@example.com', '111111');

    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 587 }),
    );
  });

  it('defaults secure to false when SMTP_SECURE is not "true"', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_SECURE = 'yes'; // anything other than the literal string "true"

    await sendOtpEmail('user@example.com', '111111');

    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({ secure: false }),
    );
  });

  it('defaults from to no-reply@sanctions.local when SMTP_FROM is not set', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';

    await sendOtpEmail('user@example.com', '111111');

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'no-reply@sanctions.local' }),
    );
  });

  it('omits auth entirely when neither SMTP_USER nor SMTP_PASS is set', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';

    await sendOtpEmail('user@example.com', '111111');

    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({ auth: undefined }),
    );
  });

  it('omits auth entirely rather than half-populating it when only SMTP_USER is set', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_USER = 'smtp-user';
    // SMTP_PASS deliberately left unset

    await sendOtpEmail('user@example.com', '111111');

    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({ auth: undefined }),
    );
  });

  it('omits auth entirely rather than half-populating it when only SMTP_PASS is set', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_PASS = 'smtp-pass';
    // SMTP_USER deliberately left unset

    await sendOtpEmail('user@example.com', '111111');

    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({ auth: undefined }),
    );
  });

  it('caches the transporter across calls — createTransport is called only once', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_USER = 'smtp-user';
    process.env.SMTP_PASS = 'smtp-pass';

    await sendOtpEmail('first@example.com', '111111');
    await sendOtpEmail('second@example.com', '222222');

    expect(mockCreateTransport).toHaveBeenCalledTimes(1);
    expect(mockSendMail).toHaveBeenCalledTimes(2);
  });

  it('_resetMailerForTests forces a fresh transporter on the next call', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    await sendOtpEmail('first@example.com', '111111');
    expect(mockCreateTransport).toHaveBeenCalledTimes(1);

    _resetMailerForTests();
    await sendOtpEmail('second@example.com', '222222');
    expect(mockCreateTransport).toHaveBeenCalledTimes(2);
  });

  it('propagates a sendMail rejection to the caller rather than swallowing it', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    mockSendMail.mockRejectedValueOnce(new Error('SMTP server unavailable'));

    await expect(sendOtpEmail('user@example.com', '111111')).rejects.toThrow('SMTP server unavailable');
  });
});
