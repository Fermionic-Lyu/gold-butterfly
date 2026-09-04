import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import { api } from "../lib/api";
import { fmtCurrency, fmtDate, fmtPct } from "../lib/format";
import type { EarningsEvent } from "../lib/earningsDates";
import { isMarketLive, useMarketStatus } from "../lib/marketHours";

interface Bar {
  // For daily ranges this is a YYYY-MM-DD; for 1D it's the bar's full ISO ts.
  date: string;
  close: number;
  volume: number;
}

// Calendar-day lookbacks for the daily-bar ranges. daily_bars is current to
// T-1 during the session; "1D" reads minute_bars.
const RANGES: { id: string; label: string; days?: number }[] = [
  { id: "1d", label: "1D" },
  { id: "1m", label: "1M", days: 32 },
  { id: "3m", label: "3M", days: 95 },
  { id: "6m", label: "6M", days: 185 },
  { id: "1y", label: "1Y", days: 370 },
];

export default function PriceChart({
  symbol,
  earnings = [],
}: {
  symbol: string;
  earnings?: EarningsEvent[];
}) {
  const [range, setRange] = useState("1d");
  const marketStatus = useMarketStatus();

  // Daily bars: one fetch per symbol; 1M/3M/6M/1Y are client-side slices.
  const dailyQuery = useQuery<Bar[]>({
    queryKey: ["daily_bars", symbol],
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const since = new Date();
      since.setUTCDate(since.getUTCDate() - 370);
      const rows = await api.get<any[]>(
        `/api/bars/daily/${symbol}?since=${since.toISOString().slice(0, 10)}&limit=2000`,
      );
      return rows.map((r) => ({
        date: String(r.date).slice(0, 10),
        close: Number(r.close),
        volume: Number(r.volume ?? 0),
      }));
    },
  });
  const allDaily = dailyQuery.data ?? [];

  // Intraday: polls every 30s during market hours. useQuery keeps the last
  // good rows on a refetch failure so a long-idle tab doesn't blank out.
  const intradayQuery = useQuery<Bar[]>({
    queryKey: ["minute_bars_latest_session", symbol],
    refetchInterval: () => (isMarketLive() ? 30_000 : false),
    refetchIntervalInBackground: false,
    queryFn: async () => {
      const data = await api.get<any[]>(`/api/bars/minute/${symbol}?limit=500`);
      const rows = data.slice().reverse(); // ascending
      const lastDate = rows.length > 0 ? String(rows[rows.length - 1].ts).slice(0, 10) : null;
      const sessionRows = lastDate ? rows.filter((r) => String(r.ts).slice(0, 10) === lastDate) : [];
      return sessionRows.map((r) => ({
        date: r.ts as string,
        close: Number(r.close),
        volume: Number(r.volume ?? 0),
      }));
    },
  });
  const intraday = intradayQuery.data ?? [];

  // Surface only persistent errors (no data at all); a transient refetch
  // failure over cached data shouldn't flash red.
  const dailyErr = !dailyQuery.data && dailyQuery.error ? String(dailyQuery.error?.message ?? dailyQuery.error) : null;
  const intradayErr =
    !intradayQuery.data && intradayQuery.error ? String(intradayQuery.error?.message ?? intradayQuery.error) : null;
  const err = range === "1d" ? intradayErr : dailyErr;
  const dailyLoaded = !dailyQuery.isPending;
  const intradayLoaded = !intradayQuery.isPending;

  const bars = useMemo<Bar[]>(() => {
    if (range === "1d") return intraday;
    const days = RANGES.find((r) => r.id === range)?.days ?? 185;
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    return allDaily.filter((b) => b.date >= cutoffStr);
  }, [range, allDaily, intraday]);

  const data = useMemo(
    () =>
      bars.map((b) => ({
        t: new Date(b.date).getTime(),
        close: b.close,
      })),
    [bars],
  );

  // ER markers inside the rendered window only.
  const earningsMarkers = useMemo(() => {
    if (data.length === 0 || earnings.length === 0) return [];
    const minT = data[0].t;
    const maxT = data[data.length - 1].t;
    return earnings
      .map((e) => ({ ...e, t: new Date(e.date + "T16:00:00Z").getTime() }))
      .filter((e) => e.t >= minT && e.t <= maxT);
  }, [earnings, data]);

  // Headline price stays anchored to the most recent close regardless of range.
  const latestPrice = useMemo(() => {
    if (intraday.length > 0) return intraday[intraday.length - 1].close;
    if (allDaily.length > 0) return allDaily[allDaily.length - 1].close;
    return null;
  }, [intraday, allDaily]);

  const lastPriceAt = useMemo<string | null>(() => {
    if (intraday.length > 0) return intraday[intraday.length - 1].date;
    if (allDaily.length > 0) return allDaily[allDaily.length - 1].date;
    return null;
  }, [intraday, allDaily]);

  const summary = useMemo(() => {
    if (latestPrice === null || bars.length < 1) return null;
    const first = bars[0].close;
    const change = latestPrice - first;
    const pct = first > 0 ? change / first : 0;
    return { first, last: latestPrice, change, pct };
  }, [bars, latestPrice]);

  const isUp = summary !== null && summary.change >= 0;
  const lineColor = isUp ? "#34d399" : "#fb7185";
  const fetchLoaded = range === "1d" ? intradayLoaded : dailyLoaded;

  return (
    <div className="flex flex-col h-full min-h-[140px]">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          {summary ? (
            <>
              <div className="flex items-center gap-2 flex-wrap text-xs text-neutral-500">
                <div className="text-2xl font-semibold tabular-nums text-neutral-100">
                  {fmtCurrency(summary.last)}
                </div>
                {lastPriceAt && (
                  <>
                    <span className="text-neutral-700">·</span>
                    <span>Updated at {fmtDate(lastPriceAt)}</span>
                  </>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap mt-1">
                <span className={`text-xs tabular-nums ${isUp ? "text-emerald-300" : "text-rose-300"}`}>
                  {isUp ? "▲" : "▼"} {fmtCurrency(Math.abs(summary.change))} ({isUp ? "+" : ""}
                  {fmtPct(summary.pct, 2)})
                </span>
                {!marketStatus.loading && !isMarketLive() && (
                  <span className="inline-flex items-center gap-1.5 pill text-[10px] bg-neutral-800 text-neutral-300 border border-neutral-700">
                    <span className="w-1.5 h-1.5 rounded-full bg-neutral-500" />
                    Market Closed
                  </span>
                )}
              </div>
            </>
          ) : (
            <div className="text-[10px] uppercase tracking-wider text-neutral-500">Price</div>
          )}
        </div>
        <div className="flex gap-0.5 shrink-0">
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setRange(r.id)}
              className={`text-[11px] px-2 py-0.5 rounded ${
                range === r.id ? "bg-gold-400/15 text-gold-200" : "text-neutral-500 hover:text-neutral-200"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-[100px] w-full">
        {!fetchLoaded ? (
          <div className="h-full flex items-center justify-center text-[11px] text-neutral-500">Loading…</div>
        ) : err ? (
          <div className="h-full flex items-center justify-center text-[11px] text-rose-400">{err.slice(0, 80)}</div>
        ) : data.length === 0 ? (
          <div className="h-full flex items-center justify-center text-[11px] text-neutral-500">
            No price history available.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
            <AreaChart data={data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={`px-${symbol}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={lineColor} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#262626" strokeDasharray="3 3" />
              <XAxis
                dataKey="t"
                type="number"
                domain={["dataMin", "dataMax"]}
                tick={{ fontSize: 10, fill: "#525252" }}
                tickFormatter={(v) =>
                  range === "1d"
                    ? new Date(v).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
                    : new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric" })
                }
                minTickGap={48}
              />
              <YAxis
                tick={{ fontSize: 10, fill: "#525252" }}
                domain={["auto", "auto"]}
                tickFormatter={(v) => `$${v.toFixed(0)}`}
                width={40}
              />
              <Tooltip
                contentStyle={{ background: "#171717", border: "1px solid #404040", fontSize: 11 }}
                labelStyle={{ color: "#a3a3a3" }}
                formatter={(v: any) => [fmtCurrency(v), "Close"]}
                labelFormatter={(v) =>
                  range === "1d"
                    ? new Date(v).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })
                    : new Date(v).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
                }
              />
              <Area
                type="monotone"
                dataKey="close"
                stroke={lineColor}
                strokeWidth={1.6}
                fill={`url(#px-${symbol})`}
                isAnimationActive
                animationDuration={350}
                animationEasing="ease-out"
              />
              {earningsMarkers.map((e) => (
                <ReferenceLine
                  key={e.date}
                  x={e.t}
                  stroke="#fbbf24"
                  strokeOpacity={0.7}
                  strokeDasharray="3 3"
                  ifOverflow="hidden"
                  label={{ value: "ER", position: "insideTopRight", fill: "#fbbf24", fontSize: 9 }}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
