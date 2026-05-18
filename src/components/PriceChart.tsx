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
import { insforge } from "../lib/insforge";
import { fmtCurrency, fmtDate, fmtPct } from "../lib/format";
import type { EarningsEvent } from "../lib/earningsDates";
import { isMarketLive, useMarketStatus } from "../lib/marketHours";

interface Bar {
  // For daily ranges this is a YYYY-MM-DD; for 1D it's the bar's full ISO ts.
  date: string;
  close: number;
  volume: number;
}

// Calendar-day lookbacks for the daily-bar ranges. The fetch-daily-bars
// scheduler keeps daily_bars current to T-1; intraday "1D" reads minute_bars.
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

  // Daily bars: one fetch per symbol, kept in the query cache so 1M/3M/6M/1Y
  // tab switches are pure client-side slices off the same dataset.
  // staleTime is large (10 min) because the daily-bars writer only fires
  // once per day; refetchOnWindowFocus stays on (default) so a long-idle
  // tab still re-validates when you come back.
  const dailyQuery = useQuery<Bar[]>({
    queryKey: ["daily_bars", symbol],
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const since = new Date();
      since.setUTCDate(since.getUTCDate() - 370);
      const { data, error } = await insforge.database
        .from("daily_bars")
        .select("date,close,volume")
        .eq("symbol", symbol)
        .gte("date", since.toISOString().slice(0, 10))
        .order("date", { ascending: true })
        .limit(2000);
      if (error) throw error;
      return ((data as any[]) ?? []).map((r) => ({
        date: r.date as string,
        close: Number(r.close),
        volume: Number(r.volume ?? 0),
      }));
    },
  });
  const allDaily = dailyQuery.data ?? [];

  // Intraday: polls every 30s during market hours; outside market hours
  // we still keep the last-known-good rows in the cache so the "Updated
  // at …" timestamp shows the actual last bar (not zero). The previous
  // implementation cleared intraday to [] on any fetch error, which
  // wiped the chart whenever the user returned to a long-idle tab and
  // the SDK's token had expired. useQuery preserves prior data on a
  // refetch failure by default — bug fix.
  const intradayQuery = useQuery<Bar[]>({
    queryKey: ["minute_bars_latest_session", symbol],
    refetchInterval: () => (isMarketLive() ? 30_000 : false),
    refetchIntervalInBackground: false,
    queryFn: async () => {
      const { data, error } = await insforge.database
        .from("minute_bars")
        .select("ts,close,volume")
        .eq("symbol", symbol)
        .order("ts", { ascending: false })
        .limit(500);
      if (error) throw error;
      const rows = ((data as any[]) ?? []).slice().reverse(); // ascending
      const lastDate =
        rows.length > 0 ? String(rows[rows.length - 1].ts).slice(0, 10) : null;
      const sessionRows = lastDate
        ? rows.filter((r) => String(r.ts).slice(0, 10) === lastDate)
        : [];
      return sessionRows.map((r) => ({
        date: r.ts as string,
        close: Number(r.close),
        volume: Number(r.volume ?? 0),
      }));
    },
  });
  const intraday = intradayQuery.data ?? [];

  // Surface only persistent errors (where we have no data at all). A
  // transient refetch failure while we have prior data should not flash
  // an error in the UI — the cached data is fine and useQuery will
  // continue retrying.
  const dailyErr = !dailyQuery.data && dailyQuery.error ? String(dailyQuery.error?.message ?? dailyQuery.error) : null;
  const intradayErr = !intradayQuery.data && intradayQuery.error ? String(intradayQuery.error?.message ?? intradayQuery.error) : null;
  const err = range === "1d" ? intradayErr : dailyErr;
  const dailyLoaded = !dailyQuery.isPending;
  const intradayLoaded = !intradayQuery.isPending;

  // Slice the cached daily bars to the selected range. Switches are O(n)
  // and instant — no spinner, no remount.
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

  // ER markers visible on this chart: only events that fall inside the
  // currently-rendered time window. For 1D we'd only mark earnings ON the
  // session date itself — rare but meaningful (e.g. an AMC report today
  // means the chart you're looking at is the pre-print drift).
  const earningsMarkers = useMemo(() => {
    if (data.length === 0 || earnings.length === 0) return [];
    const minT = data[0].t;
    const maxT = data[data.length - 1].t;
    return earnings
      .map((e) => ({ ...e, t: new Date(e.date + "T16:00:00Z").getTime() }))
      .filter((e) => e.t >= minT && e.t <= maxT);
  }, [earnings, data]);

  // The headline price stays anchored to the most recent close — last
  // minute bar if intraday is loaded, otherwise last daily bar. Switching
  // 1M/3M/6M/1Y does not change this; only the chart shape and the change
  // baseline change with range.
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

  // Effective loading flag for the *selected* range. Avoids flashing
  // "no price history available" before the relevant fetch completes.
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
                <span
                  className={`text-xs tabular-nums ${
                    isUp ? "text-emerald-300" : "text-rose-300"
                  }`}
                >
                  {isUp ? "▲" : "▼"} {fmtCurrency(Math.abs(summary.change))}{" "}
                  ({isUp ? "+" : ""}
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
            <div className="text-[10px] uppercase tracking-wider text-neutral-500">
              Price
            </div>
          )}
        </div>
        <div className="flex gap-0.5 shrink-0">
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setRange(r.id)}
              className={`text-[11px] px-2 py-0.5 rounded ${
                range === r.id
                  ? "bg-gold-400/15 text-gold-200"
                  : "text-neutral-500 hover:text-neutral-200"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-[100px] w-full">
        {!fetchLoaded ? (
          <div className="h-full flex items-center justify-center text-[11px] text-neutral-500">
            Loading…
          </div>
        ) : err ? (
          <div className="h-full flex items-center justify-center text-[11px] text-rose-400">
            {err.slice(0, 80)}
          </div>
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
                    ? new Date(v).toLocaleTimeString(undefined, {
                        hour: "numeric",
                        minute: "2-digit",
                      })
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
                contentStyle={{
                  background: "#171717",
                  border: "1px solid #404040",
                  fontSize: 11,
                }}
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
                    : new Date(v).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })
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
                  label={{
                    value: "ER",
                    position: "insideTopRight",
                    fill: "#fbbf24",
                    fontSize: 9,
                  }}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
