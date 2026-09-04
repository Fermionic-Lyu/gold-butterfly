import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { isMarketLive } from "./marketHours";

// Market holidays keyed by YYYY-MM-DD. Value is null for a full closure, or
// the early-close time for half days.
export interface MarketHoliday {
  date: string;
  name: string | null;
  early_close_et: string | null;
}
export function useMarketHolidays() {
  const query = useQuery<Map<string, MarketHoliday>>({
    queryKey: ["market_holidays"],
    staleTime: Infinity,
    queryFn: async () => {
      const rows = await api.get<any[]>("/api/market-holidays");
      const m = new Map<string, MarketHoliday>();
      for (const r of rows) {
        const key = String(r.date).slice(0, 10);
        m.set(key, { date: key, name: r.name ?? null, early_close_et: r.early_close_et ?? null });
      }
      return m;
    },
  });
  return { holidays: query.data ?? new Map<string, MarketHoliday>(), loading: query.isPending };
}

export interface AgentRow {
  id: string;
  slug: string;
  name: string;
  focus: string;
  model: string;
  preset: any;
  watched_symbols: string[];
  starting_capital: number;
  cash: number;
  active: boolean;
  created_at: string;
  user_id: string | null;
}

export interface PositionRow {
  id: string;
  agent_id: string;
  symbol: string;
  strategy: string;
  legs: any[];
  reserved_collateral: number;
  entry_cost: number;
  current_value: number | null;
  exit_proceeds: number | null;
  realized_pnl: number | null;
  status: "open" | "closed" | "expired";
  rationale: string | null;
  opened_at: string;
  closed_at: string | null;
  mtm_at: string | null;
}

export interface DecisionRow {
  id: string;
  agent_id: string;
  symbol: string;
  decided_at: string;
  // ET trading-day key (YYYY-MM-DD) the decision was made *for*.
  run_date: string;
  action: string;
  confidence: number | null;
  reasoning: string | null;
  position_id: string | null;
  validation_notes: string | null;
}

export interface EquitySnapshot {
  agent_id: string;
  recorded_at: string;
  cash: number;
  positions_mtm: number;
  total_equity: number;
  open_positions: number;
}

export interface AgentReturns {
  totalEquity: number;
  totalReturnPct: number | null;
  todayChangeAbs: number | null;
  todayChangePct: number | null;
  prevSessionClose: number | null;
}

