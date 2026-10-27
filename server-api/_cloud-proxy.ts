import type { ApiRequest, ApiResponse } from './_http.js';

export async function forwardToCloud(
  req: ApiRequest,
  res: ApiResponse,
  resource: string,
  cloudOrigin: string,
  cloudToken: string,
): Promise<void> {
  const url = new URL(`/api/${resource}`, cloudOrigin);
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value === 'string') url.searchParams.set(key, value);
    else if (Array.isArray(value)) value.forEach(item => url.searchParams.append(key, item));
  }

  try {
    const response = await fetch(url, {
      method: req.method,
      headers: {
        Authorization: cloudToken,
        ...(req.method !== 'GET' && req.method !== 'DELETE' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(req.method !== 'GET' && req.method !== 'DELETE' ? { body: JSON.stringify(req.body || {}) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.text();
    if (response.status === 204 || !body.trim()) {
      res.status(response.status).end();
      return;
    }

    let payload: unknown;
    try { payload = JSON.parse(body); }
    catch { payload = { error: 'Cloud service returned an invalid response.' }; }
    res.status(response.status).json(payload);
  } catch {
    res.status(502).json({ error: 'Cloud service is unavailable. Try again when the connection is restored.' });
  }
}

export function cloudConnection(req: ApiRequest): { origin: string; token: string } | null {
  const origin = process.env.ANDA_CLOUD_API_ORIGIN?.trim().replace(/\/+$/, '');
  const authorization = req.headers['x-cloud-authorization'];
  const token = Array.isArray(authorization) ? authorization[0] : authorization;
  return origin && token ? { origin, token } : null;
}

export function isCloudConfigured(): boolean {
  return Boolean(process.env.ANDA_CLOUD_API_ORIGIN?.trim());
}