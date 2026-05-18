import { useEffect, useMemo, useRef } from "react";
import type { OptionContract } from "../lib/types";
import { fmtNum, fmtPct } from "../lib/format";

export default function OptionChainTable({
  contracts,
  expiration,
  spot,
}: {
  contracts: OptionContract[];
  expiration: string;
  spot: number | null;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atmRowRef = useRef<HTMLTableRowElement | null>(null);
  const rows = useMemo(() => {
    const strikes = Array.from(
      new Set(contracts.filter((c) => c.expiration === expiration).map((c) => c.strike)),
    ).sort((a, b) => a - b);
    return strikes.map((strike) => {
      const c =
        contracts.find((x) => x.expiration === expiration && x.strike === strike && x.type === "call") ?? null;
      const p =
        contracts.find((x) => x.expiration === expiration && x.strike === strike && x.type === "put") ?? null;
      return { strike, call: c, put: p };
    });
  }, [contracts, expiration]);

  const atmStrike = useMemo(() => {
    if (spot === null || rows.length === 0) return null;
    let best = rows[0].strike;
    let bestDiff = Math.abs(best - spot);
    for (const r of rows) {
      const d = Math.abs(r.strike - spot);
      if (d < bestDiff) {
        bestDiff = d;
        best = r.strike;
      }
    }
    return best;
  }, [rows, spot]);

  // Auto-center the ATM row when expiration / spot / row count changes.
  // We scroll the container manually rather than use `scrollIntoView` so
  // the page outside the chain table doesn't move.
  useEffect(() => {
    const container = scrollRef.current;
    const row = atmRowRef.current;
    if (!container || !row || atmStrike === null) return;
    const target = row.offsetTop - container.clientHeight / 2 + row.clientHeight / 2;
    container.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }, [atmStrike, expiration, rows.length]);

  return (
    <div className="card overflow-hidden">
      <div ref={scrollRef} className="overflow-auto max-h-[640px]">
        <table className="min-w-full text-xs tabular-nums">
          <thead className="bg-neutral-900 text-neutral-400 uppercase tracking-wider sticky top-0">
            <tr>
              <th colSpan={6} className="px-3 py-2 text-center text-emerald-400 border-r border-neutral-800">
                Calls
              </th>
              <th className="px-3 py-2 text-center bg-neutral-800 text-gold-300">Strike</th>
              <th colSpan={6} className="px-3 py-2 text-center text-rose-400 border-l border-neutral-800">
                Puts
              </th>
            </tr>
            <tr className="text-[10px]">
              <th className="px-2 py-1 text-right">Delta</th>
              <th className="px-2 py-1 text-right">Gamma</th>
              <th className="px-2 py-1 text-right">Theta</th>
              <th className="px-2 py-1 text-right">Vega</th>
              <th className="px-2 py-1 text-right">IV</th>
              <th className="px-2 py-1 text-right border-r border-neutral-800">Bid × Ask</th>
              <th className="px-2 py-1 text-center bg-neutral-800"></th>
              <th className="px-2 py-1 text-left border-l border-neutral-800">Bid × Ask</th>
              <th className="px-2 py-1 text-right">IV</th>
              <th className="px-2 py-1 text-right">Vega</th>
              <th className="px-2 py-1 text-right">Theta</th>
              <th className="px-2 py-1 text-right">Gamma</th>
              <th className="px-2 py-1 text-right">Delta</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const isAtm = r.strike === atmStrike;
              return (
                <tr
                  key={r.strike}
                  ref={isAtm ? atmRowRef : undefined}
                  className={`border-t border-neutral-800/60 ${
                    isAtm ? "bg-gold-400/5" : "hover:bg-neutral-900/50"
                  }`}
                >
                  <td className="px-2 py-1 text-right">{fmtNum(r.call?.delta, 3)}</td>
                  <td className="px-2 py-1 text-right">{fmtNum(r.call?.gamma, 4)}</td>
                  <td className="px-2 py-1 text-right">{fmtNum(r.call?.theta, 3)}</td>
                  <td className="px-2 py-1 text-right">{fmtNum(r.call?.vega, 3)}</td>
                  <td className="px-2 py-1 text-right">{fmtPct(r.call?.iv, 1)}</td>
                  <td className="px-2 py-1 text-right border-r border-neutral-800 text-neutral-300">
                    {fmtNum(r.call?.bid)} × {fmtNum(r.call?.ask)}
                  </td>
                  <td
                    className={`px-2 py-1 text-center font-semibold bg-neutral-800 ${
                      isAtm ? "text-gold-300" : "text-neutral-100"
                    }`}
                  >
                    {fmtNum(r.strike, 2)}
                  </td>
                  <td className="px-2 py-1 text-left border-l border-neutral-800 text-neutral-300">
                    {fmtNum(r.put?.bid)} × {fmtNum(r.put?.ask)}
                  </td>
                  <td className="px-2 py-1 text-right">{fmtPct(r.put?.iv, 1)}</td>
                  <td className="px-2 py-1 text-right">{fmtNum(r.put?.vega, 3)}</td>
                  <td className="px-2 py-1 text-right">{fmtNum(r.put?.theta, 3)}</td>
                  <td className="px-2 py-1 text-right">{fmtNum(r.put?.gamma, 4)}</td>
                  <td className="px-2 py-1 text-right">{fmtNum(r.put?.delta, 3)}</td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={13} className="px-3 py-6 text-center text-neutral-500">
                  No contracts for this expiration.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
