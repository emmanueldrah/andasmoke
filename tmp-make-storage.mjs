/**
 * Dev-only helper: builds a Playwright storage state file that signs the
 * browser in as the local audit account, in light or dark mode.
 * Usage: node tmp-make-storage.mjs <light|dark> <out.json>
 */
const BASE = 'http://127.0.0.1:4310';
const APP_ORIGIN = 'http://127.0.0.1:3000';

const mode = process.argv[2] === 'dark' ? 'dark' : 'light';
const out = process.argv[3] || `tmp-storage-${mode}.json`;

const res = await fetch(`${BASE}/api/auth?action=admin`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'audit@andasmoke.local', pin: '246810' }),
});
if (!res.ok) throw new Error('login failed: ' + res.status);
const { token, admin } = await res.json();

const sessionPayload = {
  isLoggedIn: true,
  adminId: admin.id,
  adminName: admin.adminName,
  adminRole: admin.adminRole,
  email: admin.email,
  avatar: admin.avatar || null,
};

const state = {
  cookies: [],
  origins: [
    {
      origin: APP_ORIGIN,
      localStorage: [
        { name: 'anda_auth_token', value: token },
        { name: 'anda_admin_session', value: JSON.stringify(sessionPayload) },
        { name: 'anda_theme_mode', value: mode },
      ],
    },
  ],
};

const { writeFileSync } = await import('node:fs');
writeFileSync(out, JSON.stringify(state, null, 2));
console.log('wrote', out, 'as', admin.adminName, mode);
