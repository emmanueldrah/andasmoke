/**
 * POS service health.
 *
 * In the desktop app the loopback API proxies to the hosted service, so this
 * check reflects whether online account and sales operations can proceed.
 *
 * Kept as a small module the renderer can pull in, so it does not depend on any
 * Node built-ins at bundle time.
 */

export type ServerHealth = {
  /** True when the configured POS API answered recently. */
  ok: boolean;
  /** How long the last successful check was, in milliseconds. */
  latencyMs: number | null;
  /** ISO instant of the last success. */
  lastOkAt: string | null;
  /** Set once the app has checked at least once. */
  checked: boolean;
};

const CHECK_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 2_500;

const state: ServerHealth = {
  ok: false,
  latencyMs: null,
  lastOkAt: null,
  checked: false,
};

let timer: ReturnType<typeof setInterval> | null = null;

/** One check. Never rejects: a failure is an answer, not an error. */
export async function checkLocalServer(path = '/api/health'): Promise<ServerHealth> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(path, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`health check returned ${response.status}`);
    state.ok = true;
    state.latencyMs = Date.now() - startedAt;
    state.lastOkAt = new Date().toISOString();
  } catch {
    // The POS API is unreachable, so online operations are unavailable.
    state.ok = false;
    state.latencyMs = null;
  } finally {
    clearTimeout(timeout);
    state.checked = true;
  }
  return { ...state };
}

/** Starts polling. Safe to call more than once. */
export function startHealthChecks(path?: string): void {
  if (timer) return;
  void checkLocalServer(path);
  timer = setInterval(() => void checkLocalServer(path), CHECK_INTERVAL_MS);
}

export function stopHealthChecks(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/** The last known state, without making a request. */
export function currentHealth(): ServerHealth {
  return { ...state };
}

/** Routes for the health endpoint the renderer and tests poll. */
export function isHealthRoute(pathname: string): boolean {
  return pathname === '/api/health' || pathname === '/api/health/';
}