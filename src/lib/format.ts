export function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

export function fmtCurrency(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { notation: "compact" });
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// Title-case for badge / pill labels: capitalize the first letter of
// every whitespace-separated word, leave the rest of each word alone.
// Use for dynamic badge content like agent focus, strategy names,
// action labels, etc. — "iron condor" → "Iron Condor",
// "skip outranked" → "Skip Outranked". Skip on technical identifiers
// that should stay lowercase (LLM model slugs like "openai/gpt-5.4",
// OCC symbols, tickers).
export function capitalize(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/(^|\s)(\S)/g, (_m, sp, c) => sp + c.toUpperCase());
}
