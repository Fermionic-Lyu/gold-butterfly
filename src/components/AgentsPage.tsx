import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  CartesianGrid,
} from "recharts";
import {
  computeReturnsFromSummary,
  useAgents,
  useAgentsSummary,
  useDecisions,
  useEquityHistory,
  useMarketHolidays,
  usePositions,
  type AgentRow,
  type DecisionRow,
  type MarketHoliday,
  type PositionRow,
} from "../lib/tradingAgents";
import { capitalize, fmtCurrency, fmtNum, fmtPct } from "../lib/format";

interface Props {
  agentSlug: string;
}

export default function AgentsPage({ agentSlug }: Props) {
  const { agents, loading } = useAgents();
  const agent = useMemo(
    () => agents.find((a) => a.slug === agentSlug) ?? null,
    [agents, agentSlug],
  );

  if (loading) {
    return <div className="card p-8 text-center text-neutral-500">Loading agent…</div>;
  }
  if (!agent) {
    return <div className="card p-8 text-center text-neutral-400">Agent not found.</div>;
  }
  return <AgentDetail key={agent.id} agent={agent} />;
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "bad" | "default";
}) {
  const cls =
    tone === "good" ? "text-emerald-300" : tone === "bad" ? "text-rose-300" : "text-neutral-100";
  return (
    <div className="rounded-md bg-neutral-950 border border-neutral-800 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-neutral-500">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${cls}`}>{value}</div>
    </div>
  );
}

// Back from any agent page goes to the most recent dashboard (= last viewed
// symbol). Read from the same localStorage key that SymbolRoute writes.
function BackToLab() {
  const navigate = useNavigate();
  const handleBack = () => {
    let last: string | null = null;
    try {
      last = localStorage.getItem("gb.lastSymbol");
    } catch {}
    const target = last && /^[A-Z][A-Z0-9.\-]{0,7}$/.test(last) ? last : "NVDA";
    navigate(`/symbols/${target}`);
  };
  return (
    <button
      type="button"
      onClick={handleBack}
      className="inline-flex items-center gap-1 text-sm text-neutral-400 hover:text-neutral-100 transition-colors"
    >
      <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
        <path
          fillRule="evenodd"
          d="M12.79 5.23a.75.75 0 010 1.06L9.06 10l3.73 3.71a.75.75 0 11-1.06 1.06l-4.25-4.24a.75.75 0 010-1.06l4.25-4.24a.75.75 0 011.06 0z"
          clipRule="evenodd"
        />
      </svg>
      Back to dashboard
    </button>
  );
}

function AgentDetail({ agent }: { agent: AgentRow }) {
  const { snapshots } = useEquityHistory(agent.id);
  const { summaries } = useAgentsSummary();
  const summary = summaries[agent.slug] ?? null;
  const openPositions = summary?.positions ?? [];
  const { positions: closedPositions } = usePositions(agent.id, "closed");
  const { decisions } = useDecisions(agent.id, 500);
  const { holidays } = useMarketHolidays();

  // Lookup from decision.position_id → position. Used in the decision
  // detail rows to display each linked position's P&L next to its
  // action. Merges live open positions (with MTM'd current_value) and
  // historical closed/expired positions.
  const positionsById = useMemo(() => {
    const m = new Map<string, PositionRow>();
    for (const p of openPositions) m.set(p.id, p);
    for (const p of closedPositions) m.set(p.id, p);
    return m;
  }, [openPositions, closedPositions]);
  const returns = useMemo(
    () =>
      summary
        ? computeReturnsFromSummary(summary)
        : {
            totalEquity: agent.starting_capital,
            totalReturnPct: 0,
            todayChangeAbs: null,
            todayChangePct: null,
            prevSessionClose: null,
          },
    [summary, agent.starting_capital],
  );

  const chartData = useMemo(() => {
    const base = snapshots.map((s) => ({
      t: new Date(s.recorded_at).getTime(),
      eq: s.total_equity,
    }));
    if (summary) {
      const lastT = base.length ? base[base.length - 1].t : 0;
      const nowT = Date.now();
      if (nowT > lastT) base.push({ t: nowT, eq: summary.total_equity });
    }
    return base;
  }, [snapshots, summary]);

  return (
    <div className="space-y-4">
      <BackToLab />

      {/* Identity strip — bare (no card background) so the profile
          section below is the real first-fold visual block. */}
      <div className="flex items-baseline justify-between gap-3 flex-wrap px-1">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h2 className="text-2xl font-semibold tracking-tight">{agent.name}</h2>
          <span className="pill bg-neutral-800 text-neutral-300 border border-neutral-700">
            {capitalize(agent.focus.replace(/_/g, " "))}
          </span>
          <span className="pill bg-neutral-900 text-neutral-400 border border-neutral-800 font-mono text-[10px]">
            {agent.model}
          </span>
        </div>
        <div className="text-xs text-neutral-500">
          since {new Date(agent.created_at).toLocaleDateString()}
        </div>
      </div>

      {/* Section 1 — Profile: equity chart + key stats on the left,
          positions cards on the right. Fixed row height on lg+ so the
          positions card has a stable scroll container regardless of
          how many positions are open (or how long the closed history
          gets). Height tuned with breathing room above the profile
          card's natural content (40px padding + label + stats grid +
          chart at h-64 ≈ 420px) so Recharts' SVG can't push past the
          card edge and overlap the calendar below. */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:h-[460px]">
        <div className="card p-5 overflow-hidden">
          <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-2">
            Profile
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            <Stat label="Cash" value={fmtCurrency(summary?.cash ?? agent.cash)} />
            <Stat label="Equity" value={fmtCurrency(returns.totalEquity)} />
            <Stat label="Open positions" value={String(openPositions.length)} />
            <Stat
              label="Total return"
              value={returns.totalReturnPct !== null ? fmtPct(returns.totalReturnPct, 2) : "—"}
              tone={returns.totalReturnPct !== null && returns.totalReturnPct >= 0 ? "good" : "bad"}
            />
            <Stat
              label="Today"
              value={returns.todayChangePct !== null ? fmtPct(returns.todayChangePct, 2) : "—"}
              tone={
                returns.todayChangePct === null
                  ? "default"
                  : returns.todayChangePct >= 0
                    ? "good"
                    : "bad"
              }
            />
            <Stat
              label="Starting"
              value={fmtCurrency(agent.starting_capital)}
            />
          </div>

          <div className="h-64 mt-5">
            {chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 5, right: 8, left: 8, bottom: 0 }}>
                  <defs>
                    <linearGradient id={`area-${agent.id}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#eeb71b" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#eeb71b" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#262626" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="t"
                    type="number"
                    domain={["dataMin", "dataMax"]}
                    tick={{ fontSize: 11, fill: "#525252" }}
                    tickFormatter={(v) =>
                      new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric" })
                    }
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "#525252" }}
                    // Minimum visible range: ±20% of starting capital,
                    // so an agent that's barely moved still shows
                    // meaningful scale. Expand if real data exceeds.
                    domain={[
                      (dataMin: number) =>
                        Math.min(dataMin, agent.starting_capital * 0.8),
                      (dataMax: number) =>
                        Math.max(dataMax, agent.starting_capital * 1.2),
                    ]}
                    tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "#171717",
                      border: "1px solid #404040",
                      fontSize: 12,
                    }}
                    labelStyle={{ color: "#a3a3a3" }}
                    formatter={(v: any) => fmtCurrency(v)}
                    labelFormatter={(v) => new Date(v).toLocaleString()}
                  />
                  <ReferenceLine
                    y={agent.starting_capital}
                    stroke="#38bdf8"
                    strokeOpacity={0.5}
                    strokeDasharray="4 4"
                    label={{
                      value: "starting",
                      fontSize: 10,
                      fill: "#38bdf8",
                      position: "insideTopLeft",
                      offset: 6,
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="eq"
                    stroke="#eeb71b"
                    strokeWidth={2}
                    fill={`url(#area-${agent.id})`}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-sm text-neutral-500">
                No equity snapshots yet — wait for the next tick.
              </div>
            )}
          </div>
        </div>

        <PositionsCard
          openPositions={openPositions}
          closedPositions={closedPositions}
        />
      </section>

      {/* Section 2 — Decisions: month calendar on the left with a per-day
          summary, selected day's full decision list on the right.
          overflow-hidden on the outer card guarantees nothing —
          decision text, tooltip popups, anything — can render outside
          the rounded box. */}
      <section className="card p-5 overflow-hidden">
        <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-3">
          Decisions
        </div>
        <DecisionCalendar
          decisions={decisions}
          snapshots={snapshots}
          startingCapital={agent.starting_capital}
          holidays={holidays}
          positionsById={positionsById}
          agentCreatedAt={agent.created_at}
        />
      </section>
    </div>
  );
}

