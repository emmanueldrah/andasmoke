const API_BASE = import.meta.env.VITE_API_BASE || '/api';

class ApiError extends Error {
  constructor(public status: number, message: string, public data?: any) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  endpoint: string,
  options: RequestInit = {},
  authToken?: string | null,
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  // Every API request belongs to the staff-only POS application.
  let token = authToken;
  if (token === undefined) {
    token = localStorage.getItem('anda_auth_token');
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000); // 30 second timeout
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      cache: options.cache,
      headers,
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err?.name === 'AbortError') {
      throw new ApiError(408, 'Request timed out. Please check your connection and try again.');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    if ((response.status === 401 || response.status === 403) && typeof window !== 'undefined') {
      const adminToken = localStorage.getItem('anda_auth_token');
      const isAdminToken = Boolean(token && adminToken === token);
      if (response.status === 401 || isAdminToken) {
        localStorage.removeItem('anda_auth_token');
        localStorage.removeItem('anda_admin_session');
        window.dispatchEvent(new CustomEvent('anda-auth-expired', { detail: { tokenKey: 'anda_auth_token' } }));
      }
    }
    throw new ApiError(response.status, data.error || 'Request failed', data);
  }

  return data;
}

export const api = {
  get: <T>(endpoint: string, authToken?: string | null) => request<T>(endpoint, { method: 'GET' }, authToken),
  post: <T>(endpoint: string, body: any, authToken?: string | null) => request<T>(endpoint, {
    method: 'POST',
    body: JSON.stringify(body),
  }, authToken),
  /** Updates existing settings, rather than creating. */
  put: <T>(endpoint: string, body: any, authToken?: string | null) => request<T>(endpoint, {
    method: 'PUT',
    body: JSON.stringify(body),
  }, authToken),
  patch: <T>(endpoint: string, body: any, authToken?: string | null) => request<T>(endpoint, {
    method: 'PATCH',
    body: JSON.stringify(body),
  }, authToken),
  delete: <T>(endpoint: string, authToken?: string | null) => request<T>(endpoint, { method: 'DELETE' }, authToken),
};

export { ApiError };
