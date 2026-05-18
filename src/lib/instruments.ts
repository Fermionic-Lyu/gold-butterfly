import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { insforge } from "./insforge";

export interface Instrument {
  symbol: string;
  name: string;
  indices: string[];
  logo_url: string | null;
  hv30: number | null;
  market_cap: number | null;
  pe_ratio: number | null;
}

export function useInstruments() {
  // The instruments list updates roughly once a day (index membership +
  // fundamentals refresh). One fetch per app session is plenty;
  // staleTime: Infinity prevents background refetches.
  const query = useQuery<Instrument[]>({
    queryKey: ["instruments"],
    staleTime: Infinity,
    queryFn: async () => {
      const { data, error } = await insforge.database
        .from("instruments")
        .select("symbol,name,indices,logo_url,hv30,market_cap,pe_ratio")
        .order("symbol", { ascending: true });
      if (error) throw error;
      // PostgREST returns NUMERIC as string; coerce the numeric fields.
      return ((data ?? []) as any[]).map((r) => ({
        ...r,
        hv30: r.hv30 == null ? null : Number(r.hv30),
        market_cap: r.market_cap == null ? null : Number(r.market_cap),
        pe_ratio: r.pe_ratio == null ? null : Number(r.pe_ratio),
      })) as Instrument[];
    },
  });
  const list = query.data ?? [];
  const bySymbol = useMemo(() => {
    const m = new Map<string, Instrument>();
    for (const i of list) m.set(i.symbol, i);
    return m;
  }, [list]);
  return { list, bySymbol, loading: query.isPending };
}

export function searchInstruments(list: Instrument[], q: string, limit = 8): Instrument[] {
  const query = q.trim();
  if (!query) return [];
  const upper = query.toUpperCase();
  const lower = query.toLowerCase();
  // Score each instrument: lower is better.
  const scored: { score: number; i: Instrument }[] = [];
  for (const i of list) {
    const sym = i.symbol;
    const nameLower = i.name.toLowerCase();
    let score = Infinity;
    if (sym === upper) score = 0;
    else if (sym.startsWith(upper)) score = 1;
    else if (nameLower.startsWith(lower)) score = 2;
    else if (sym.includes(upper)) score = 3;
    else if (nameLower.includes(lower)) score = 4;
    if (score !== Infinity) scored.push({ score, i });
  }
  scored.sort((a, b) => a.score - b.score || a.i.symbol.localeCompare(b.i.symbol));
  return scored.slice(0, limit).map((x) => x.i);
}
