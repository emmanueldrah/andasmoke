import type { ApiRequest, ApiResponse } from './_http.js';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { adminSessions } from '../src/db/schema.js';
import { requireAdmin } from './_auth.js';
import { AUDIT_ACTIONS, recordAudit } from './_audit.js';

const allowedRoles = ['Super Admin', 'Store Manager', 'Inventory Dispatcher', 'Cashier'] as const;
type AdminRole = typeof allowedRoles[number];

const safeAccount = (account: typeof adminSessions.$inferSelect) => ({
  id: account.id,
  fullName: account.adminName,
  email: account.email,
  phone: account.phone,
  role: account.adminRole,
  isActive: account.isActive,
  lastLoginAt: account.lastLoginAt,
  createdAt: account.createdAt,
});

function roleFromRequest(role: unknown): AdminRole {
  if (role === 'cashier' || role === 'Cashier') return 'Cashier';
  if (role === 'manager' || role === 'Store Manager') return 'Store Manager';
  if (role === 'super_admin' || role === 'Super Admin') return 'Super Admin';
  return 'Inventory Dispatcher';
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  const session = await requireAdmin(req, res);
  if (!session) return;

  try {
    if (req.method === 'GET') {
      if (session.adminRole !== 'Super Admin') {
        return res.status(403).json({ error: 'Only Super Admins can view team accounts' });
      }
      const accounts = await db.select().from(adminSessions);
      return res.status(200).json(accounts.map(safeAccount));
    }

    const id = typeof req.query.id === 'string' ? req.query.id : undefined;
    if (req.method === 'POST') {
      if (session.adminRole !== 'Super Admin') {
        return res.status(403).json({ error: 'Only Super Admins can create team accounts' });
      }
      const { fullName, email, phone, role, pin } = req.body || {};
      if (!fullName || !email || !pin || String(pin).length < 4) {
        return res.status(400).json({ error: 'Name, email, and a PIN of at least 4 characters are required' });
      }
      const pinHash = await bcrypt.hash(String(pin), 12);
      const [created] = await db.insert(adminSessions).values({
        adminName: String(fullName).trim(),
        email: String(email).trim().toLowerCase(),
        phone: String(phone || '').trim(),
        adminRole: roleFromRequest(role),
        pinHash,
      }).returning();

      await recordAudit(session, {
        action: AUDIT_ACTIONS.ACCOUNT_CHANGED,
        entityType: 'admin_session',
        entityId: created.id,
        metadata: { event: 'created', email: created.email, role: created.adminRole },
      });

      return res.status(201).json(safeAccount(created));
    }

    if (!id) return res.status(400).json({ error: 'Account id is required' });
    const [target] = await db.select().from(adminSessions).where(eq(adminSessions.id, id)).limit(1);
    if (!target) return res.status(404).json({ error: 'Admin account not found' });

    if (req.method === 'PATCH') {
      if (session.adminRole !== 'Super Admin' && target.id !== session.sub) {
        return res.status(403).json({ error: 'Only Super Admins can manage other team accounts' });
      }
      const { fullName, email, phone, role, isActive, pin, currentPin } = req.body || {};
      if (target.id === session.sub && (role !== undefined || isActive === false)) {
        return res.status(400).json({ error: 'You cannot change your own role or deactivate your own account' });
      }
      if (pin) {
        if (!currentPin || !(await bcrypt.compare(String(currentPin), target.pinHash))) {
          return res.status(401).json({ error: 'Current PIN is incorrect' });
        }
      }
      const updates: Partial<typeof adminSessions.$inferInsert> = {};
      if (fullName !== undefined) updates.adminName = String(fullName).trim();
      if (email !== undefined) updates.email = String(email).trim().toLowerCase();
      if (phone !== undefined) updates.phone = String(phone).trim();
      if (role !== undefined) updates.adminRole = roleFromRequest(role);
      if (isActive !== undefined) updates.isActive = Boolean(isActive);
      if (pin) updates.pinHash = await bcrypt.hash(String(pin), 12);
      const [updated] = await db.update(adminSessions).set(updates).where(eq(adminSessions.id, id)).returning();

      await recordAudit(session, {
        action: AUDIT_ACTIONS.ACCOUNT_CHANGED,
        entityType: 'admin_session',
        entityId: id,
        metadata: {
          event: 'updated',
          email: updated.email,
          previousRole: target.adminRole,
          role: updated.adminRole,
          previousIsActive: Boolean(target.isActive),
          isActive: Boolean(updated.isActive),
          pinChanged: Boolean(pin),
        },
      });

      return res.status(200).json(safeAccount(updated));
    }

    if (req.method === 'DELETE') {
      if (session.adminRole !== 'Super Admin') {
        return res.status(403).json({ error: 'Only Super Admins can delete team accounts' });
      }
      if (target.id === session.sub) return res.status(400).json({ error: 'You cannot delete your own account' });
      await db.delete(adminSessions).where(eq(adminSessions.id, id));

      await recordAudit(session, {
        action: AUDIT_ACTIONS.ACCOUNT_CHANGED,
        entityType: 'admin_session',
        entityId: id,
        metadata: { event: 'deleted', email: target.email, role: target.adminRole },
      });

      return res.status(204).end();
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    if (error?.code === '23505') return res.status(409).json({ error: 'An admin account with this email already exists' });
    console.error('Admin accounts API error:', error);
    return res.status(500).json({ error: 'Admin account operation failed' });
  }
}