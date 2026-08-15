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

interface LoginProps {
  onLoggedIn: (email: string) => void;
}

function Login({ onLoggedIn }: LoginProps) {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
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
          <Typography variant="h5" gutterBottom sx={{ fontWeight: 'bold' }}>
            Sanctions Intelligence
          </Typography>
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
