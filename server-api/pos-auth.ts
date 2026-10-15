import type { ApiRequest, ApiResponse } from './_http.js';
import bcrypt from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../src/db/index.js';
import { adminSessions, auditLogs } from '../src/db/schema.js';
import { signStaffSession, verifyToken } from './_auth.js';
import { AUDIT_ACTIONS } from './_audit.js';
import { DEFAULT_IDLE_TIMEOUT_MS, getIdleTimeoutMs, setIdleTimeoutMs } from './pos-settings.js';
import { requireAdmin } from './_auth.js';

const loginSchema = z.object({
  email: z.string().trim().email().max(255),
  pin: z.string().min(4).max(100),
});

/** Wrong PINs tolerated before the account is locked. */
export const MAX_PIN_ATTEMPTS = 5;

/** How long a locked account stays locked. */
export const PIN_LOCKOUT_MINUTES = 5;
const PIN_LOCKOUT_MS = PIN_LOCKOUT_MINUTES * 60 * 1000;

/** Reports how many staff accounts exist, so the UI can show first-run setup. */
async function handleSetupStatus(_req: ApiRequest, res: ApiResponse) {
  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(adminSessions);
  const total = Number(count || 0);
  return res.status(200).json({ needsSetup: total === 0 });
}

/**
 * First-run setup. Creates the single super admin once, then refuses any further
 * calls so nobody can add a second owner by replaying this request.
 */
async function handleSetup(req: ApiRequest, res: ApiResponse) {
  const parsed = z.object({
    name: z.string().trim().min(2).max(100),
    email: z.string().trim().email().max(255),
    pin: z.string().min(4).max(100),
    phone: z.string().trim().max(30).optional(),
  }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Enter a name, a valid email and a PIN of at least 4 characters.', details: parsed.error.flatten() });
  }

  const email = parsed.data.email.toLowerCase();
  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(adminSessions);
  if (Number(count || 0) > 0) {
    return res.status(409).json({ error: 'Setup has already been completed on this till.' });
  }

  const [existing] = await db.select({ id: adminSessions.id }).from(adminSessions).where(eq(adminSessions.email, email)).limit(1);
  if (existing) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }

  const pinHash = await bcrypt.hash(parsed.data.pin, 12);
  const [created] = await db.insert(adminSessions).values({
    adminName: parsed.data.name,
    adminRole: 'Super Admin',
    email,
    phone: parsed.data.phone || '',
    pinHash,
    isActive: true,
  }).returning({ id: adminSessions.id, adminName: adminSessions.adminName, adminRole: adminSessions.adminRole, email: adminSessions.email });

  await db.insert(auditLogs).values({
    action: AUDIT_ACTIONS.ACCOUNT_CHANGED,
    entityType: 'admin_session',
    entityId: created.id,
    actorName: created.adminName,
    metadata: { event: 'first-run-setup', adminId: created.id, email: created.email, role: 'Super Admin' },
  });

  const idleTimeoutMs = getIdleTimeoutMs();

  return res.status(201).json({
    token: signStaffSession({
      sub: created.id,
      email: created.email,
      role: 'admin',
      adminRole: created.adminRole,
      adminName: created.adminName,
    }, idleTimeoutMs),
    idleTimeoutMs,
    admin: { id: created.id, adminName: created.adminName, adminRole: created.adminRole, email: created.email },
  });
}

