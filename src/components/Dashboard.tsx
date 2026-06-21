import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { insforge } from "../lib/insforge";
import type { OptionChainResponse } from "../lib/types";
import {
  buildSkewCurve,
  classifyRegime,
  computeChainMetrics,
  daysToExpiration,
  nearestExpiration,
  strategySummary,
} from "../lib/optionsAnalytics";
import { fmtPct, fmtNum, fmtCompact } from "../lib/format";
import { useInstruments } from "../lib/instruments";
import { useAuth } from "../lib/AuthContext";
import { computeIvRank, useIvHistory } from "../lib/ivHistory";
import { useDailyVolume } from "../lib/dailyVolume";
import { useEarningsDates } from "../lib/earningsDates";
import { nextFomcDate } from "../lib/macroEvents";
import { useMarketStatus } from "../lib/marketHours";
import MetricCard from "./MetricCard";
import SymbolPageSkeleton from "./SymbolPageSkeleton";
import PriceChart from "./PriceChart";
import InstrumentLogo from "./InstrumentLogo";
import WatchlistStarButton from "./WatchlistStarButton";
import OptionChainTable from "./OptionChainTable";
import { SkewChart, TermStructureChart } from "./Charts";
import StrategyPanel from "./StrategyPanel";
import NewsPanel from "./NewsPanel";

const HORIZON_PRESETS: { label: string; days: number }[] = [
  { label: "2w", days: 14 },
  { label: "4w", days: 28 },
  { label: "3m", days: 90 },
  { label: "6m", days: 180 },
  { label: "1y", days: 365 },
];

function pickNearest(expirations: string[], targetDays: number): string | null {
  if (!expirations.length) return null;
  let best = expirations[0];
  let bestDiff = Infinity;
  for (const e of expirations) {
    const days = (new Date(e + "T16:00:00Z").getTime() - Date.now()) / 86_400_000;
    const diff = Math.abs(days - targetDays);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = e;
    }
  }
  return best;
}

type Tab = "overview" | "ai" | "news";

