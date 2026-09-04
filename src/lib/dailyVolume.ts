// Stock daily-volume context for the dashboard: latest day's volume plus the
// 30-day average and ratio. During market hours daily_bars still reflects
// T-1 until the post-close job runs, hence the "Last close" label.

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

interface DailyVolumeStats {
  latestVolume: number | null;
  latestDate: string | null;
  avgVolume30d: number | null;
  ratio: number | null;
}

const EMPTY: DailyVolumeStats = {
  latestVolume: null,
  latestDate: null,
  avgVolume30d: null,
  ratio: null,
};

export function useDailyVolume(symbol: string): DailyVolumeStats {
  const query = useQuery<DailyVolumeStats>({
    queryKey: ["daily_volume", symbol],
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const data = await api.get<{ date: string; volume: number | string | null }[]>(
        `/api/bars/daily/${symbol}?limit=31&order=desc`,
      );
      const rows = data
        .map((r) => ({ date: r.date, volume: Number(r.volume) }))
        .filter((r) => Number.isFinite(r.volume));
      if (rows.length === 0) return EMPTY;
      const latestVolume = rows[0].volume;
      const latestDate = rows[0].date;
      // Average of the prior 30 days so the ratio reads "today vs typical".
      const prior = rows.slice(1, 31);
      const avgVolume30d = prior.length > 0 ? prior.reduce((s, r) => s + r.volume, 0) / prior.length : null;
      const ratio = avgVolume30d && avgVolume30d > 0 ? latestVolume / avgVolume30d : null;
      return { latestVolume, latestDate, avgVolume30d, ratio };
    },
  });
  return query.data ?? EMPTY;
}