// ---------- Positions card (tabbed: Current / Closed) ----------

function PositionsCard({
  openPositions,
  closedPositions,
}: {
  openPositions: PositionRow[];
  closedPositions: PositionRow[];
}) {
  const [tab, setTab] = useState<"current" | "closed">("current");
  const list = tab === "current" ? openPositions : closedPositions;
  const empty =
    tab === "current" ? "No open positions." : "No closed positions yet.";

  return (
    // overflow-hidden + min-h-0 so the inner list can scroll while the
    // outer card respects the fixed row height set on the parent grid.
    <div className="card p-5 flex flex-col overflow-hidden min-h-0">
      {/* Tab strip */}
      <div className="flex items-center gap-1 border-b border-neutral-800 -mt-1 mb-3">
        <TabButton
          active={tab === "current"}
          onClick={() => setTab("current")}
          label="Current"
          count={openPositions.length}
        />
        <TabButton
          active={tab === "closed"}
          onClick={() => setTab("closed")}
          label="Closed"
          count={closedPositions.length}
        />
      </div>

      {/* Scroll area — flex-1 + overflow-y-auto so it always fills the
          remaining card height and scrolls when content exceeds it. */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 min-w-0 pr-1">
        {list.length === 0 ? (
          <p className="text-sm text-neutral-500">{empty}</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {list.map((p) => (
              <PositionCard key={p.id} pos={p} closed={tab === "closed"} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-xs font-semibold px-2.5 py-1.5 border-b-2 -mb-px transition-colors ${
        active
          ? "border-gold-400 text-gold-300"
          : "border-transparent text-neutral-500 hover:text-neutral-200"
      }`}
    >
      {label}
      <span className="ml-1.5 text-[10px] text-neutral-500 font-normal">
        {count}
      </span>
    </button>
  );
}

// ---------- Position card (compact) ----------

function PositionCard({ pos, closed = false }: { pos: PositionRow; closed?: boolean }) {
  const unrealized = pos.current_value !== null ? pos.current_value - pos.entry_cost : null;
  const realized = pos.realized_pnl;
  const pnl = closed ? realized : unrealized;
  const pnlPct = pnl !== null && pos.entry_cost > 0 ? pnl / pos.entry_cost : null;
  const pnlTone =
    pnl === null
      ? "text-neutral-300"
      : pnl > 0
        ? "text-emerald-300"
        : pnl < 0
          ? "text-rose-300"
          : "text-neutral-300";

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="font-mono font-semibold text-neutral-100 text-[13px]">
            {pos.symbol}
          </span>
          <span className="text-[10px] text-neutral-500 truncate">
            {capitalize(pos.strategy.replace(/_/g, " "))}
          </span>
          {closed && (
            <span className="text-[10px] text-neutral-600">· {capitalize(pos.status)}</span>
          )}
        </div>
        {pnl !== null && (
          <div className="flex items-baseline gap-1.5 shrink-0">
            <span className={`text-[12px] font-semibold tabular-nums ${pnlTone}`}>
              {pnl >= 0 ? "+" : ""}${fmtNum(pnl, 2)}
            </span>
            {pnlPct !== null && (
              <span className={`text-[10px] tabular-nums ${pnlTone} opacity-70`}>
                ({pnl >= 0 ? "+" : ""}
                {fmtPct(pnlPct, 1)})
              </span>
            )}
          </div>
        )}
      </div>
      <div className="mt-1 text-[11px] font-mono tabular-nums space-y-0.5">
        {pos.legs.map((l: any, i: number) => (
          <PositionLeg key={i} leg={l} />
        ))}
      </div>
    </div>
  );
}

// One leg, formatted in fixed-width columns so multi-leg positions read
// like a tidy block. Columns:
//   +/-  qty  CALL/PUT  strike  M/D   fill → current   Δ
// + (emerald) means long, - (rose) means short. The Δ column shows the
// raw price change of the option (current − fill), colored by whether
// the move is in our favor (long + up = green, short + up = red, etc.).
function PositionLeg({ leg }: { leg: any }) {
  const isLong = leg.sign === 1;
  const dirCls = isLong ? "text-emerald-400" : "text-rose-400";
  const dirGlyph = isLong ? "+" : "−";
  const qty = leg.qty ?? 1;

  const fill = typeof leg.fill_price === "number" ? leg.fill_price : null;
  const cur = typeof leg.current_price === "number" ? leg.current_price : null;
  const rawChange = fill !== null && cur !== null ? cur - fill : null;
  // Sign-adjusted PnL direction: positive = good for us.
  const favorChange = rawChange !== null ? rawChange * (isLong ? 1 : -1) : null;
  const changeTone =
    favorChange === null
      ? "text-neutral-500"
      : favorChange > 0
        ? "text-emerald-300"
        : favorChange < 0
          ? "text-rose-300"
          : "text-neutral-400";

  if (leg.instrument === "stock") {
    return (
      <div className="flex items-center gap-2 text-neutral-300">
        <span className={`${dirCls} w-12 text-right font-semibold tabular-nums`}>
          {dirGlyph}
          {qty * 100}
        </span>
        <span className="w-12 text-neutral-200">SHARES</span>
        <span className="flex-1" />
        {fill !== null && (
          <span className="text-neutral-500 tabular-nums">{fmtNum(fill, 2)}</span>
        )}
        {cur !== null && (
          <>
            <span className="text-neutral-700">→</span>
            <span className="text-neutral-200 tabular-nums">{fmtNum(cur, 2)}</span>
          </>
        )}
        {rawChange !== null && (
          <span className={`tabular-nums w-14 text-right ${changeTone}`}>
            {rawChange >= 0 ? "+" : ""}
            {fmtNum(rawChange, 2)}
          </span>
        )}
      </div>
    );
  }

  const right = (leg.instrument as string).toUpperCase();
  const exp = leg.expiration
    ? new Date(leg.expiration + "T00:00:00Z").toLocaleDateString(undefined, {
        month: "numeric",
        day: "numeric",
      })
    : "";

  return (
    <div className="flex items-center gap-2 text-neutral-300">
      <span className={`${dirCls} w-7 text-right font-semibold tabular-nums`}>
        {dirGlyph}
        {qty}
      </span>
      <span className="w-9 text-neutral-200">{right}</span>
      <span className="w-10 text-right tabular-nums">{fmtNum(leg.strike, 0)}</span>
      <span className="w-9 text-neutral-500 text-right">{exp}</span>
      <span className="flex-1" />
      {fill !== null && (
        <span className="text-neutral-500 tabular-nums">{fmtNum(fill, 2)}</span>
      )}
      {cur !== null && (
        <>
          <span className="text-neutral-700">→</span>
          <span className="text-neutral-200 tabular-nums">{fmtNum(cur, 2)}</span>
        </>
      )}
      {rawChange !== null && (
        <span className={`tabular-nums w-14 text-right ${changeTone}`}>
          {rawChange >= 0 ? "+" : ""}
          {fmtNum(rawChange, 2)}
        </span>
      )}
    </div>
  );
}

// ---------- Decision calendar ----------

function actionTone(action: string) {
  if (action === "open") return "bg-emerald-900/40 text-emerald-300 border-emerald-800";
  if (action === "close") return "bg-sky-900/40 text-sky-300 border-sky-800";
  if (action === "hold") return "bg-neutral-800 text-neutral-400 border-neutral-700";
  if (action === "skip_low_confidence") return "bg-amber-900/30 text-amber-300 border-amber-800";
  if (action === "skip_invalid" || action === "skip_outranked")
    return "bg-amber-900/40 text-amber-300 border-amber-800";
  if (action === "error") return "bg-rose-900/40 text-rose-300 border-rose-800";
  return "bg-neutral-800 text-neutral-400 border-neutral-700";
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function DecisionCalendar({
  decisions,
  snapshots,
  startingCapital,
  holidays,
  positionsById,
  agentCreatedAt,
}: {
  decisions: DecisionRow[];
  snapshots: { recorded_at: string; total_equity: number }[];
  startingCapital: number;
  holidays: Map<string, MarketHoliday>;
  positionsById: Map<string, PositionRow>;
  agentCreatedAt: string;
}) {
  // Helpers for "is this date a trading day". A full-closure holiday
  // has early_close_et === null in the market_holidays table; an early
  // close is still a trading day (agents tick after the early close).
  const isFullClosure = (k: string) => {
    const h = holidays.get(k);
    return h !== undefined && h.early_close_et === null;
  };
  const isWeekendDate = (d: Date) => {
    const dow = d.getDay();
    return dow === 0 || dow === 6;
  };
  const isTradable = (d: Date) => !isWeekendDate(d) && !isFullClosure(dateKey(d));
  // Walk back from `d` (inclusive) until we hit a tradable weekday.
  const lastTradableOnOrBefore = (d: Date): Date => {
    const cur = new Date(d);
    for (let i = 0; i < 14; i++) {
      if (isTradable(cur)) return cur;
      cur.setDate(cur.getDate() - 1);
    }
    return cur;
  };
  // Group decisions by run_date. run_date is already a plain "YYYY-MM-DD"
  // string from the DB after the slice in useDecisions.
  const byDate = useMemo(() => {
    const m = new Map<string, DecisionRow[]>();
    for (const d of decisions) {
      const arr = m.get(d.run_date) ?? [];
      arr.push(d);
      m.set(d.run_date, arr);
    }
    return m;
  }, [decisions]);

  const todayKey = useMemo(() => dateKey(new Date()), []);
  // ET date the agent was created — dates before this don't have any
  // history for the agent and so should be non-interactive.
  const createdAtKey = useMemo(
    () =>
      new Date(agentCreatedAt).toLocaleDateString("en-CA", {
        timeZone: "America/New_York",
      }),
    [agentCreatedAt],
  );

  // Default selection: today if it's a tradable weekday, otherwise the
  // most recent prior tradable day (Friday on Sat/Sun, the day before a
  // full-closure holiday, etc.). Calendar anchor follows the selection.
  const defaultSelected = useMemo(() => {
    return dateKey(lastTradableOnOrBefore(new Date()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holidays]);
  const [monthAnchor, setMonthAnchor] = useState<Date>(() => {
    const [y, mo] = defaultSelected.split("-").map(Number);
    return new Date(y, mo - 1, 1);
  });
  const [selectedDate, setSelectedDate] = useState<string>(defaultSelected);

  // Build a 6×7 grid covering the displayed month with leading/trailing
  // days from neighbour months — standard calendar layout.
  const cells = useMemo(() => {
    const year = monthAnchor.getFullYear();
    const month = monthAnchor.getMonth();
    const firstOfMonth = new Date(year, month, 1);
    const firstWeekday = firstOfMonth.getDay(); // 0=Sun..6=Sat
    const gridStart = new Date(year, month, 1 - firstWeekday);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      return d;
    });
  }, [monthAnchor]);

  const monthLabel = monthAnchor.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  function goPrevMonth() {
    setMonthAnchor((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1));
  }
  function goNextMonth() {
    setMonthAnchor((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1));
  }
  function goToday() {
    // "Today" snaps the calendar to the current month and selects the
    // most recent tradable day (today if it's a weekday and not a full-
    // closure holiday, otherwise the last Friday / pre-holiday day).
    const t = lastTradableOnOrBefore(new Date());
    setMonthAnchor(new Date(t.getFullYear(), t.getMonth(), 1));
    setSelectedDate(dateKey(t));
  }

  const selectedDayDecisions = useMemo(() => {
    if (!selectedDate) return [];
    return (byDate.get(selectedDate) ?? []).slice().sort((a, b) =>
      a.symbol.localeCompare(b.symbol),
    );
  }, [byDate, selectedDate]);

  // Count opens and closes per day — that's all the cell needs to show.
  function dayActionCounts(decs: DecisionRow[]): { opens: number; closes: number } {
    let opens = 0;
    let closes = 0;
    for (const d of decs) {
      if (d.action === "open") opens++;
      else if (d.action === "close") closes++;
    }
    return { opens, closes };
  }

  // Daily P&L delta — for each ET trading day with an equity snapshot,
  // compute the % change vs the prior snapshot. The first snapshot
  // anchors off starting_capital so day-1 isn't blank. Snapshots are
  // taken at 22:10 UTC (post-close ET); we key by the ET date the
  // session belongs to.
  const equityByDate = useMemo(() => {
    const m = new Map<string, { equity: number; deltaPct: number | null }>();
    const sorted = [...snapshots].sort(
      (a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime(),
    );
    // De-dup to one entry per ET date (latest wins if multiple).
    const byEt = new Map<string, number>();
    for (const s of sorted) {
      const et = new Date(s.recorded_at).toLocaleDateString("en-CA", {
        timeZone: "America/New_York",
      });
      byEt.set(et, s.total_equity);
    }
    const dates = [...byEt.keys()].sort();
    let prev = startingCapital;
    for (const d of dates) {
      const eq = byEt.get(d)!;
      const deltaPct = prev > 0 ? (eq - prev) / prev : null;
      m.set(d, { equity: eq, deltaPct });
      prev = eq;
    }
    return m;
  }, [snapshots, startingCapital]);

  return (
    // 2-column split matching the Profile section above so the calendar
    // lines up vertically with the equity chart and the detail panel
    // lines up with the positions card — the whole agent page reads as
    // two clean columns top-to-bottom.
    // Fixed row height pins the decision panel's scroll container.
    // Height accounts for nav (~36px) + weekday header (~20px) +
    // 6 cell rows × h-24 (96px) + 5 row gaps (4px) ≈ 652px. Add slack.
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:h-[680px]">
      {/* Month grid with daily P&L delta + open/close counts per cell */}
      <div className="flex flex-col">
        {/* Month nav uses the same 7-column grid as the day cells below
            so each nav element lines up with a column. Today lives in
            column 1 (above Sunday), right-aligned so its right edge
            sits exactly at the Sunday column's right edge. Month nav
            (prev / title / next) spans the middle columns and centers
            within that span — visually dead-center of the calendar. */}
        <div className="grid grid-cols-7 gap-1 items-center mb-2">
          <button
            type="button"
            onClick={goToday}
            className="text-[10px] uppercase tracking-wider text-neutral-500 hover:text-neutral-200 px-2 py-1 justify-self-end"
          >
            Today
          </button>
          <div className="col-start-2 col-span-5 flex items-center justify-center gap-1">
            <button
              type="button"
              onClick={goPrevMonth}
              className="text-neutral-400 hover:text-neutral-100 text-sm px-2 py-1 rounded hover:bg-neutral-800"
              aria-label="Previous month"
            >
              ‹
            </button>
            <div className="text-sm font-semibold min-w-[140px] text-center">
              {monthLabel}
            </div>
            <button
              type="button"
              onClick={goNextMonth}
              className="text-neutral-400 hover:text-neutral-100 text-sm px-2 py-1 rounded hover:bg-neutral-800"
              aria-label="Next month"
            >
              ›
            </button>
          </div>
        </div>

        {/* Weekday header: same grid + horizontal padding as the day cells
            below, so each "S/M/T/…" letter sits exactly above its column's
            day number (which is text-left at px-2 inside each cell). */}
        <div className="grid grid-cols-7 gap-1 text-[10px] uppercase tracking-wider text-neutral-600 mb-1">
          {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
            <div key={i} className="px-2 text-left">
              {d}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-1">
          {cells.map((d) => {
            const key = dateKey(d);
            const inMonth = d.getMonth() === monthAnchor.getMonth();
            const dayDecisions = byDate.get(key) ?? [];
            const hasData = dayDecisions.length > 0;
            const isSelected = selectedDate === key;
            const isToday = key === todayKey;
            const isWknd = isWeekendDate(d);
            const holiday = holidays.get(key);
            const isClosed = holiday !== undefined && holiday.early_close_et === null;
            const isEarlyClose = holiday !== undefined && holiday.early_close_et !== null;
            const isFuture = key > todayKey;
            const isPreProfile = key < createdAtKey;
            // Disable: weekends, full-closure holidays (no run), future
            // dates (haven't happened yet), and pre-agent-creation dates
            // (agent didn't exist).
            const isClickable =
              !isWknd && !isClosed && !isFuture && !isPreProfile;
            const { opens, closes } = hasData
              ? dayActionCounts(dayDecisions)
              : { opens: 0, closes: 0 };
            const eq = equityByDate.get(key);
            const pnlPct = eq?.deltaPct ?? null;
            const pnlTone =
              pnlPct === null
                ? "text-neutral-500"
                : pnlPct > 0
                  ? "text-emerald-300"
                  : pnlPct < 0
                    ? "text-rose-300"
                    : "text-neutral-400";

            const dayNumColor = isToday
              ? "text-gold-300 font-semibold"
              : inMonth
                ? "text-neutral-300"
                : "text-neutral-600";

            // No tooltip for weekends — readers know Sat/Sun means
            // closed without being told. Only surface the reason when
            // it's non-obvious: a weekday full-closure (with the
            // holiday name) or an early-close half-day.
            const cellTooltip = isClosed
              ? `Market closed${holiday?.name ? ` — ${holiday.name}` : ""}`
              : isEarlyClose
                ? `Early close ${holiday?.early_close_et}${holiday?.name ? ` — ${holiday.name}` : ""}`
                : null;
            const hasActivity = opens > 0 || closes > 0;
            return (
              <button
                key={key}
                type="button"
                onClick={() => isClickable && setSelectedDate(key)}
                disabled={!isClickable}
                aria-label={
                  isClosed
                    ? `${key} — market closed${holiday?.name ? ` (${holiday.name})` : ""}`
                    : isWknd
                      ? `${key} — weekend, market closed`
                      : key
                }
                className={[
                  "group relative h-24 rounded-md border text-left px-2 py-2 flex flex-col transition-colors",
                  inMonth ? "" : "opacity-30",
                  isWknd
                    ? "border-transparent cursor-default text-neutral-700"
                    : isClosed
                      ? // Muted-red outline so the cell reads as
                        // "market-blocked, don't click". rose-900 at low
                        // opacity blends to a soft red on the dark bg.
                        "border-rose-900/40 cursor-default"
                      : isFuture || isPreProfile
                        ? // Outside the agent's active window — neutral
                          // dimmed style, no hover, no click.
                          "border-transparent cursor-default text-neutral-700"
                        : hasData
                          ? "border-neutral-800 bg-neutral-900/40 hover:bg-neutral-800/70 cursor-pointer"
                          : "border-transparent hover:bg-neutral-900/40 cursor-pointer",
                  isSelected ? "ring-1 ring-gold-400/60 bg-gold-400/10 border-gold-400/40" : "",
                ].join(" ")}
              >
                {/* Row 1 — day number left, market-close marker right.
                    The top-right corner is reserved for closure markers
                    and is the only thing allowed there, so the cell is
                    unambiguous at a glance. */}
                <div className="flex items-baseline justify-between">
                  <span className={`text-sm tabular-nums leading-none ${dayNumColor}`}>
                    {d.getDate()}
                  </span>
                  {isClosed ? (
                    <span className="text-sm leading-none text-amber-400/80">⊘</span>
                  ) : isEarlyClose ? (
                    <span className="text-xs leading-none text-amber-400/70">◐</span>
                  ) : null}
                </div>

                {/* P&L % — the day's outcome leads (right under day#)
                    as the headline number. Opens/closes follow below,
                    separated by a thin rule. Spacing tuned for the
                    h-24 cell: each row gets a comfortable gap rather
                    than being mashed together. */}
                {pnlPct !== null && (
                  <div className="mt-1.5 leading-none">
                    <span className={`text-[13px] font-semibold tabular-nums ${pnlTone}`}>
                      {pnlPct >= 0 ? "+" : ""}
                      {fmtPct(pnlPct, 2)}
                    </span>
                  </div>
                )}

                {hasActivity && (
                  <>
                    {pnlPct !== null && (
                      <div className="border-t border-neutral-800/80 my-2" />
                    )}
                    <div
                      className={`text-xs leading-none tabular-nums space-y-1 ${
                        pnlPct === null ? "mt-2" : ""
                      }`}
                    >
                      {opens > 0 && (
                        <div className="text-emerald-300">
                          +{opens} open{opens > 1 ? "s" : ""}
                        </div>
                      )}
                      {closes > 0 && (
                        <div className="text-sky-300">
                          −{closes} close{closes > 1 ? "s" : ""}
                        </div>
                      )}
                    </div>
                  </>
                )}

                {/* CSS-only tooltip — appears instantly on hover (no
                    500ms native title delay). Positioned above the cell
                    and centered. pointer-events-none keeps it from
                    eating clicks. */}
                {cellTooltip && (
                  <span className="absolute z-20 bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-neutral-900 border border-neutral-700 rounded shadow-lg text-[10px] text-neutral-200 whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-100">
                    {cellTooltip}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Selected-day detail. overflow-hidden + min-h-0 cap this column
          at the row's height; min-w-0 prevents the column's content
          (long reasoning paragraphs) from blowing past the grid's
          1fr track width — CSS Grid items default to min-width:auto
          which lets content push tracks wider than intended. */}
      <div className="flex flex-col min-h-0 min-w-0 overflow-hidden">
        <div className="mb-3 flex items-baseline gap-2 flex-wrap">
          <h3 className="text-base font-semibold text-neutral-100">
            {new Date(selectedDate + "T12:00:00Z").toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </h3>
          <span className="text-xs text-neutral-500">
            {selectedDayDecisions.length} decisions
          </span>
        </div>
        {selectedDayDecisions.length === 0 ? (
          <EmptyDayMessage dateKey={selectedDate} todayKey={todayKey} />
        ) : (
          <div className="space-y-2 flex-1 overflow-y-auto overflow-x-hidden pr-1 pb-4 min-h-0 min-w-0">
            {selectedDayDecisions.map((d) => (
              <DecisionDetail
                key={d.id}
                d={d}
                position={d.position_id ? positionsById.get(d.position_id) : undefined}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Centered empty-state shown when the selected day has no decision rows.
// Picks the message based on calendar context — weekend, future, today
// (pre-tick), or just a quiet past weekday — so users get a useful
// reason rather than a blank panel.
function EmptyDayMessage({ dateKey: k, todayKey }: { dateKey: string; todayKey: string }) {
  const [y, m, d] = k.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const dow = date.getDay(); // 0=Sun..6=Sat in local TZ

  let primary: string;
  let secondary: string | null = null;
  if (k > todayKey) {
    primary = "Future date";
    secondary = "Decisions arrive after the next post-close run.";
  } else if (dow === 0 || dow === 6) {
    primary = "Market closed";
    secondary = "Weekends and full-closure holidays don't run agents.";
  } else if (k === todayKey) {
    primary = "Today's run hasn't completed yet";
    secondary = "Agents tick at 22:10 UTC (≈ post-close ET).";
  } else {
    primary = "No decisions on this day";
    secondary = "Likely a market holiday or a missed run.";
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-4">
      <div className="text-sm text-neutral-300">{primary}</div>
      {secondary && <div className="text-xs text-neutral-500 mt-1">{secondary}</div>}
    </div>
  );
}

function DecisionDetail({
  d,
  position,
}: {
  d: DecisionRow;
  position?: PositionRow;
}) {
  // Show realized P&L only on *close-action* decision rows. We
  // deliberately don't surface it for open or hold rows even if the
  // linked position has since been closed by a later decision —
  // attaching the eventual realized number to the opening decision
  // would read as "the open was worth $X" which is the wrong attribution.
  const pnl =
    d.action === "close" &&
    position &&
    typeof position.realized_pnl === "number"
      ? position.realized_pnl
      : null;
  const pnlTone =
    pnl === null
      ? "text-neutral-500"
      : pnl > 0
        ? "text-emerald-300"
        : pnl < 0
          ? "text-rose-300"
          : "text-neutral-300";

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-3 text-xs">
      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
        <span className="font-mono font-semibold text-neutral-100 text-sm">{d.symbol}</span>
        <span className={`pill border text-[10px] ${actionTone(d.action)}`}>
          {capitalize(d.action.replace(/_/g, " "))}
        </span>
        {d.confidence !== null && (
          <span className="text-[10px] text-neutral-500">
            conf {Math.round(d.confidence * 100)}%
          </span>
        )}
        {pnl !== null && (
          <span className={`text-[11px] tabular-nums font-semibold ${pnlTone}`}>
            {pnl >= 0 ? "+" : ""}${fmtNum(pnl, 2)}
            <span className="text-[9px] text-neutral-500 font-normal ml-1">realized</span>
          </span>
        )}
        <span className="ml-auto text-[10px] text-neutral-600">
          {new Date(d.decided_at).toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </div>
      {d.reasoning && (
        <p className="text-neutral-300 leading-relaxed break-words">{d.reasoning}</p>
      )}
      {d.validation_notes && (
        <p className="text-amber-300/80 text-[10px] mt-1.5 italic">⚠ {d.validation_notes}</p>
      )}
    </div>
  );
}
