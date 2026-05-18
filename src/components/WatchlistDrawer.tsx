import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useSubscriptions } from "../lib/SubscriptionsContext";
import { useInstruments } from "../lib/instruments";
import { useAuth } from "../lib/AuthContext";
import { insforge } from "../lib/insforge";
import { fmtCurrency, fmtPct } from "../lib/format";
import { isMarketLive } from "../lib/marketHours";
import InstrumentLogo from "./InstrumentLogo";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface Quote {
  price: number | null;
  prev_close: number | null;
  change: number | null;
  pct: number | null;
}

export default function WatchlistDrawer({ open, onClose }: Props) {
  const { subscriptions, loading, removeSubscription } = useSubscriptions();
  const { bySymbol } = useInstruments();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { symbol: routeSymbol } = useParams();
  const selectedSymbol = routeSymbol?.toUpperCase() ?? null;

  // Build a stable sorted array so the query key only changes when the
  // watchlist actually changes (not on every parent re-render).
  const symbols = useMemo(
    () =>
      subscriptions
        .map((s) => s.symbol)
        .filter((s) => !s.startsWith("temp-"))
        .sort(),
    [subscriptions],
  );

  // get_watchlist_quotes RPC: handles all session-aware math server-side
  // (ET-date comparisons, right prev_close for every market state).
  // The query is enabled only when the drawer is open AND we have at
  // least one subscribed symbol — closed drawers don't poll.
  const quotesQuery = useQuery<Record<string, Quote>>({
    queryKey: ["watchlist_quotes", symbols],
    enabled: open && !!user && symbols.length > 0,
    refetchInterval: () => (isMarketLive() ? 30_000 : false),
    refetchIntervalInBackground: false,
    queryFn: async () => {
      const { data, error } = await insforge.database.rpc("get_watchlist_quotes", {
        p_symbols: symbols,
      });
      if (error) throw error;
      const view = (data ?? {}) as Record<
        string,
        { price: number | null; prev_close: number | null; price_ts: string | null }
      >;
      const next: Record<string, Quote> = {};
      for (const sym of symbols) {
        const q = view[sym] ?? { price: null, prev_close: null, price_ts: null };
        const price = q.price !== null ? Number(q.price) : null;
        const prevClose = q.prev_close !== null ? Number(q.prev_close) : null;
        const change = price !== null && prevClose !== null ? price - prevClose : null;
        const pct =
          change !== null && prevClose !== null && prevClose > 0 ? change / prevClose : null;
        next[sym] = { price, prev_close: prevClose, change, pct };
      }
      return next;
    },
  });
  const quotes = quotesQuery.data ?? {};

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      <div
        aria-hidden={!open}
        onClick={onClose}
        className={`fixed inset-0 z-40 bg-black/60 transition-opacity ${
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      />
      <aside
        role="dialog"
        aria-label="Watchlist"
        aria-modal="true"
        className={`fixed top-0 right-0 z-50 h-full w-full sm:w-96 bg-neutral-950 border-l border-neutral-800 shadow-2xl transition-transform duration-200 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-800">
          <div>
            <div className="text-sm font-semibold">Watchlist</div>
            <div className="text-[11px] text-neutral-500">
              {subscriptions.length} symbol{subscriptions.length === 1 ? "" : "s"}
            </div>
          </div>
          <button
            type="button"
            className="btn-ghost h-8 w-8 p-0"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto h-[calc(100%-65px)]">
          {!user ? (
            <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
              <p className="text-sm text-neutral-300 mb-3">
                Sign in to save symbols to your watchlist and access AI strategy analysis.
              </p>
              <Link
                to="/auth"
                onClick={onClose}
                className="btn-primary w-full justify-center"
              >
                Sign in
              </Link>
            </div>
          ) : loading ? (
            <p className="text-sm text-neutral-500">Loading…</p>
          ) : subscriptions.length === 0 ? (
            <p className="text-sm text-neutral-500">
              Empty watchlist. Add a ticker from the search bar above (e.g. SPY, AAPL, NVDA).
            </p>
          ) : (
            <ul className="space-y-1">
              {subscriptions.map((s) => {
                const active = s.symbol === selectedSymbol;
                return (
                  <li key={s.id}>
                    <div
                      className={`group flex items-center justify-between gap-3 rounded-lg px-3 py-2 cursor-pointer transition-colors ${
                        active
                          ? "bg-gold-400/10 ring-1 ring-gold-400/40"
                          : "hover:bg-neutral-800"
                      }`}
                      onClick={() => {
                        navigate(`/symbols/${s.symbol}`);
                        onClose();
                      }}
                    >
                      <div className="flex items-center gap-2.5 min-w-0 flex-1">
                        <InstrumentLogo
                          symbol={s.symbol}
                          url={bySymbol.get(s.symbol)?.logo_url}
                          className="w-7 h-7 p-0.5 shrink-0"
                        />
                        <div className="flex flex-col min-w-0">
                          <span className="font-mono font-semibold text-neutral-100">{s.symbol}</span>
                          {bySymbol.get(s.symbol)?.name && (
                            <span className="text-[11px] text-neutral-500 truncate">
                              {bySymbol.get(s.symbol)!.name}
                            </span>
                          )}
                        </div>
                      </div>

                      <QuoteCell quote={quotes[s.symbol]} />
                      <button
                        type="button"
                        className="h-7 w-7 flex items-center justify-center rounded-md text-base text-neutral-500 opacity-0 group-hover:opacity-100 hover:bg-neutral-700 hover:text-rose-300 shrink-0 transition"
                        onClick={(e) => {
                          e.stopPropagation();
                          void removeSubscription(s.id);
                        }}
                        aria-label={`Remove ${s.symbol}`}
                      >
                        ×
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>
    </>
  );
}

function QuoteCell({ quote }: { quote: Quote | undefined }) {
  if (!quote || quote.price === null) {
    // Loading or unavailable — keep the cell shape so rows don't jump.
    return (
      <div className="text-right shrink-0 w-20">
        <div className="h-4 bg-neutral-800/50 rounded animate-pulse" />
      </div>
    );
  }
  const isUp = (quote.change ?? 0) > 0;
  const isFlat = (quote.change ?? 0) === 0;
  const tone = isFlat
    ? "text-neutral-400"
    : isUp
      ? "text-emerald-300"
      : "text-rose-300";
  return (
    <div className="text-right shrink-0 tabular-nums">
      <div className="text-sm font-semibold text-neutral-100">
        {fmtCurrency(quote.price)}
      </div>
      <div className={`text-[11px] ${tone}`}>
        {quote.change !== null && (
          <>
            {isUp ? "▲" : isFlat ? "" : "▼"} {fmtCurrency(Math.abs(quote.change))}
            {quote.pct !== null && (
              <span className="ml-1">
                ({isUp ? "+" : ""}
                {fmtPct(quote.pct, 2)})
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}
