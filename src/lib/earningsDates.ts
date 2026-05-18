import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { insforge } from "./insforge";

export interface EarningsEvent {
  date: string; // YYYY-MM-DD
  epsEstimate: number | null;
  epsActual: number | null;
}

export function useEarningsDates(symbol: string | undefined): {
  events: EarningsEvent[];
  next: EarningsEvent | null;
  loading: boolean;
} {
  // Earnings data refreshes once a day; a per-symbol query cached for the
  // session avoids redundant fetches when the user navigates back to the
  // same symbol. Disabled when no symbol is set so we don't fire the
  // request from non-symbol routes.
  const query = useQuery<EarningsEvent[]>({
    queryKey: ["earnings_dates", symbol],
    enabled: !!symbol,
    staleTime: 60 * 60_000,
    queryFn: async () => {
      // Pull 13 months back (covers the 1Y chart) + 1y forward (covers
      // the next ER even for slow filers).
      const since = new Date();
      since.setUTCDate(since.getUTCDate() - 400);
      const until = new Date();
      until.setUTCDate(until.getUTCDate() + 365);
      const { data, error } = await insforge.database
        .from("earnings_dates")
        .select("date,eps_estimate,eps_actual")
        .eq("symbol", symbol!)
        .gte("date", since.toISOString().slice(0, 10))
        .lte("date", until.toISOString().slice(0, 10))
        .order("date", { ascending: true })
        .limit(20);
      if (error) throw error;
      return ((data as any[]) ?? []).map((r) => ({
        date: String(r.date).slice(0, 10),
        epsEstimate: r.eps_estimate == null ? null : Number(r.eps_estimate),
        epsActual: r.eps_actual == null ? null : Number(r.eps_actual),
      }));
    },
  });
  const events = query.data ?? [];
  // Next upcoming ER ≥ today. AMC announcements on today's date still
  // count as "next" since the IV move hasn't happened yet.
  const next = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return events.find((e) => e.date >= today) ?? null;
  }, [events]);
  return { events, next, loading: query.isPending };
}
