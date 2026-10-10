import type { ApiRequest, ApiResponse } from '../server-api/_http.js';
import { getCloudPool } from '../server-api/cloud-db.js';

export default async function handler(_req: ApiRequest, res: ApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!process.env.DATABASE_URL) return res.status(503).json({ ok: false, storage: 'cloud', error: 'DATABASE_URL is not configured.' });
    await getCloudPool().query('SELECT 1');
    return res.status(200).json({ ok: true, storage: 'cloud' });
  } catch {
    return res.status(503).json({ ok: false, storage: 'cloud', error: 'Cloud database is unavailable.' });
  }
}
