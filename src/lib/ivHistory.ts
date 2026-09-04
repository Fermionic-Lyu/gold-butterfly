import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

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

// Below either threshold the rank is noise: a day of data spanning a couple
// of vol points swings the percentile by 30+ on any small move.
const MIN_SAMPLES_FOR_RANK = 30;
const MIN_RANGE_FOR_RANK = 0.05;

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
  const enoughData = ivs.length >= MIN_SAMPLES_FOR_RANK && range >= MIN_RANGE_FOR_RANK && currentIv !== null;
  if (!enoughData) {
    return { rank: null, percentile: null, min, max, mean, samples: ivs.length, windowDays };
  }
  const rank = range > 0 ? (currentIv! - min!) / range : null;
  const below = ivs.filter((x) => x <= currentIv!).length;
  const percentile = below / ivs.length;
  return { rank, percentile, min, max, mean, samples: ivs.length, windowDays };
}

export function useIvHistory(symbol: string) {
  const query = useQuery<IvHistoryPoint[]>({
    queryKey: ["iv_history", symbol],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const rows = await api.get<any[]>(`/api/iv-history/${symbol}?days=380`);
      return rows.map((r) => ({
        captured_at: r.captured_at,
        atm_iv: r.atm_iv == null ? null : Number(r.atm_iv),
        spot: r.spot == null ? null : Number(r.spot),
        hv30: r.hv30 == null ? null : Number(r.hv30),
      }));
    },
  });
  return { history: query.data ?? [], loading: query.isPending };
}
