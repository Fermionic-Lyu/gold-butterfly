import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { insforge } from "../lib/insforge";
import { fmtNum, fmtPct } from "../lib/format";
import Markdown from "./Markdown";

interface Props {
  symbol: string;
  userId: string | null;
  summary: unknown;
}

interface Leg {
  action: "buy" | "sell";
  right: "call" | "put";
  symbol?: string;
  strike: number;
  expiration: string;
  delta: number | null;
  qty: number;
}

interface Strategy {
  name: string;
  structure: string;
  bias: "bullish" | "bearish" | "neutral";
  vol_view: "long_vol" | "short_vol" | "neutral_vol";
  horizon_tag: string;
  legs: Leg[];
  credit_or_debit: "credit" | "debit";
  estimated_credit_or_debit_per_contract: number;
  max_loss_per_contract_group: number;
  max_gain_per_contract_group: number | null;
  breakevens: number[];
  pop_estimate: number | null;
  rationale: string;
  primary_risk: string;
  management: string;
}

interface Analysis {
  regime_summary: string;
  primary_view: { volatility: string; direction: string };
  strategies: Strategy[];
  caveats: string;
}

interface AnalysisRow {
  id: string;
  symbol: string;
  generated_at: string;
  analysis: Analysis;
  model: string | null;
}

export default function StrategyPanel({ symbol, userId, summary }: Props) {
  const queryClient = useQueryClient();
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [rawFallback, setRawFallback] = useState<string | null>(null);

  const isAuthed = Boolean(userId);
  const historyKey = ["strategy_analyses", symbol] as const;

  const historyQuery = useQuery<AnalysisRow[]>({
    queryKey: historyKey,
    enabled: isAuthed,
    queryFn: async () => {
      const { data, error } = await insforge.database
        .from("strategy_analyses")
        .select("id,symbol,generated_at,analysis,model")
        .eq("symbol", symbol)
        .order("generated_at", { ascending: false })
        .limit(10);
      if (error) throw error;
      return (data ?? []) as AnalysisRow[];
    },
  });
  const history = historyQuery.data ?? [];

  // Selected row = the explicit pick if still present, else the freshest.
  const current = useMemo(() => {
    if (currentId) {
      const hit = history.find((r) => r.id === currentId);
      if (hit) return hit;
    }
    return history[0] ?? null;
  }, [history, currentId]);

  // Reset explicit selection + raw-text fallback when navigating between
  // symbols — otherwise switching from NVDA to AAPL would briefly try
  // to render NVDA's selected analysis against AAPL's history.
  useEffect(() => {
    setCurrentId(null);
    setRawFallback(null);
  }, [symbol]);

  const runMutation = useMutation<AnalysisRow | { raw: string } | null, Error, void>({
    mutationFn: async () => {
      const { data, error } = await insforge.functions.invoke("strategy-analysis", {
        body: { symbol, summary },
      });
      if (error) throw error;
      const a = (data as any)?.analysis;
      const raw = (data as any)?.raw;
      const model = (data as any)?.model ?? null;
      const generatedAt = (data as any)?.generatedAt ?? new Date().toISOString();
      if (a && typeof a === "object") {
        // Persist to DB so the user can revisit later. Non-fatal: still
        // surface the result even if the row insert fails.
        const { data: ins, error: insErr } = await insforge.database
          .from("strategy_analyses")
          .insert([
            { user_id: userId, symbol, snapshot: summary, analysis: a, model, generated_at: generatedAt },
          ])
          .select("id,symbol,generated_at,analysis,model");
        if (insErr) console.warn("Failed to persist analysis:", insErr);
        const row: AnalysisRow = ins && (ins as any[])[0]
          ? ((ins as any[])[0] as AnalysisRow)
          : { id: crypto.randomUUID(), symbol, generated_at: generatedAt, analysis: a as Analysis, model };
        return row;
      }
      if (raw) return { raw: String(raw) };
      throw new Error("No analysis returned.");
    },
    onSuccess: (result) => {
      if (!result) return;
      if ("raw" in result) {
        setRawFallback(result.raw);
        return;
      }
      // Prepend the new row to the cached history and select it.
      queryClient.setQueryData<AnalysisRow[]>(historyKey, (curr) =>
        [result, ...(curr ?? [])].slice(0, 10),
      );
      setCurrentId(result.id);
      setRawFallback(null);
    },
  });
  const loading = runMutation.isPending;
  const err = runMutation.error ? String(runMutation.error?.message ?? runMutation.error) : null;

  const deleteMutation = useMutation<void, Error, string>({
    mutationFn: async (id: string) => {
      const { error } = await insforge.database.from("strategy_analyses").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_void, id) => {
      queryClient.setQueryData<AnalysisRow[]>(historyKey, (curr) =>
        (curr ?? []).filter((r) => r.id !== id),
      );
      // If the deleted row was the explicit pick, fall back to default.
      setCurrentId((sel) => (sel === id ? null : sel));
    },
  });

  const run = () => runMutation.mutate();
  const deleteRow = (id: string) => deleteMutation.mutate(id);

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <div>
          <h2 className="text-lg font-semibold">AI Strategy Recommendation</h2>
          <p className="text-xs text-neutral-500">
            TastyTrade-style decision rules — vol view first (IV/HV richness), skew second,
            direction third. Educational, not financial advice.
          </p>
        </div>
        {isAuthed ? (
          <button onClick={run} disabled={loading} className="btn-primary whitespace-nowrap">
            {loading ? "Analyzing…" : current ? "Re-analyze" : "Analyze with AI"}
          </button>
        ) : (
          <Link to="/auth" className="btn-primary whitespace-nowrap">
            Sign in to analyze
          </Link>
        )}
      </div>

      {err && <p className="text-sm text-red-400 mt-2">{err}</p>}

      {isAuthed && history.length > 0 && (
        <HistoryStrip
          history={history}
          activeId={current?.id ?? null}
          onSelect={(r) => setCurrentId(r.id)}
          onDelete={deleteRow}
        />
      )}

      {current && <AnalysisView a={current.analysis} generatedAt={current.generated_at} model={current.model} />}

      {!current && rawFallback && (
        <pre className="mt-4 text-xs whitespace-pre-wrap bg-neutral-900 border border-neutral-800 rounded-lg p-3 text-neutral-300 max-h-80 overflow-auto">
          {rawFallback}
        </pre>
      )}

      {!loading && !current && !rawFallback && !err && (
        <p className="text-sm text-neutral-500 mt-4">
          {isAuthed
            ? "Press \"Analyze with AI\" to get strategy ideas based on the current chain."
            : "Sign in to run AI strategy analysis on this chain — chooses 3 ideas based on vol regime, skew, and IV rank."}
        </p>
      )}
    </div>
  );
}

