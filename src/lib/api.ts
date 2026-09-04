// Thin fetch wrapper for the app's own API. Same-origin, cookie session.

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Opts {
  timeoutMs?: number;
}

async function request<T>(method: string, path: string, body?: unknown, opts: Opts = {}): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

export const api = {
  get: <T>(path: string, opts?: Opts) => request<T>("GET", path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: Opts) => request<T>("POST", path, body, opts),
  del: <T>(path: string, opts?: Opts) => request<T>("DELETE", path, undefined, opts),
};
