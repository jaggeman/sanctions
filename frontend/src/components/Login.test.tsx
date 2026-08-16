import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Login from './Login';

/**
 * Login.tsx calls the browser fetch API directly, not the apiFetch wrapper
 * (frontend/src/apiFetch.ts) issue #38/PR #57 added elsewhere — this file's
 * fetch calls aren't routed through that wrapper. Not this issue's concern,
 * just why the stubbing here mirrors App.test.tsx's plain-fetch style rather
 * than ApiTokensTab.test.tsx's apiFetch-aware one.
 */
function stubFetch(impl: (url: string, body: any) => { ok: boolean; body?: any }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      const { ok, body: responseBody } = impl(url, body);
      return { ok, json: async () => responseBody } as Response;
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('Login — request-otp step', () => {
  it('disables "Send code" until an email is entered', () => {
    render(<Login onLoggedIn={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Send code' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'a@b.com' } });
    expect(screen.getByRole('button', { name: 'Send code' })).not.toBeDisabled();
  });

  it('advances to the code step on a successful request', async () => {
    stubFetch((url) => {
      expect(url).toContain('/api/auth/request-otp');
      return { ok: true, body: { ok: true } };
    });

    render(<Login onLoggedIn={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'a@b.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));

    await waitFor(() => expect(screen.getByLabelText('6-digit code')).toBeInTheDocument());
    expect(screen.getByText('Enter the code sent to a@b.com.')).toBeInTheDocument();
  });

  it('submits on Enter in the email field, same as clicking "Send code"', async () => {
    stubFetch(() => ({ ok: true, body: { ok: true } }));

    render(<Login onLoggedIn={vi.fn()} />);
    const field = screen.getByLabelText('Email address');
    fireEvent.change(field, { target: { value: 'a@b.com' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(screen.getByLabelText('6-digit code')).toBeInTheDocument());
  });

  it('shows the server error message when the request fails', async () => {
    stubFetch(() => ({ ok: false, body: { error: 'A code was already sent recently.' } }));

    render(<Login onLoggedIn={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'a@b.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));

    await waitFor(() => expect(screen.getByText('A code was already sent recently.')).toBeInTheDocument());
    // Stays on the email step — no code field appeared.
    expect(screen.queryByLabelText('6-digit code')).not.toBeInTheDocument();
  });

  it('falls back to a generic message when the error response body is not valid JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => { throw new Error('not json'); } }) as unknown as Response),
    );

    render(<Login onLoggedIn={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'a@b.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));

    await waitFor(() => expect(screen.getByText('Failed to send login code.')).toBeInTheDocument());
  });

  it('disables the email field and shows a spinner while the request is in flight', async () => {
    let resolveFetch: (value: any) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; })),
    );

    render(<Login onLoggedIn={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'a@b.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));

    expect(screen.getByLabelText('Email address')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send code' })).toBeDisabled();

    resolveFetch({ ok: true, json: async () => ({ ok: true }) });
    await waitFor(() => expect(screen.getByLabelText('6-digit code')).toBeInTheDocument());
  });
});

describe('Login — verify-otp step', () => {
  async function advanceToCodeStep(email = 'a@b.com') {
    stubFetch(() => ({ ok: true, body: { ok: true } }));
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: email } });
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    await waitFor(() => expect(screen.getByLabelText('6-digit code')).toBeInTheDocument());
  }

  it('disables "Verify & sign in" until a 6-digit code is entered', async () => {
    render(<Login onLoggedIn={vi.fn()} />);
    await advanceToCodeStep();

    const verifyButton = screen.getByRole('button', { name: 'Verify & sign in' });
    expect(verifyButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '12345' } });
    expect(verifyButton).toBeDisabled(); // 5 digits, not yet 6

    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '123456' } });
    expect(verifyButton).not.toBeDisabled();
  });

  it('calls onLoggedIn with the email on a successful verify', async () => {
    const onLoggedIn = vi.fn();
    render(<Login onLoggedIn={onLoggedIn} />);
    await advanceToCodeStep('a@b.com');

    stubFetch((url, body) => {
      expect(url).toContain('/api/auth/verify-otp');
      expect(body).toEqual({ email: 'a@b.com', code: '123456' });
      return { ok: true, body: { ok: true } };
    });
    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify & sign in' }));

    await waitFor(() => expect(onLoggedIn).toHaveBeenCalledWith('a@b.com'));
  });

  it('submits on Enter in the code field, same as clicking "Verify & sign in"', async () => {
    const onLoggedIn = vi.fn();
    render(<Login onLoggedIn={onLoggedIn} />);
    await advanceToCodeStep('a@b.com');

    stubFetch(() => ({ ok: true, body: { ok: true } }));
    const field = screen.getByLabelText('6-digit code');
    fireEvent.change(field, { target: { value: '123456' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(onLoggedIn).toHaveBeenCalledWith('a@b.com'));
  });

  it('shows the error and does not call onLoggedIn when the code is wrong', async () => {
    const onLoggedIn = vi.fn();
    render(<Login onLoggedIn={onLoggedIn} />);
    await advanceToCodeStep('a@b.com');

    stubFetch(() => ({ ok: false, body: { error: 'Invalid or expired code.' } }));
    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify & sign in' }));

    await waitFor(() => expect(screen.getByText('Invalid or expired code.')).toBeInTheDocument());
    expect(onLoggedIn).not.toHaveBeenCalled();
  });

  it('"Use a different email" resets back to the email step, clearing the code and any error', async () => {
    render(<Login onLoggedIn={vi.fn()} />);
    await advanceToCodeStep('a@b.com');

    stubFetch(() => ({ ok: false, body: { error: 'Invalid or expired code.' } }));
    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify & sign in' }));
    await waitFor(() => expect(screen.getByText('Invalid or expired code.')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Use a different email' }));

    expect(screen.getByLabelText('Email address')).toBeInTheDocument();
    expect(screen.queryByLabelText('6-digit code')).not.toBeInTheDocument();
    expect(screen.queryByText('Invalid or expired code.')).not.toBeInTheDocument();
  });
});

describe('Login — remember email between logins (issue #182)', () => {
  it('prefills the email field from localStorage on mount if present', () => {
    localStorage.setItem('sanctions.lastLoginEmail', 'saved@example.com');
    render(<Login onLoggedIn={vi.fn()} />);

    const emailInput = screen.getByLabelText('Email address') as HTMLInputElement;
    expect(emailInput.value).toBe('saved@example.com');
  });

  it('starts with an empty email field when nothing is stored in localStorage', () => {
    render(<Login onLoggedIn={vi.fn()} />);

    const emailInput = screen.getByLabelText('Email address') as HTMLInputElement;
    expect(emailInput.value).toBe('');
  });

  it('saves the email to localStorage on successful OTP verification', async () => {
    const onLoggedIn = vi.fn();
    render(<Login onLoggedIn={onLoggedIn} />);

    stubFetch((url) => {
      if (url.includes('/api/auth/request-otp')) return { ok: true, body: { ok: true } };
      if (url.includes('/api/auth/verify-otp')) return { ok: true, body: { ok: true } };
      return { ok: false };
    });

    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'user@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));

    await waitFor(() => expect(screen.getByLabelText('6-digit code')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify & sign in' }));

    await waitFor(() => expect(onLoggedIn).toHaveBeenCalledWith('user@example.com'));
    expect(localStorage.getItem('sanctions.lastLoginEmail')).toBe('user@example.com');
  });

  it('"Use a different email" resets in-progress OTP step but does NOT clear remembered email from localStorage', async () => {
    localStorage.setItem('sanctions.lastLoginEmail', 'previous@example.com');
    render(<Login onLoggedIn={vi.fn()} />);

    stubFetch(() => ({ ok: true, body: { ok: true } }));
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));

    await waitFor(() => expect(screen.getByLabelText('6-digit code')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Use a different email' }));

    expect(screen.getByLabelText('Email address')).toBeInTheDocument();
    expect(localStorage.getItem('sanctions.lastLoginEmail')).toBe('previous@example.com');
  });
});
