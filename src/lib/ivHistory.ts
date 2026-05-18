import { useQuery } from "@tanstack/react-query";
import { insforge } from "./insforge";

export interface IvHistoryPoint {
  captured_at: string;
  atm_iv: number | null;
  spot: number | null;
  hv30: number | null;
}

export interface IvRankResult {
  rank: number | null; // 0..1, percentile of current IV in the [min, max] range
  percentile: number | null; // 0..1, fraction of historical samples below current
  min: number | null;
  max: number | null;
  mean: number | null;
  samples: number;
  windowDays: number;
}

// Don't compute IV Rank until we have enough samples AND enough range.
// Below either threshold the rank is misleading — for example NVDA after
// 24 hours of data has 14 samples spanning ~1.6 percentage points, and
// any small move shifts the percentile by 30+. That noise reads as
// "cheap vol" or "rich vol" when really it's "we have no idea yet".
const MIN_SAMPLES_FOR_RANK = 30;
const MIN_RANGE_FOR_RANK = 0.05; // 5 percentage points

export function computeIvRank(
  history: IvHistoryPoint[],
  currentIv: number | null,
  windowDays = 252,
): IvRankResult {
  const cutoff = Date.now() - windowDays * 86_400_000;
  const ivs: number[] = [];
  for (const p of history) {
    if (typeof p.atm_iv !== "number" || !Number.isFinite(p.atm_iv)) continue;
    if (new Date(p.captured_at).getTime() < cutoff) continue;
    ivs.push(p.atm_iv);
  }
  const min = ivs.length ? Math.min(...ivs) : null;
  const max = ivs.length ? Math.max(...ivs) : null;
  const mean = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null;
  const range = min !== null && max !== null ? max - min : 0;
  const enoughData =
    ivs.length >= MIN_SAMPLES_FOR_RANK &&
    range >= MIN_RANGE_FOR_RANK &&
    currentIv !== null;
  if (!enoughData) {
    return {
      rank: null,
      percentile: null,
      min,
      max,
      mean,
      samples: ivs.length,
      windowDays,
    };
  }
  const rank = range > 0 ? (currentIv! - min!) / range : null;
  const below = ivs.filter((x) => x <= currentIv!).length;
  const percentile = below / ivs.length;
  return { rank, percentile, min, max, mean, samples: ivs.length, windowDays };
}

export function useIvHistory(symbol: string) {
  // IV snapshots are appended a few times per day per symbol; one fetch
  // when the user lands on a symbol is plenty. The query is gated on
  // symbol so navigating elsewhere doesn't refetch.
  const query = useQuery<IvHistoryPoint[]>({
    queryKey: ["iv_history", symbol],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const cutoff = new Date();
      cutoff.setUTCDate(cutoff.getUTCDate() - 380);
      const { data, error } = await insforge.database
        .from("iv_snapshots")
        .select("captured_at,atm_iv,spot,hv30")
        .eq("symbol", symbol)
        .gte("captured_at", cutoff.toISOString())
        .order("captured_at", { ascending: true })
        .limit(5000);
      if (error) throw error;
      return (data ?? []) as IvHistoryPoint[];
    },
  });
  return { history: query.data ?? [], loading: query.isPending };
}