function HistoryStrip({
  history,
  activeId,
  onSelect,
  onDelete,
}: {
  history: AnalysisRow[];
  activeId: string | null;
  onSelect: (r: AnalysisRow) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="mb-4">
      <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1">
        Past analyses ({history.length})
      </div>
      <div className="flex flex-wrap gap-1">
        {history.map((r) => {
          const active = r.id === activeId;
          return (
            <span key={r.id} className="inline-flex items-stretch">
              <button
                onClick={() => onSelect(r)}
                className={`pill border rounded-r-none ${
                  active
                    ? "bg-gold-400/15 border-gold-400/60 text-gold-200"
                    : "bg-neutral-900 border-neutral-700 text-neutral-300 hover:bg-neutral-800"
                }`}
                title={new Date(r.generated_at).toLocaleString()}
              >
                {new Date(r.generated_at).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </button>
              <button
                onClick={() => {
                  if (confirm("Delete this analysis?")) onDelete(r.id);
                }}
                className="pill border border-l-0 rounded-l-none bg-neutral-900 text-neutral-500 hover:text-red-300 hover:bg-neutral-800 border-neutral-700 px-1.5"
                aria-label="Delete"
                title="Delete"
              >
                ×
              </button>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function AnalysisView({
  a,
  generatedAt,
  model,
}: {
  a: Analysis;
  generatedAt: string;
  model: string | null;
}) {
  const strategies = useMemo(() => a.strategies ?? [], [a]);
  return (
    <div className="mt-2 space-y-4">
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
        <div className="flex items-center gap-2 flex-wrap mb-2">
          <span className="text-[10px] uppercase tracking-wider text-neutral-400">Regime</span>
          <span className="pill bg-neutral-800 text-neutral-300">
            vol: {a.primary_view?.volatility?.replace("_", " ") ?? "—"}
          </span>
          <span className="pill bg-neutral-800 text-neutral-300">
            direction: {a.primary_view?.direction ?? "—"}
          </span>
        </div>
        {a.regime_summary && <Markdown>{a.regime_summary}</Markdown>}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {strategies.map((s, i) => <StrategyCard key={i} s={s} />)}
      </div>

      {a.caveats && (
        <div className="border-t border-neutral-800 pt-3">
          <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1">
            Caveats
          </div>
          <Markdown className="text-xs">{a.caveats}</Markdown>
        </div>
      )}

      <p className="text-[11px] text-neutral-500">
        generated {new Date(generatedAt).toLocaleString()}
        {model && <> · {model}</>}
      </p>
    </div>
  );
}

function biasTone(b: Strategy["bias"]) {
  if (b === "bullish") return "bg-emerald-900/40 text-emerald-300 border-emerald-800";
  if (b === "bearish") return "bg-rose-900/40 text-rose-300 border-rose-800";
  return "bg-neutral-800 text-neutral-300 border-neutral-700";
}
function volTone(v: Strategy["vol_view"]) {
  if (v === "short_vol") return "bg-amber-900/30 text-amber-300 border-amber-800";
  if (v === "long_vol") return "bg-sky-900/30 text-sky-300 border-sky-800";
  return "bg-neutral-800 text-neutral-300 border-neutral-700";
}

function StrategyCard({ s }: { s: Strategy }) {
  const isCredit = s.credit_or_debit === "credit";
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 flex flex-col gap-3">
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="font-semibold text-neutral-100">{s.name}</h3>
          <span className="text-[10px] text-neutral-500 uppercase tracking-wider">
            {s.horizon_tag?.replace("_", " ")}
          </span>
        </div>
        <div className="flex items-center gap-1 flex-wrap mt-1.5">
          <span className={`pill border ${biasTone(s.bias)}`}>{s.bias}</span>
          <span className={`pill border ${volTone(s.vol_view)}`}>
            {s.vol_view?.replace("_", " ")}
          </span>
          <span className="pill bg-neutral-800 text-neutral-400 border border-neutral-700">
            {isCredit ? "credit" : "debit"}
          </span>
        </div>
      </div>

      <div className="rounded-lg border border-neutral-800 overflow-hidden">
        <table className="w-full text-[11px] tabular-nums">
          <thead className="bg-neutral-900 text-neutral-500 uppercase tracking-wider">
            <tr>
              <th className="px-2 py-1 text-left">Action</th>
              <th className="px-2 py-1 text-left">Right</th>
              <th className="px-2 py-1 text-right">Strike</th>
              <th className="px-2 py-1 text-left">Expiry</th>
              <th className="px-2 py-1 text-right">Δ</th>
              <th className="px-2 py-1 text-right">Qty</th>
            </tr>
          </thead>
          <tbody>
            {s.legs?.map((l, i) => (
              <tr key={i} className="border-t border-neutral-800/70">
                <td
                  className={`px-2 py-1 font-semibold ${
                    l.action === "sell" ? "text-rose-300" : "text-emerald-300"
                  }`}
                >
                  {l.action}
                </td>
                <td className="px-2 py-1 text-neutral-300">{l.right}</td>
                <td className="px-2 py-1 text-right text-neutral-100">{fmtNum(l.strike, 2)}</td>
                <td className="px-2 py-1 text-neutral-400">{l.expiration}</td>
                <td className="px-2 py-1 text-right text-neutral-300">{fmtNum(l.delta, 2)}</td>
                <td className="px-2 py-1 text-right text-neutral-300">{l.qty ?? 1}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dl className="grid grid-cols-2 gap-2 text-[11px]">
        <Stat
          label={isCredit ? "Credit" : "Debit"}
          value={`$${fmtNum(s.estimated_credit_or_debit_per_contract, 2)}`}
        />
        <Stat label="POP" value={s.pop_estimate !== null ? fmtPct(s.pop_estimate, 0) : "—"} />
        <Stat label="Max gain" value={`$${fmtNum(s.max_gain_per_contract_group, 2)}`} />
        <Stat label="Max loss" value={`$${fmtNum(s.max_loss_per_contract_group, 2)}`} tone="bad" />
        {s.breakevens?.length > 0 && (
          <Stat
            label="Breakevens"
            value={s.breakevens.map((b) => fmtNum(b, 2)).join(" / ")}
            wide
          />
        )}
      </dl>

      <div className="text-xs text-neutral-300 leading-relaxed">
        <Markdown>{s.rationale}</Markdown>
      </div>
      <div className="text-[11px] text-rose-300/80 leading-relaxed">
        <span className="text-neutral-500">Risk: </span>
        <Markdown>{s.primary_risk}</Markdown>
      </div>
      <div className="text-[11px] text-neutral-400 leading-relaxed">
        <span className="text-neutral-500">Manage: </span>
        <Markdown>{s.management}</Markdown>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  wide,
}: {
  label: string;
  value: string;
  tone?: "good" | "bad";
  wide?: boolean;
}) {
  return (
    <div className={`rounded-md bg-neutral-950 border border-neutral-800 px-2 py-1.5 ${wide ? "col-span-2" : ""}`}>
      <div className="text-[9px] uppercase tracking-wider text-neutral-500">{label}</div>
      <div
        className={`text-sm font-semibold tabular-nums ${
          tone === "bad" ? "text-rose-300" : tone === "good" ? "text-emerald-300" : "text-neutral-100"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
