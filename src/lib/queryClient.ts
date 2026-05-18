import { QueryClient } from "@tanstack/react-query";

// Single shared client for the app. Defaults tuned for this dashboard's
// access pattern:
// - staleTime 30s: most polling fetchers tick every 30s already; under
//   that, repeated mounts (e.g., re-opening the watchlist drawer) reuse
//   the cached result instead of refetching immediately.
// - gcTime 5min: keep unused query data around long enough that a quick
//   symbol switch back doesn't re-fetch from scratch.
// - refetchOnWindowFocus true: matches the previous manual
//   visibility-change handlers in PriceChart/WatchlistDrawer; data
//   refreshes when the user returns to the tab.
// - retry: 2 with exponential backoff so a transient hiccup (sleeping
//   laptop, blinking wifi) recovers instead of surfacing as an error.
// - placeholderData identity: by default, a refetch error preserves the
//   previously-rendered data instead of clearing the chart to an empty
//   state — this is the exact bug that motivated the migration.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: true,
      retry: 2,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      placeholderData: (prev: unknown) => prev,
    },
  },
});