async function handleAdminLogin(req: ApiRequest, res: ApiResponse) {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Enter your email and PIN.' });
  }

  const email = parsed.data.email.toLowerCase();
  const [admin] = await db.select().from(adminSessions).where(eq(adminSessions.email, email)).limit(1);

  const now = new Date();

  // ── Lockout ─────────────────────────────────────────────────────────────
  // Checked before comparing the PIN so a locked account cannot be probed at
  // all, and so the delay does not depend on guessing the PIN correctly.
  if (admin?.lockedUntil && admin.lockedUntil.getTime() > now.getTime()) {
    const secondsLeft = Math.ceil((admin.lockedUntil.getTime() - now.getTime()) / 1000);
    const minutesLeft = Math.max(1, Math.ceil(secondsLeft / 60));

    await db.insert(auditLogs).values({
      action: AUDIT_ACTIONS.LOGIN_BLOCKED,
      entityType: 'admin_session',
      entityId: email,
      actorName: email,
      // Deliberately no PIN, no hash and no typed value: only the outcome.
      metadata: { adminId: admin.id, secondsLeft, attempts: admin.failedPinAttempts },
    });

    return res.status(429).json({
      error: `Too many wrong PINs. This account is locked for ${minutesLeft} more minute${minutesLeft === 1 ? '' : 's'}.`,
      lockedUntil: admin.lockedUntil.toISOString(),
      secondsLeft,
    });
  }

  let currentAdmin = admin;
  let validPin = currentAdmin ? await bcrypt.compare(parsed.data.pin, currentAdmin.pinHash) : false;

  // If staff member does not exist in local SQLite, try cloud verification
  // and cache their credentials locally so they can log in offline afterwards.
  if (!currentAdmin && process.env.NODE_ENV !== 'test') {
    const cloudOrigin = (process.env.ANDA_CLOUD_API_ORIGIN || 'https://andasmoke.vercel.app').replace(/\/+$/, '');
    try {
      const cloudRes = await fetch(`${cloudOrigin}/api/auth?action=admin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, pin: parsed.data.pin }),
        signal: AbortSignal.timeout(4000),
      });
      if (cloudRes.ok) {
        const cloudData = (await cloudRes.json()) as any;
        if (cloudData?.admin) {
          const pinHash = await bcrypt.hash(parsed.data.pin, 12);
          const [saved] = await db.insert(adminSessions).values({
            adminName: cloudData.admin.adminName || email,
            adminRole: cloudData.admin.adminRole || 'Cashier',
            email: email,
            phone: cloudData.admin.phone || '',
            pinHash,
            isActive: true,
            lastLoginAt: now,
          }).returning();
          currentAdmin = saved;
          validPin = true;
        }
      }
    } catch {
      // Offline, proceed with local check failure
    }
  }

  if (!currentAdmin || !currentAdmin.isActive || !validPin) {
    const attempts = (currentAdmin?.failedPinAttempts || 0) + (currentAdmin ? 1 : 0);
    const locked = attempts >= MAX_PIN_ATTEMPTS;
    const lockedUntil = locked
      ? new Date(now.getTime() + PIN_LOCKOUT_MS)
      : null;

    if (currentAdmin) {
      await db.update(adminSessions)
        .set({ failedPinAttempts: locked ? 0 : attempts, lockedUntil })
        .where(eq(adminSessions.id, currentAdmin.id));
    }

    await db.insert(auditLogs).values({
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      entityType: 'admin_session',
      entityId: email,
      actorName: email,
      metadata: {
        adminId: currentAdmin?.id ?? null,
        attempts: currentAdmin ? attempts : null,
        locked: locked && Boolean(currentAdmin),
        attemptsRemaining: currentAdmin && !locked ? MAX_PIN_ATTEMPTS - attempts : null,
      },
    });

    if (locked && currentAdmin) {
      return res.status(429).json({
        error: `Too many wrong PINs. This account is locked for ${PIN_LOCKOUT_MINUTES} minutes.`,
        lockedUntil: lockedUntil!.toISOString(),
        secondsLeft: PIN_LOCKOUT_MS / 1000,
      });
    }
    return res.status(401).json({ error: 'Incorrect email or PIN.' });
  }

  // A correct PIN clears the failure count and any expired lock.
  await db.update(adminSessions)
    .set({ lastLoginAt: now, failedPinAttempts: 0, lockedUntil: null })
    .where(eq(adminSessions.id, currentAdmin.id));

  const idleTimeoutMs = getIdleTimeoutMs();
  const token = signStaffSession({
    sub: currentAdmin.id,
    email: currentAdmin.email,
    role: 'admin',
    adminRole: currentAdmin.adminRole,
    adminName: currentAdmin.adminName,
  }, idleTimeoutMs);

  await db.insert(auditLogs).values({
    action: AUDIT_ACTIONS.LOGIN,
    entityType: 'admin_session',
    entityId: currentAdmin.id,
    actorName: currentAdmin.adminName,
    metadata: { adminId: currentAdmin.id, adminRole: currentAdmin.adminRole, email: currentAdmin.email },
  });

  return res.status(200).json({
    token,
    idleTimeoutMs,
    admin: {
      id: currentAdmin.id,
      adminName: currentAdmin.adminName,
      adminRole: currentAdmin.adminRole,
      email: currentAdmin.email,
    },
  });
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    const action = typeof req.query.action === 'string' ? req.query.action : '';

    if (req.method === 'GET' && action === 'setup-status') return handleSetupStatus(req, res);
    if (req.method === 'POST' && action === 'setup') return handleSetup(req, res);
    if (req.method === 'POST' && action === 'admin') return handleAdminLogin(req, res);

    // The idle timeout is readable by anyone and settable by a manager, because
    // a till that signs itself out mid-queue needs a way to explain why.
    if (req.method === 'GET' && action === 'idle-timeout') {
      return res.status(200).json({ idleTimeoutMs: getIdleTimeoutMs(), defaultIdleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS });
    }
    if (req.method === 'POST' && action === 'idle-timeout') {
      const manager = await requireAdmin(req, res, ['Super Admin', 'Store Manager']);
      if (!manager) return;
      const requested = Number(req.body?.idleTimeoutMs);
      if (!Number.isFinite(requested) || requested <= 0) {
        return res.status(400).json({ error: 'Enter the idle timeout in milliseconds.' });
      }
      setIdleTimeoutMs(requested);
      return res.status(200).json({ idleTimeoutMs: getIdleTimeoutMs() });
    }

    /**
     * Signs the till out for the day.
     *
     * Used when a shift closes: the till is handed over, and the next person
     * must sign in with their own PIN rather than inheriting a session.
     */
    if (req.method === 'POST' && action === 'sign-out-all') {
      const auth = await requireAdmin(req, res);
      if (!auth) return;
      await db.insert(auditLogs).values({
        action: AUDIT_ACTIONS.SESSION_SIGNED_OUT,
        entityType: 'admin_session',
        entityId: auth.sub,
        actorName: auth.adminName,
        metadata: { reason: typeof req.query.reason === 'string' ? req.query.reason : 'manual' },
      });
      return res.status(200).json({ signedOut: true });
    }

    // Session probe: confirms a saved token is still usable before the register
    // restores itself. Without it the app asked for a route the handler never
    // had, and every reload logged the cashier out with a 405.
    if (req.method === 'GET' && action === 'session') {
      const token = typeof req.headers.authorization === 'string'
        && req.headers.authorization.toLowerCase().startsWith('bearer ')
        ? req.headers.authorization.slice(7).trim()
        : null;
      if (!token) return res.status(401).json({ error: 'Authentication required' });

      try {
        const payload = verifyToken(token);
        const [admin] = await db.select({
          isActive: adminSessions.isActive,
          adminName: adminSessions.adminName,
          adminRole: adminSessions.adminRole,
          email: adminSessions.email,
        }).from(adminSessions).where(eq(adminSessions.id, payload.sub || '')).limit(1);

        if (!admin || !admin.isActive) {
          return res.status(401).json({ error: 'Administrator account is no longer active' });
        }
        return res.status(200).json({
          role: 'admin',
          email: admin.email,
          adminName: admin.adminName,
          adminRole: admin.adminRole,
        });
      } catch (error) {
        console.warn('Session probe rejected:', error instanceof Error ? error.message : error);
        return res.status(401).json({ error: 'Invalid or expired session' });
      }
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    console.error('Auth API error:', error);
    return res.status(500).json({ error: 'Sign-in service is unavailable.' });
  }
}