import { Component, type ReactNode, type ErrorInfo } from 'react';
import { Box, Typography, Button, Alert } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class TabErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[TabErrorBoundary] Caught error while loading tab component:', error, errorInfo);
  }

  handleReload = () => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <Box sx={{ p: 4, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
          <Alert severity="warning" sx={{ width: '100%', maxWidth: 600 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }} gutterBottom>
              Failed to load tab content
            </Typography>
            <Typography variant="body2" sx={{ mb: 2 }}>
              A new version of the app may be available, or your connection was interrupted while loading this section.
            </Typography>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              <Button
                variant="contained"
                size="small"
                startIcon={<RefreshIcon />}
                onClick={this.handleReload}
              >
                Reload Application
              </Button>
              <Button
                variant="outlined"
                size="small"
                onClick={this.handleRetry}
              >
                Try Again
              </Button>
            </Box>
          </Alert>
        </Box>
      );
    }

    return this.props.children;
  }
}
