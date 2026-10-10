import type { ApiRequest, ApiResponse } from './_http.js';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { db, getSetting, setSetting } from '../src/db/index.js';
import { adminSessions } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

/**
 * Signing key for staff sessions.
 *
 * On a standalone till there is no operator to configure an environment
 * variable, so a key is generated once and stored in the database. It only has
 * to be unguessable on this machine, and it must not change or every signed-in
 * cashier is logged out on restart.
 */
function resolveJwtSecret(): string {
  const configured = process.env.JWT_SECRET?.trim();
  if (configured && configured.length >= 32) return configured;
  if (process.env.ANDA_INSECURE_DEV_SECRET === '1') {
    return 'anda-smoke-hub-development-only-secret-key';
  }

  const existing = getSetting('auth.jwtSecret');
  if (existing) return existing;

  const generated = randomBytes(48).toString('base64url');
  setSetting('auth.jwtSecret', generated);
  return generated;
}

const jwtSecret = resolveJwtSecret();

export type AuthSession = {
  sub: string;
  email: string;
  role: 'admin';
  adminRole?: string;
  adminName?: string;
  name?: string;
  iat?: number;
  exp?: number;
};

/**
 * A session that is used is worth keeping; one that sits untouched is not.
 *
 * The idle window is enforced by re-issuing the token with a fresh expiry each
 * time it is used, so an abandoned till drops out while a busy one keeps working
 * all day. The window itself is configurable and read from the database.
 */
export function signToken(
  payload: Record<string, unknown>,
  expiresIn: SignOptions['expiresIn'] = '7d',
) {
  if (!jwtSecret) {
    throw new Error('JWT_SECRET is missing');
  }

  return jwt.sign(payload, jwtSecret, { algorithm: 'HS256', expiresIn });
}

/** Signs a staff session that expires after the till's idle timeout. */
export function signStaffSession(payload: Record<string, unknown>, idleTimeoutMs: number): string {
  return jwt.sign(payload, jwtSecret, {
    algorithm: 'HS256',
    // The idle window is the expiry; a session that is never refreshed simply
    // stops working at that point.
    expiresIn: Math.max(1, Math.floor(idleTimeoutMs / 1000)),
  });
}

export function verifyToken(token: string): AuthSession {
  if (!jwtSecret) {
    throw new Error('JWT_SECRET is missing');
  }

  return jwt.verify(token, jwtSecret, { algorithms: ['HS256'] }) as AuthSession;
}

function getAuthorizationToken(req: ApiRequest) {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }

  return null;
}

export async function requireAuth(req: ApiRequest, res: ApiResponse): Promise<AuthSession | null> {
  const token = getAuthorizationToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }

  try {
    const payload = verifyToken(token);
    const userId = payload.sub;

    if (!userId || payload.role !== 'admin' || typeof payload.email !== 'string') {
      res.status(401).json({ error: 'Invalid token payload' });
      return null;
    }

    const [admin] = await db.select({
      isActive: adminSessions.isActive,
      email: adminSessions.email,
      adminName: adminSessions.adminName,
      adminRole: adminSessions.adminRole,
    }).from(adminSessions).where(eq(adminSessions.id, userId)).limit(1);
    if (!admin || !admin.isActive) {
      res.status(401).json({ error: 'Administrator account is no longer active' });
      return null;
    }
    payload.email = admin.email;
    payload.adminName = admin.adminName;
    payload.adminRole = admin.adminRole;

    return payload;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      console.warn('Expired authentication token rejected');
    } else {
      console.error('Token validation failed:', error);
    }
    res.status(401).json({ error: 'Invalid or expired session' });
    return null;
  }
}

export async function requireAdmin(
  req: ApiRequest,
  res: ApiResponse,
  allowedRoles?: readonly string[],
): Promise<AuthSession | null> {
  const auth = await requireAuth(req, res);
  if (!auth) {
    return null;
  }

  if (auth.role !== 'admin') {
    res.status(403).json({ error: 'Administrator access required' });
    return null;
  }

  if (allowedRoles && !allowedRoles.includes(auth.adminRole || '')) {
    res.status(403).json({ error: 'Your administrator role does not allow this action' });
    return null;
  }

  return auth;
}
