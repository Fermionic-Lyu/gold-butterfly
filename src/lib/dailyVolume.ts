// Stock daily-volume context for the dashboard. Reads the last ~31 rows
// from daily_bars and exposes the latest day's volume plus the 30-day
// average and ratio. Useful for spotting unusual-activity days at a
// glance (ratio > 1.5× often coincides with a catalyst).
//
// During market hours, daily_bars still reflects T-1 until the post-close
// scheduler fires at 22:00 UTC. That's a known consequence of the EOD
// architecture — the metric is labeled "Last close" to be honest about it.

import { useQuery } from "@tanstack/react-query";
import { insforge } from "./insforge";

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
  // daily_bars updates once per session post-close, so a session-long
  // cache is fine. We compute the stats inside the queryFn so consumers
  // get the derived shape ready to render.
  const query = useQuery<DailyVolumeStats>({
    queryKey: ["daily_volume", symbol],
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const { data, error } = await insforge.database
        .from("daily_bars")
        .select("date,volume")
        .eq("symbol", symbol)
        .order("date", { ascending: false })
        .limit(31);
      if (error) throw error;
      const rows = ((data as { date: string; volume: number | string }[]) ?? [])
        .map((r) => ({ date: r.date, volume: Number(r.volume) }))
        .filter((r) => Number.isFinite(r.volume));
      if (rows.length === 0) return EMPTY;
      const latestVolume = rows[0].volume;
      const latestDate = rows[0].date;
      // Average of the *prior* 30 days, excluding the latest, so the
      // ratio is "today vs typical" rather than "today vs including-today".
      const prior = rows.slice(1, 31);
      const avgVolume30d =
        prior.length > 0
          ? prior.reduce((s, r) => s + r.volume, 0) / prior.length
          : null;
      const ratio =
        avgVolume30d && avgVolume30d > 0 ? latestVolume / avgVolume30d : null;
      return { latestVolume, latestDate, avgVolume30d, ratio };
    },
  });
  return query.data ?? EMPTY;
}