function todayUtcMidnight(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function computeReturns(startingCapital: number, snapshots: EquitySnapshot[]): AgentReturns {
  if (snapshots.length === 0) {
    return {
      totalEquity: startingCapital,
      totalReturnPct: 0,
      todayChangeAbs: null,
      todayChangePct: null,
      prevSessionClose: null,
    };
  }
  const sorted = [...snapshots].sort(
    (a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime(),
  );
  const latest = sorted[sorted.length - 1];
  const startMidnight = todayUtcMidnight().getTime();
  const beforeToday = sorted.filter((s) => new Date(s.recorded_at).getTime() < startMidnight);
  const prevClose = beforeToday.length > 0 ? beforeToday[beforeToday.length - 1].total_equity : null;

  const totalReturnPct = (latest.total_equity - startingCapital) / startingCapital;
  let todayChangeAbs: number | null;
  let todayChangePct: number | null;
  if (prevClose !== null && prevClose > 0) {
    todayChangeAbs = latest.total_equity - prevClose;
    todayChangePct = todayChangeAbs / prevClose;
  } else {
    todayChangeAbs = latest.total_equity - startingCapital;
    todayChangePct = todayChangeAbs / startingCapital;
  }
  return {
    totalEquity: latest.total_equity,
    totalReturnPct,
    todayChangeAbs,
    todayChangePct,
    prevSessionClose: prevClose,
  };
}

// Live per-agent state, computed on demand by get_agents_summary so the
// drawer + agent page show intraday MTM rather than the last close.
export interface AgentSummary {
  agent_id: string;
  cash: number;
  starting_capital: number;
  positions_mtm: number;
  total_equity: number;
  open_positions: number;
  prev_session_equity: number | null;
  positions: PositionRow[];
}

export function useAgentsSummary() {
  const query = useQuery<Record<string, AgentSummary>>({
    queryKey: ["agents_summary"],
    refetchInterval: () => (isMarketLive() ? 30_000 : false),
    refetchIntervalInBackground: false,
    queryFn: async () => {
      const raw = await api.get<Record<string, any>>("/api/agents/summary");
      const out: Record<string, AgentSummary> = {};
      for (const [slug, s] of Object.entries(raw ?? {})) {
        out[slug] = {
          agent_id: s.agent_id,
          cash: Number(s.cash),
          starting_capital: Number(s.starting_capital),
          positions_mtm: Number(s.positions_mtm),
          total_equity: Number(s.total_equity),
          open_positions: Number(s.open_positions),
          prev_session_equity: s.prev_session_equity == null ? null : Number(s.prev_session_equity),
          positions: ((s.positions ?? []) as any[]).map((p) => ({
            ...p,
            entry_cost: Number(p.entry_cost),
            current_value: p.current_value == null ? null : Number(p.current_value),
            reserved_collateral: Number(p.reserved_collateral),
            realized_pnl: p.realized_pnl == null ? null : Number(p.realized_pnl),
            exit_proceeds: p.exit_proceeds == null ? null : Number(p.exit_proceeds),
          })) as PositionRow[],
        };
      }
      return out;
    },
  });
  return { summaries: query.data ?? {}, loading: query.isPending };
}

export function computeReturnsFromSummary(s: AgentSummary): AgentReturns {
  const totalReturnPct = (s.total_equity - s.starting_capital) / s.starting_capital;
  const todayBase = s.prev_session_equity ?? s.starting_capital;
  const todayChangeAbs = s.total_equity - todayBase;
  const todayChangePct = todayBase > 0 ? todayChangeAbs / todayBase : null;
  return {
    totalEquity: s.total_equity,
    totalReturnPct,
    todayChangeAbs,
    todayChangePct,
    prevSessionClose: s.prev_session_equity,
  };
}

// Matrix ordering: rows are strategies, columns are models.
const FOCUS_ORDER = ["premium_seller", "long_vol", "directional_momentum"];
const MODEL_ORDER = [
  "anthropic/claude-sonnet-4.6",
  "google/gemini-3.1-pro-preview",
  "openai/gpt-5.4",
];

function matrixSort(a: AgentRow, b: AgentRow): number {
  const fa = FOCUS_ORDER.indexOf(a.focus);
  const fb = FOCUS_ORDER.indexOf(b.focus);
  const fas = fa === -1 ? FOCUS_ORDER.length : fa;
  const fbs = fb === -1 ? FOCUS_ORDER.length : fb;
  if (fas !== fbs) return fas - fbs;
  const ma = MODEL_ORDER.indexOf(a.model);
  const mb = MODEL_ORDER.indexOf(b.model);
  const mas = ma === -1 ? MODEL_ORDER.length : ma;
  const mbs = mb === -1 ? MODEL_ORDER.length : mb;
  if (mas !== mbs) return mas - mbs;
  return a.slug.localeCompare(b.slug);
}

export function useAgents() {
  const queryClient = useQueryClient();
  const query = useQuery<AgentRow[]>({
    queryKey: ["agents"],
    queryFn: async () => {
      const rows = await api.get<AgentRow[]>("/api/agents");
      return rows
        .map((a) => ({ ...a, starting_capital: Number(a.starting_capital), cash: Number(a.cash) }))
        .sort(matrixSort);
    },
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["agents"] });
  return { agents: query.data ?? [], loading: query.isPending, refresh };
}

export interface CreateAgentInput {
  userId: string;
  name: string;
  focus: string;
  model: string;
  systemPrompt: string;
  preset: any;
  watchedSymbols: string[];
  startingCapital: number;
}

export async function createAgent(input: CreateAgentInput): Promise<AgentRow> {
  return api.post<AgentRow>("/api/agents", {
    name: input.name,
    focus: input.focus,
    model: input.model,
    systemPrompt: input.systemPrompt,
    preset: input.preset,
    watchedSymbols: input.watchedSymbols,
    startingCapital: input.startingCapital,
  });
}

export async function deleteAgent(id: string): Promise<void> {
  await api.del(`/api/agents/${id}`);
}

export function useEquityHistory(agentId: string | null) {
  const query = useQuery<EquitySnapshot[]>({
    queryKey: ["equity_history", agentId],
    enabled: !!agentId,
    queryFn: () => api.get<EquitySnapshot[]>(`/api/agents/${agentId}/equity`),
  });
  return { snapshots: query.data ?? [], loading: query.isPending };
}

export function usePositions(agentId: string | null, status?: "open" | "closed" | "expired") {
  const query = useQuery<PositionRow[]>({
    queryKey: ["positions", agentId, status ?? "all"],
    enabled: !!agentId,
    queryFn: () =>
      api.get<PositionRow[]>(`/api/agents/${agentId}/positions${status ? `?status=${status}` : ""}`),
  });
  return { positions: query.data ?? [], loading: query.isPending };
}

export function useDecisions(agentId: string | null, limit = 500) {
  const query = useQuery<DecisionRow[]>({
    queryKey: ["decisions", agentId, limit],
    enabled: !!agentId,
    queryFn: async () => {
      const rows = await api.get<any[]>(`/api/agents/${agentId}/decisions?limit=${limit}`);
      return rows.map((d) => ({
        ...d,
        run_date: typeof d.run_date === "string" ? d.run_date.slice(0, 10) : d.run_date,
      })) as DecisionRow[];
    },
  });
  return { decisions: query.data ?? [], loading: query.isPending };
}
