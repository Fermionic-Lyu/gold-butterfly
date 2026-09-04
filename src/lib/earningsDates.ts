import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

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
  const query = useQuery<EarningsEvent[]>({
    queryKey: ["earnings_dates", symbol],
    enabled: !!symbol,
    staleTime: 60 * 60_000,
    queryFn: async () => {
      // 13 months back covers the 1Y chart; a year forward covers slow filers.
      const since = new Date();
      since.setUTCDate(since.getUTCDate() - 400);
      const until = new Date();
      until.setUTCDate(until.getUTCDate() + 365);
      const rows = await api.get<any[]>(
        `/api/earnings/${symbol}?from=${since.toISOString().slice(0, 10)}&to=${until.toISOString().slice(0, 10)}`,
      );
      return rows.map((r) => ({
        date: String(r.date).slice(0, 10),
        epsEstimate: r.eps_estimate == null ? null : Number(r.eps_estimate),
        epsActual: r.eps_actual == null ? null : Number(r.eps_actual),
      }));
    },
  });
  const events = query.data ?? [];
  // AMC announcements on today's date still count as "next" — the move hasn't happened yet.
  const next = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return events.find((e) => e.date >= today) ?? null;
  }, [events]);
  return { events, next, loading: query.isPending };
}
