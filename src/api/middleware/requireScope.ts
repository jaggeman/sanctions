import { Request, Response, NextFunction, RequestHandler } from 'express';
import { verifyApiToken, ApiTokenScope, TokenVerificationResult } from '../../shared/apiTokens';
import { bindLogIdentity } from './requestLogger';

declare module 'express-serve-static-core' {
  interface Request {
    apiTokenId?: string;
    userEmail?: string;
  }
}

function extractBearerToken(req: Request): string | undefined {
  const header = req.header('authorization');
  if (!header || !header.startsWith('Bearer ')) {
    return undefined;
  }
  return header.slice('Bearer '.length).trim();
}

function messageFor(reason: TokenVerificationResult['reason']): string {
  switch (reason) {
    case 'missing':
      return 'Missing Authorization: Bearer <token> header.';
    case 'not_found':
      return 'Invalid API token.';
    case 'revoked':
      return 'This API token has been revoked.';
    case 'insufficient_scope':
      return 'This API token does not have the required scope.';
    case 'no_owner_email':
      return 'This API token predates owner-attribution support and cannot be used for write access. Revoke it and mint a new token.';
    default:
      return 'Unauthorized.';
  }
}

export function requireScope(scope: ApiTokenScope): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const rawToken = extractBearerToken(req);
    const result = await verifyApiToken(rawToken, scope);

    if (!result.valid) {
      const status = result.reason === 'insufficient_scope' ? 403 : 401;
      res.status(status).json({ error: messageFor(result.reason) });
      return;
    }

    req.apiTokenId = result.tokenId;
    req.userEmail = result.ownerEmail;
    bindLogIdentity(req, { tokenId: result.tokenId, userEmail: result.ownerEmail });
    next();
  };
}
