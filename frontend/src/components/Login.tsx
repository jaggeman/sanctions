import { useState } from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  TextField,
  Button,
  Alert,
  CircularProgress,
} from '@mui/material';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';

const LAST_LOGIN_EMAIL_KEY = 'sanctions.lastLoginEmail';

interface LoginProps {
  onLoggedIn: (email: string) => void;
}

function Login({ onLoggedIn }: LoginProps) {
  const [step, setStep] = useState<'email' | 'code'>('email');
  // issue #182: Prefill email from client-side localStorage if previously remembered.
  const [email, setEmail] = useState(() => {
    try {
      return localStorage.getItem(LAST_LOGIN_EMAIL_KEY) || '';
    } catch {
      return '';
    }
  });
  const [code, setCode] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestCode = async () => {
    if (!email) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/request-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to send login code.');
      }
      setStep('code');
    } catch (err: any) {
      setError(err.message || 'Failed to send login code.');
    }
    setIsLoading(false);
  };

  const verifyCode = async () => {
    if (!code) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Invalid or expired code.');
      }
      // issue #182: Persist last successfully verified email for client-side prefill.
      try {
        localStorage.setItem(LAST_LOGIN_EMAIL_KEY, email);
      } catch {
        // Ignore localStorage quota or security errors (e.g. private browsing mode)
      }
      onLoggedIn(email);
    } catch (err: any) {
      setError(err.message || 'Invalid or expired code.');
    }
    setIsLoading(false);
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Card sx={{ maxWidth: 400, width: '100%', p: 2 }}>
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
            <ShieldOutlinedIcon sx={{ color: 'primary.main', fontSize: 28 }} />
            <Typography variant="h5" sx={{ fontWeight: 700, letterSpacing: '-0.01em' }}>
              Sanctions Intelligence
            </Typography>
          </Box>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            {step === 'email'
              ? 'Sign in with a one-time code sent to your email.'
              : `Enter the code sent to ${email}.`}
          </Typography>

          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}

          {step === 'email' ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <TextField
                fullWidth
                type="email"
                label="Email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && requestCode()}
                disabled={isLoading}
                autoFocus
              />
              <Button
                variant="contained"
                size="large"
                onClick={requestCode}
                disabled={isLoading || !email}
                startIcon={isLoading ? <CircularProgress size={20} color="inherit" /> : undefined}
              >
                Send code
              </Button>
            </Box>
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <TextField
                fullWidth
                label="6-digit code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && verifyCode()}
                disabled={isLoading}
                autoFocus
                slotProps={{ htmlInput: { maxLength: 6, inputMode: 'numeric' } }}
              />
              <Button
                variant="contained"
                size="large"
                onClick={verifyCode}
                disabled={isLoading || code.length !== 6}
                startIcon={isLoading ? <CircularProgress size={20} color="inherit" /> : undefined}
              >
                Verify & sign in
              </Button>
              <Button
                variant="text"
                size="small"
                onClick={() => {
                  // issue #182: "Use a different email" resets the in-progress OTP
                  // step/code for this session so the user can retype a different address.
                  // It deliberately does NOT clear localStorage; only a fresh successful
                  // login will update the remembered email.
                  setStep('email');
                  setCode('');
                  setError(null);
                }}
                disabled={isLoading}
              >
                Use a different email
              </Button>
            </Box>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}

export default Login;
