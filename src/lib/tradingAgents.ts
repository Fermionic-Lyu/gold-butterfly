import { useQuery, useQueryClient } from "@tanstack/react-query";
import { insforge } from "./insforge";
import { isMarketLive } from "./marketHours";

// Market holidays as a Map keyed by YYYY-MM-DD. Value is null for a
// full-closure day, or the early-close HH:MM string for half days. Used
// by the AgentsPage calendar to disable closed dates and decorate
// half-days. One fetch per session — the calendar table only changes
// once a year.
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
      const { data, error } = await insforge.database
        .from("market_holidays")
        .select("date,name,early_close_et")
        .limit(500);
      if (error) throw error;
      const m = new Map<string, MarketHoliday>();
      for (const r of (data ?? []) as any[]) {
        const key = typeof r.date === "string" ? r.date.slice(0, 10) : r.date;
        m.set(key, {
          date: key,
          name: r.name ?? null,
          early_close_et: r.early_close_et ?? null,
        });
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
  // ET trading-day key (YYYY-MM-DD) the decision belongs to. Comes
  // straight from the decisions.run_date column — populated by the
  // trading-tick worker so the calendar view can group decisions by
  // the day they were made *for*, not by their wall-clock timestamp
  // (which can land in the next UTC day after midnight).
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

export function computeReturns(
  startingCapital: number,
  snapshots: EquitySnapshot[],
): AgentReturns {
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
  // "Previous session close" = latest snapshot before today UTC midnight.
  const beforeToday = sorted.filter((s) => new Date(s.recorded_at).getTime() < startMidnight);
  const prevClose = beforeToday.length > 0 ? beforeToday[beforeToday.length - 1].total_equity : null;

  const totalReturnPct = (latest.total_equity - startingCapital) / startingCapital;
  let todayChangeAbs: number | null = null;
  let todayChangePct: number | null = null;
  if (prevClose !== null && prevClose > 0) {
    todayChangeAbs = latest.total_equity - prevClose;
    todayChangePct = todayChangeAbs / prevClose;
  } else {
    // First-day fallback: compare to starting capital.
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

// Live per-agent state — computed on demand by the get_agents_summary RPC
// so the drawer + per-agent page show intraday MTM instead of values
// frozen at the previous post-close trading-tick. `positions` carries
// the agent's open positions with current_value already MTM'd against
// the latest chain_quotes / chain_underlyings rows.
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
  // One RPC for every active agent. Polls every 30s during market hours;
  // off-hours the cached snapshot stays put (refetchInterval returns false)
  // since chain_quotes don't tick.
  const query = useQuery<Record<string, AgentSummary>>({
    queryKey: ["agents_summary"],
    refetchInterval: () => (isMarketLive() ? 30_000 : false),
    refetchIntervalInBackground: false,
    queryFn: async () => {
      const { data, error } = await insforge.database.rpc("get_agents_summary");
      if (error) throw error;
      const raw = (data ?? {}) as Record<string, any>;
      // PostgREST returns NUMERIC as JSON numbers via jsonb, but coerce
      // defensively so downstream math is fast and safe.
      const out: Record<string, AgentSummary> = {};
      for (const [slug, s] of Object.entries(raw)) {
        out[slug] = {
          agent_id: s.agent_id,
          cash: Number(s.cash),
          starting_capital: Number(s.starting_capital),
          positions_mtm: Number(s.positions_mtm),
          total_equity: Number(s.total_equity),
          open_positions: Number(s.open_positions),
          prev_session_equity:
            s.prev_session_equity == null ? null : Number(s.prev_session_equity),
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

// Returns the same shape as computeReturns(), but driven by the live
// summary instead of the daily equity_snapshots table. Today's change
// baseline is the previous session's closing equity if available, else
// the starting capital (first-day fallback).
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

// Ordering for the 3×3 matrix view: rows are strategies (Theta/Vega/Delta),
// columns are models (Sonnet/Gemini/GPT). Anything outside the matrix lands at
// the end alphabetically.
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
      const { data, error } = await insforge.database
        .from("agents")
        .select("*")
        .eq("active", true);
      if (error) throw error;
      return ((data ?? []) as AgentRow[]).slice().sort(matrixSort);
    },
  });
  // `refresh` mirrors the old imperative API — callers (CreateAgentDialog,
  // delete flows) trigger an invalidation rather than bumping a tick.
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
  // Slug must be unique. Take a short hash of the persona name + a 4-char
  // random suffix. The DB has a UNIQUE constraint so retries on collision
  // would surface as an error from the SDK.
  const safeName = input.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const suffix = Math.random().toString(36).slice(2, 6);
  const slug = `${safeName || "agent"}-${suffix}`;

  const { data, error } = await insforge.database
    .from("agents")
    .insert([
      {
        user_id: input.userId,
        slug,
        name: input.name,
        focus: input.focus,
        model: input.model,
        system_prompt: input.systemPrompt,
        preset: input.preset,
        watched_symbols: input.watchedSymbols,
        starting_capital: input.startingCapital,
        cash: input.startingCapital,
        active: true,
      },
    ])
    .select("*");
  if (error) throw error;
  const rows = (data ?? []) as AgentRow[];
  if (rows.length === 0) throw new Error("Insert returned no rows.");
  return rows[0];
}

export async function deleteAgent(id: string): Promise<void> {
  const { error } = await insforge.database.from("agents").delete().eq("id", id);
  if (error) throw error;
}

export function useEquityHistory(agentId: string | null) {
  const query = useQuery<EquitySnapshot[]>({
    queryKey: ["equity_history", agentId],
    enabled: !!agentId,
    queryFn: async () => {
      const { data, error } = await insforge.database
        .from("equity_snapshots")
        .select("*")
        .eq("agent_id", agentId!)
        .order("recorded_at", { ascending: true })
        .limit(2000);
      if (error) throw error;
      return (data ?? []) as EquitySnapshot[];
    },
  });
  return { snapshots: query.data ?? [], loading: query.isPending };
}

export function usePositions(agentId: string | null, status?: "open" | "closed" | "expired") {
  const query = useQuery<PositionRow[]>({
    queryKey: ["positions", agentId, status ?? "all"],
    enabled: !!agentId,
    queryFn: async () => {
      let q = insforge.database.from("positions").select("*").eq("agent_id", agentId!);
      if (status) q = q.eq("status", status);
      const { data, error } = await q.order("opened_at", { ascending: false }).limit(200);
      if (error) throw error;
      return (data ?? []) as PositionRow[];
    },
  });
  return { positions: query.data ?? [], loading: query.isPending };
}

export function useDecisions(agentId: string | null, limit = 500) {
  const query = useQuery<DecisionRow[]>({
    queryKey: ["decisions", agentId, limit],
    enabled: !!agentId,
    queryFn: async () => {
      const { data, error } = await insforge.database
        .from("decisions")
        .select(
          "id,agent_id,symbol,decided_at,run_date,action,confidence,reasoning,position_id,validation_notes",
        )
        .eq("agent_id", agentId!)
        .order("decided_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      // PostgREST returns DATE columns as "YYYY-MM-DDT00:00:00.000Z" — slice
      // to keep run_date as a plain YYYY-MM-DD string for keying.
      return ((data ?? []) as any[]).map((d) => ({
        ...d,
        run_date: typeof d.run_date === "string" ? d.run_date.slice(0, 10) : d.run_date,
      })) as DecisionRow[];
    },
  });
  return { decisions: query.data ?? [], loading: query.isPending };
}