export default function Dashboard({ symbol }: { symbol: string }) {
  const [tab, setTab] = useState<Tab>("overview");
  const { user } = useAuth();
  const { bySymbol } = useInstruments();
  const instrument = bySymbol.get(symbol);
  const marketStatus = useMarketStatus();
  const [selectedExp, setSelectedExp] = useState<string | null>(null);

  // Chain view via the get_chain_view Postgres RPC. Single round trip,
  // bypasses PostgREST's max-rows cap, returns the OptionChainResponse
  // shape ready for consumption. useQuery keeps the previous chain
  // mounted during a symbol switch (placeholderData identity in the
  // global default) so the skeleton only shows on the very first load
  // — symbol switches feel snappy.
  const chainQuery = useQuery<OptionChainResponse>({
    queryKey: ["chain_view", symbol],
    queryFn: async () => {
      const { data, error } = await insforge.database.rpc("get_chain_view", {
        p_symbol: symbol,
      });
      if (error) throw error;
      if (!data) {
        throw new Error(
          `No chain data available for ${symbol}. Only Nasdaq-100 symbols are currently tracked.`,
        );
      }
      return data as OptionChainResponse;
    },
  });
  const chain = chainQuery.data ?? null;
  const loading = chainQuery.isPending;
  const err = chainQuery.error ? String(chainQuery.error?.message ?? chainQuery.error) : null;

  // When a new chain lands, pin selectedExp to the nearest-to-30d
  // expiration that's still in the future. Clamp on symbol change so we
  // don't carry over a stale expiration that no longer exists in the
  // new symbol's chain.
  useEffect(() => {
    if (!chain) return;
    const today = new Date().toISOString().slice(0, 10);
    const live = chain.expirations.filter((e) => e >= today);
    setSelectedExp((curr) => {
      if (curr && live.includes(curr)) return curr;
      return nearestExpiration(live, 30);
    });
  }, [chain]);

  // Filter out expirations that have already passed. Strings are YYYY-MM-DD
  // so lexical compare === date compare. Local "today" is fine here — the
  // worst case is a viewer in a far-western timezone briefly seeing today's
  // expiration after the ET close, which is cosmetic only.
  const liveExpirations = useMemo(() => {
    if (!chain) return [] as string[];
    const today = new Date().toISOString().slice(0, 10);
    return chain.expirations.filter((e) => e >= today);
  }, [chain]);

  const metrics = useMemo(() => {
    if (!chain) return null;
    return computeChainMetrics(chain.contracts, liveExpirations, chain.underlying.price);
  }, [chain, liveExpirations]);

  const skewData = useMemo(() => {
    if (!chain || !selectedExp) return [];
    return buildSkewCurve(chain.contracts, selectedExp);
  }, [chain, selectedExp]);

  const { history: ivHistory } = useIvHistory(symbol);
  const dailyVol = useDailyVolume(symbol);
  const { events: earnings, next: nextEarnings } = useEarningsDates(symbol);
  const termStructureMarkers = useMemo(() => {
    const m: { date: string; label: string; color: string }[] = [];
    if (nextEarnings?.date) m.push({ date: nextEarnings.date, label: "ER", color: "#fb7185" });
    const fomc = nextFomcDate();
    if (fomc) m.push({ date: fomc, label: "FOMC", color: "#38bdf8" });
    return m;
  }, [nextEarnings?.date]);
  const ivRank = useMemo(
    () => computeIvRank(ivHistory, metrics?.atmIV ?? null),
    [ivHistory, metrics?.atmIV],
  );

  // HV30 lives on the instruments row, populated daily by fetch-daily-bars
  // (single source of truth shared with the trading-tick worker). Wrap it
  // in the RealizedVol shape the analytics helpers expect.
  const realizedVol = useMemo(
    () =>
      instrument?.hv30 != null
        ? { hv10: null, hv30: instrument.hv30, hv90: null, barCount: 30 }
        : null,
    [instrument?.hv30],
  );

  const regime = useMemo(() => {
    if (!metrics) return null;
    return classifyRegime(metrics, realizedVol, ivRank);
  }, [metrics, realizedVol, ivRank]);

  const aiSummary = useMemo(() => {
    if (!chain || !metrics) return null;
    return strategySummary(
      symbol,
      chain.underlying.price,
      liveExpirations,
      chain.contracts,
      metrics,
      realizedVol,
      ivRank,
    );
  }, [chain, metrics, symbol, ivRank, realizedVol]);

  if (loading && !chain) {
    return <SymbolPageSkeleton symbol={symbol} />;
  }

  if (err && !chain) {
    return (
      <div className="card p-6">
        <div className="text-red-300 font-medium">Couldn't fetch chain for {symbol}</div>
        <div className="text-sm text-red-400/80 mt-1 whitespace-pre-wrap">{err}</div>
        <button onClick={() => chainQuery.refetch()} className="btn-ghost mt-3">
          Retry
        </button>
      </div>
    );
  }

  if (!chain) return null;

  const skewTone = (() => {
    const s = metrics?.putCallSkew;
    if (s === null || s === undefined) return "default" as const;
    if (s > 0.04) return "warn" as const;
    if (s < -0.02) return "good" as const;
    return "default" as const;
  })();

  return (
    <div className="space-y-6">
      <div className="card p-5">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* LEFT: ticker info → metrics → regime, stacked top-down */}
          <div className="flex flex-col gap-5 min-w-0">
            <div className="space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                <InstrumentLogo
                  symbol={symbol}
                  url={instrument?.logo_url}
                  className="w-10 h-10 p-1"
                />
                <h1 className="text-3xl font-bold tracking-tight font-mono text-gold-300">{symbol}</h1>
                {instrument?.name && (
                  <span className="text-base text-neutral-300">{instrument.name}</span>
                )}
                {instrument?.indices?.map((idx) => (
                  <span
                    key={idx}
                    className="pill bg-neutral-800 text-[10px] text-neutral-300 border border-neutral-700"
                  >
                    {idx}
                  </span>
                ))}
                <WatchlistStarButton symbol={symbol} />
                <MarketStatusBadge status={marketStatus} />
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 auto-rows-fr">
              {instrument?.market_cap != null && (
                <MetricCard
                  label="Market Cap"
                  value={`$${fmtCompact(instrument.market_cap)}`}
                />
              )}
              {instrument?.pe_ratio != null && (
                <MetricCard
                  label="P/E (TTM)"
                  value={instrument.pe_ratio.toFixed(1)}
                />
              )}
              <MetricCard label="ATM IV (~30d)" value={fmtPct(metrics?.atmIV)} />
              <MetricCard
                label="IV Rank (1y)"
                value={
                  ivRank.rank !== null
                    ? `${(ivRank.rank * 100).toFixed(0)}%`
                    : "collecting"
                }
                tone={
                  ivRank.rank !== null && ivRank.rank >= 0.5
                    ? "warn"
                    : ivRank.rank !== null && ivRank.rank < 0.3
                      ? "good"
                      : "default"
                }
                hint={
                  ivRank.rank !== null
                    ? `${ivRank.samples} snapshots · ${fmtPct(ivRank.min, 0)}–${fmtPct(ivRank.max, 0)}`
                    : ivRank.samples > 0
                      ? `${ivRank.samples} snapshots · need wider history`
                      : "30-min snapshots"
                }
              />
              <MetricCard
                label="25Δ Skew (P−C)"
                value={metrics?.putCallSkew !== null && metrics?.putCallSkew !== undefined ? `${(metrics.putCallSkew * 100).toFixed(2)} pts` : "—"}
                tone={skewTone}
                hint={
                  metrics?.putCallSkew && metrics.putCallSkew > 0
                    ? "puts richer (downside fear)"
                    : "calls richer (call skew)"
                }
              />
              <MetricCard
                label="Risk Reversal 25Δ"
                value={metrics?.rr25 !== null && metrics?.rr25 !== undefined ? `${(metrics.rr25 * 100).toFixed(2)} pts` : "—"}
              />
              <MetricCard label="P/C Volume Ratio" value={fmtNum(metrics?.putCallVolRatio)} />
              <MetricCard
                label="Last Close Volume"
                value={dailyVol.latestVolume !== null ? fmtCompact(dailyVol.latestVolume) : "—"}
                tone={
                  dailyVol.ratio !== null && dailyVol.ratio >= 1.5
                    ? "warn"
                    : dailyVol.ratio !== null && dailyVol.ratio <= 0.6
                      ? "good"
                      : "default"
                }
                hint={
                  dailyVol.ratio !== null && dailyVol.avgVolume30d !== null
                    ? `${dailyVol.ratio.toFixed(2)}× 30d avg (${fmtCompact(dailyVol.avgVolume30d)})`
                    : "needs price history"
                }
              />
              <MetricCard
                label="IV / HV30"
                value={
                  regime?.ivHvRatio !== null && regime?.ivHvRatio !== undefined
                    ? regime.ivHvRatio.toFixed(2) + "×"
                    : "—"
                }
                tone={
                  regime?.ivRichness === "rich"
                    ? "warn"
                    : regime?.ivRichness === "cheap"
                      ? "good"
                      : "default"
                }
                hint={
                  regime?.ivRichness === "rich"
                    ? "vol is rich — favor selling premium"
                    : regime?.ivRichness === "cheap"
                      ? "vol is cheap — favor buying premium"
                      : regime?.ivRichness === "fair"
                        ? "vol is fairly priced"
                        : realizedVol
                          ? "—"
                          : "needs price history"
                }
              />
            </div>

            {regime && (
              <div className="space-y-3">
                <div className="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">
                  Regime read
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <RegimeCard
                    label="Posture"
                    value={regime.premiumPosture}
                    tone={
                      regime.premiumPosture === "sell_premium"
                        ? "warn"
                        : regime.premiumPosture === "buy_premium"
                          ? "info"
                          : "default"
                    }
                  />
                  <RegimeCard label="Skew" value={regime.skewBias} />
                  <RegimeCard
                    label="Term"
                    value={regime.termShape === "unknown" ? "—" : regime.termShape}
                  />
                  <RegimeCard label="Flow" value={regime.flowBias} />
                </div>
                {regime.notes.length > 0 && (
                  <ul className="text-xs text-neutral-400 leading-relaxed list-disc pl-5 space-y-0.5">
                    {regime.notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* RIGHT: large price-history chart, fills full card height */}
          <div className="h-72 lg:h-full lg:min-h-[420px]">
            <PriceChart symbol={symbol} earnings={earnings} />
          </div>
        </div>
      </div>

      {/* Tab switcher splits the page below the symbol-context card. */}
      <div className="flex items-center justify-center gap-1 border-b border-neutral-800">
        <TabButton active={tab === "overview"} onClick={() => setTab("overview")}>
          Overview
        </TabButton>
        <TabButton active={tab === "ai"} onClick={() => setTab("ai")}>
          AI Analysis
        </TabButton>
        <TabButton active={tab === "news"} onClick={() => setTab("news")}>
          News
        </TabButton>
      </div>

      {tab === "overview" ? (
        <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SkewChart data={skewData} spot={chain.underlying.price} />
        <TermStructureChart
          data={metrics?.termStructure ?? []}
          markers={termStructureMarkers}
        />
      </div>

      <div className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <h2 className="text-lg font-semibold">Option Chain</h2>
          <div className="flex items-center gap-1">
            <span className="text-[10px] uppercase tracking-wider text-neutral-500 mr-1">jump</span>
            {HORIZON_PRESETS.map((p) => {
              const target = pickNearest(liveExpirations, p.days);
              if (!target) return null;
              return (
                <button
                  key={p.label}
                  className={`pill border ${
                    target === selectedExp
                      ? "bg-gold-400/20 border-gold-400/60 text-gold-200"
                      : "bg-neutral-800 border-neutral-700 text-neutral-200 hover:bg-neutral-700"
                  }`}
                  onClick={() => setSelectedExp(target)}
                  title={target}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex gap-1 mb-3 overflow-x-auto pb-1 -mx-1 px-1 scrollbar-thin-themed">
          {liveExpirations.map((e) => (
            <button
              key={e}
              className={`pill border whitespace-nowrap shrink-0 ${
                e === selectedExp
                  ? "bg-gold-400/15 border-gold-400/60 text-gold-200"
                  : "bg-neutral-900 border-neutral-700 text-neutral-300 hover:bg-neutral-800"
              }`}
              onClick={() => setSelectedExp(e)}
            >
              {e} <span className="ml-1 text-[10px] text-neutral-500">{Math.round(daysToExpiration(e))}d</span>
            </button>
          ))}
        </div>
        {selectedExp && (
          <OptionChainTable
            contracts={chain.contracts}
            expiration={selectedExp}
            spot={chain.underlying.price}
          />
        )}
      </div>

        </>
      ) : tab === "ai" ? (
        <>
          {aiSummary ? (
            <StrategyPanel symbol={symbol} userId={user?.id ?? null} summary={aiSummary} />
          ) : (
            <div className="card p-6 text-sm text-neutral-500">
              Loading market context for AI analysis…
            </div>
          )}
        </>
      ) : (
        <NewsPanel symbol={symbol} />
      )}
    </div>
  );
}

// Snake-case regime values → "Title Case With Spaces" for display.
function titleCase(s: string): string {
  return s
    .split("_")
    .map((p) => (p.length > 0 ? p[0].toUpperCase() + p.slice(1) : p))
    .join(" ");
}

function RegimeCard({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "warn" | "info";
}) {
  const valueColor =
    tone === "warn"
      ? "text-amber-300"
      : tone === "info"
        ? "text-sky-300"
        : "text-neutral-400";
  const ringColor =
    tone === "warn"
      ? "border-amber-900/60"
      : tone === "info"
        ? "border-sky-900/60"
        : "border-neutral-800";
  return (
    <div
      className={`rounded-lg border ${ringColor} bg-neutral-900/40 px-3 py-2 text-center`}
    >
      <div className="text-[10px] uppercase tracking-wider font-semibold text-neutral-100">
        {label}
      </div>
      <div className={`text-sm mt-1 ${valueColor}`}>{titleCase(value)}</div>
    </div>
  );
}

function MarketStatusBadge({ status }: { status: ReturnType<typeof useMarketStatus> }) {
  if (status.loading) return null;
  if (!status.isTradingDay) {
    return (
      <span
        className="pill bg-neutral-800 text-[10px] text-neutral-400 border border-neutral-700"
        title="US equity markets are closed today"
      >
        Market closed
      </span>
    );
  }
  if (status.isEarlyClose && status.sessionClose) {
    const closeEt = status.sessionClose.toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
    });
    return (
      <span
        className="pill bg-amber-900/40 text-[10px] text-amber-200 border border-amber-700/60"
        title="Half-day trading session"
      >
        Early close {closeEt} ET
      </span>
    );
  }
  return null;
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
        active
          ? "border-gold-400 text-gold-200"
          : "border-transparent text-neutral-400 hover:text-neutral-100"
      }`}
    >
      {children}
    </button>
  );
}
