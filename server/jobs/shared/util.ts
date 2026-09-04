export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function addDays(d: Date, n: number): Date {
  const next = new Date(d);
  next.setUTCDate(next.getUTCDate() + n);
  return next;
}

export const ymd = (d: Date): string => d.toISOString().slice(0, 10);

export function errMsg(e: unknown, max = 300): string {
  return String((e as any)?.message ?? e).slice(0, max);
}

// Run `fn` over `items` with at most `limit` in flight. Results keep input order.
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// Batches of `size` run in parallel, with a pause between batches — the shape
// Alpaca's per-minute budget wants.
export async function chunkedAll<T, R>(
  items: T[],
  size: number,
  delayMs: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    out.push(...(await Promise.all(batch.map(fn))));
    if (i + size < items.length && delayMs > 0) await sleep(delayMs);
  }
  return out;
}

export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
