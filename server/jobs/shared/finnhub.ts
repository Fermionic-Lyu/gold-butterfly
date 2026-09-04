import { env } from "../../env.ts";
import { sleep } from "./util.ts";

export const FH_BASE = "https://finnhub.io";

export class FinnhubNotConfigured extends Error {
  constructor() {
    super("FINNHUB_API_KEY not configured");
  }
}

export function requireFinnhub() {
  if (!env.finnhubKey) throw new FinnhubNotConfigured();
}

// Free tier is 60 calls/min and over-rate calls come back 200 + empty rather
// than 429, so paced sequential calls are the only reliable pattern.
let lastCallAt = 0;
export async function finnhubFetch(url: string, minGapMs: number, attempt = 0): Promise<any> {
  const since = Date.now() - lastCallAt;
  if (since < minGapMs) await sleep(minGapMs - since);
  lastCallAt = Date.now();
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  if (res.status === 429 && attempt < 3) {
    await sleep(1200 * Math.pow(2, attempt));
    return finnhubFetch(url, minGapMs, attempt + 1);
  }
  if (!res.ok) throw new Error(`Finnhub ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export const withToken = (url: string) => `${url}&token=${encodeURIComponent(env.finnhubKey)}`;
