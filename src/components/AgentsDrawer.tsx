import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  computeReturnsFromSummary,
  deleteAgent,
  useAgents,
  useAgentsSummary,
  type AgentRow,
  type AgentSummary,
} from "../lib/tradingAgents";
import { useAuth } from "../lib/AuthContext";
import { fmtCurrency, fmtPct } from "../lib/format";
import CreateAgentDialog from "./CreateAgentDialog";

const FOCUS_LABEL: Record<string, string> = {
  premium_seller: "Theta · Premium Seller",
  long_vol: "Vega · Volatility Hunter",
  directional_momentum: "Delta · Trend Rider",
};

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function AgentsDrawer({ open, onClose }: Props) {
  const { agents, loading, refresh } = useAgents();
  // Live per-agent equity/positions. Single RPC for all agents; rows
  // read their slug's entry rather than each running its own query.
  const { summaries } = useAgentsSummary();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { slug: activeSlug } = useParams();
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Split into defaults vs the current user's custom agents.
  const { defaults, custom } = useMemo(() => {
    const def: AgentRow[] = [];
    const own: AgentRow[] = [];
    for (const a of agents) {
      if (a.user_id === null) def.push(a);
      else if (user && a.user_id === user.id) own.push(a);
    }
    return { defaults: def, custom: own };
  }, [agents, user]);

  // Group defaults by focus (preserves matrix-row layout from the existing UI).
  const defaultGroups = useMemo(() => {
    const map = new Map<string, AgentRow[]>();
    for (const a of defaults) {
      if (!map.has(a.focus)) map.set(a.focus, []);
      map.get(a.focus)!.push(a);
    }
    return [...map.entries()];
  }, [defaults]);

  async function handleDelete(agent: AgentRow) {
    if (!confirm(`Delete agent "${agent.name}"? Its positions and history go with it.`)) return;
    try {
      await deleteAgent(agent.id);
      refresh();
      // If we just deleted the agent the user is currently viewing, bounce home.
      if (activeSlug === agent.slug) navigate("/");
    } catch (e: any) {
      alert(`Failed to delete: ${e?.message ?? e}`);
    }
  }

  return (
    <>
      <div
        aria-hidden={!open}
        onClick={onClose}
        className={`fixed inset-0 z-40 bg-black/60 transition-opacity ${
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      />
      <aside
        role="dialog"
        aria-label="Lab agents"
        aria-modal="true"
        className={`fixed top-0 left-0 z-50 h-full w-full sm:w-[420px] bg-neutral-950 border-r border-neutral-800 shadow-2xl transition-transform duration-200 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-800">
          <div>
            <div className="text-lg font-semibold tracking-tight">Trading Lab</div>
            <div className="text-xs text-neutral-500 mt-0.5">
              {defaults.length} default · {custom.length} custom
            </div>
          </div>
          <button
            type="button"
            className="btn-ghost h-8 w-8 p-0"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="overflow-y-auto h-[calc(100%-65px)] px-3 py-3">
          {user && (
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="btn-primary w-full justify-center mb-4"
            >
              + Create custom agent
            </button>
          )}

          {loading ? (
            <p className="text-sm text-neutral-500 px-2">Loading…</p>
          ) : (
            <div className="space-y-5">
              {/* Default agents (visible to everyone) */}
              <div>
                <div className="text-xs uppercase tracking-wider font-semibold text-neutral-300 px-2 mb-2">
                  Default presets
                </div>
                <div className="space-y-3">
                  {defaultGroups.map(([focus, rowAgents]) => (
                    <div key={focus}>
                      <div className="text-[10px] text-neutral-600 px-2 mb-1">
                        {FOCUS_LABEL[focus] ?? focus.replace(/_/g, " ")}
                      </div>
                      <ul className="space-y-1">
                        {rowAgents.map((a) => (
                          <AgentDrawerRow
                            key={a.id}
                            agent={a}
                            summary={summaries[a.slug] ?? null}
                            active={activeSlug === a.slug}
                            onClick={() => {
                              navigate(`/agents/${a.slug}`);
                              onClose();
                            }}
                          />
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>

              {/* User's custom agents */}
              {user && (
                <div>
                  <div className="text-xs uppercase tracking-wider font-semibold text-neutral-300 px-2 mb-2">
                    Your agents
                  </div>
                  {custom.length === 0 ? (
                    <p className="text-xs text-neutral-500 px-2">
                      None yet. Click "Create custom agent" above to spin up your first one.
                    </p>
                  ) : (
                    <ul className="space-y-1">
                      {custom.map((a) => (
                        <AgentDrawerRow
                          key={a.id}
                          agent={a}
                          summary={summaries[a.slug] ?? null}
                          active={activeSlug === a.slug}
                          onClick={() => {
                            navigate(`/agents/${a.slug}`);
                            onClose();
                          }}
                          onDelete={() => handleDelete(a)}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </aside>

      <CreateAgentDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => refresh()}
      />
    </>
  );
}

function AgentDrawerRow({
  agent,
  summary,
  active,
  onClick,
  onDelete,
}: {
  agent: AgentRow;
  summary: AgentSummary | null;
  active: boolean;
  onClick: () => void;
  onDelete?: () => void;
}) {
  // Live MTM via the shared summary; fall back to starting capital while
  // the RPC is loading so the row shows something rather than blanks.
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
  const modelShort = agent.model.split("/").pop() ?? agent.model;

  return (
    <li>
      <div
        className={`group relative w-full rounded-lg transition-colors ${
          active
            ? "bg-gold-400/10 ring-1 ring-gold-400/40"
            : "hover:bg-neutral-800"
        }`}
      >
        <button type="button" onClick={onClick} className="w-full text-left px-3 py-2">
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="font-semibold text-neutral-100 text-sm truncate">{agent.name}</span>
            {returns.todayChangePct !== null && (
              <span
                className={`text-[11px] font-semibold tabular-nums shrink-0 ${
                  returns.todayChangePct > 0
                    ? "text-emerald-300"
                    : returns.todayChangePct < 0
                      ? "text-rose-300"
                      : "text-neutral-400"
                }`}
              >
                {returns.todayChangePct >= 0 ? "+" : ""}
                {fmtPct(returns.todayChangePct, 2)}
              </span>
            )}
          </div>
          <div className="flex items-center justify-between gap-2 text-[11px] text-neutral-500">
            <span className="font-mono truncate">{modelShort}</span>
            <span className="tabular-nums">
              {fmtCurrency(returns.totalEquity)}
              {returns.totalReturnPct !== null && (
                <span
                  className={`ml-1 ${
                    returns.totalReturnPct > 0
                      ? "text-emerald-400/70"
                      : returns.totalReturnPct < 0
                        ? "text-rose-400/70"
                        : ""
                  }`}
                >
                  ({returns.totalReturnPct >= 0 ? "+" : ""}
                  {fmtPct(returns.totalReturnPct, 1)})
                </span>
              )}
            </span>
          </div>
        </button>
        {onDelete && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 text-[10px] text-neutral-500 hover:text-red-300 px-1.5 py-0.5"
            aria-label={`Delete ${agent.name}`}
            title="Delete"
          >
            delete
          </button>
        )}
      </div>
    </li>
  );
}
