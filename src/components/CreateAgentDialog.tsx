import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useAuth } from "../lib/AuthContext";
import { useInstruments } from "../lib/instruments";
import { createAgent } from "../lib/tradingAgents";
import {
  AVAILABLE_MODELS,
  FOCUS_TEMPLATES,
  type FocusKey,
  type FocusPreset,
} from "../lib/focusTemplates";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export default function CreateAgentDialog({ open, onClose, onCreated }: Props) {
  const { user } = useAuth();
  const { list: instruments, bySymbol } = useInstruments();
  const ndxSymbols = useMemo(
    () => instruments.map((i) => i.symbol).sort(),
    [instruments],
  );

  const [name, setName] = useState("");
  const [focus, setFocus] = useState<FocusKey>("premium_seller");
  const [model, setModel] = useState(AVAILABLE_MODELS[0].id);
  const [startingCapital, setStartingCapital] = useState(100000);
  const [minConf, setMinConf] = useState(0.62);
  const [maxConcurrent, setMaxConcurrent] = useState(5);
  const [maxPositionPct, setMaxPositionPct] = useState(0.2);
  const [maxConcentrationPct, setMaxConcentrationPct] = useState(0.3);
  const [minDte, setMinDte] = useState(25);
  const [maxDte, setMaxDte] = useState(50);
  const [watchedSymbols, setWatchedSymbols] = useState<string[]>([
    "AAPL",
    "MSFT",
    "NVDA",
    "AMZN",
    "META",
    "GOOGL",
    "TSLA",
  ]);
  const [symbolQuery, setSymbolQuery] = useState("");
  const [symbolDropdownOpen, setSymbolDropdownOpen] = useState(false);
  const MAX_WATCHED = 10;
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // When focus changes, repopulate the numeric defaults from the template.
  useEffect(() => {
    const t = FOCUS_TEMPLATES[focus];
    setMinConf(t.defaults.min_confidence_to_trade);
    setMaxConcurrent(t.defaults.max_concurrent_positions);
    setMaxPositionPct(t.defaults.max_position_size_pct);
    setMaxConcentrationPct(t.defaults.max_concentration_per_symbol_pct);
    setMinDte(t.defaults.min_dte);
    setMaxDte(t.defaults.max_dte);
  }, [focus]);

  // Reset form on close.
  useEffect(() => {
    if (!open) {
      setName("");
      setFocus("premium_seller");
      setModel(AVAILABLE_MODELS[0].id);
      setStartingCapital(100000);
      setSymbolQuery("");
      setErr(null);
    }
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Search results — only candidates that aren't already in the watched list.
  // Empty when the query is empty (we're using a search-to-add UX, not a
  // full toggle grid).
  const symbolMatches = useMemo(() => {
    const q = symbolQuery.trim().toLowerCase();
    if (!q) return [];
    const watchedSet = new Set(watchedSymbols);
    const out: string[] = [];
    for (const sym of ndxSymbols) {
      if (watchedSet.has(sym)) continue;
      const symLower = sym.toLowerCase();
      const name = bySymbol.get(sym)?.name?.toLowerCase() ?? "";
      if (symLower.includes(q) || name.includes(q)) out.push(sym);
      if (out.length >= 8) break;
    }
    return out;
  }, [symbolQuery, ndxSymbols, watchedSymbols, bySymbol]);

  // Compose preset from current state.
  const currentPreset: FocusPreset = useMemo(() => {
    const t = FOCUS_TEMPLATES[focus];
    return {
      max_concurrent_positions: maxConcurrent,
      max_position_size_pct: maxPositionPct,
      max_concentration_per_symbol_pct: maxConcentrationPct,
      min_confidence_to_trade: minConf,
      min_dte: minDte,
      max_dte: maxDte,
      profit_target_pct: t.defaults.profit_target_pct,
      manage_at_dte: t.defaults.manage_at_dte,
      stop_loss_pct: t.defaults.stop_loss_pct,
    };
  }, [focus, maxConcurrent, maxPositionPct, maxConcentrationPct, minConf, minDte, maxDte]);

  if (!open) return null;

  function addSymbol(sym: string) {
    setWatchedSymbols((curr) => {
      if (curr.includes(sym)) return curr;
      if (curr.length >= MAX_WATCHED) return curr;
      return [...curr, sym].sort();
    });
    setSymbolQuery("");
    setSymbolDropdownOpen(false);
  }

  function removeSymbol(sym: string) {
    setWatchedSymbols((curr) => curr.filter((s) => s !== sym));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!user) return;
    setErr(null);
    if (!name.trim()) {
      setErr("Name is required.");
      return;
    }
    if (watchedSymbols.length === 0) {
      setErr("Pick at least one symbol to watch.");
      return;
    }
    if (minDte >= maxDte) {
      setErr("Min DTE must be less than Max DTE.");
      return;
    }
    setSubmitting(true);
    try {
      const t = FOCUS_TEMPLATES[focus];
      const preset = {
        ...currentPreset,
        // Validator-only fields that aren't in the prompt.
        allowed_strategies: t.allowedStrategies,
        vol_view_required: t.volViewRequired,
      };
      const systemPrompt = t.buildSystemPrompt(currentPreset);
      await createAgent({
        userId: user.id,
        name: name.trim(),
        focus,
        model,
        systemPrompt,
        preset,
        watchedSymbols,
        startingCapital,
      });
      onCreated();
      onClose();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const t = FOCUS_TEMPLATES[focus];

  return (
    <>
      <div
        onClick={onClose}
        className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm"
        aria-hidden="true"
      />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <form
          onSubmit={onSubmit}
          className="relative w-full max-w-2xl max-h-[92vh] flex flex-col card pointer-events-auto"
        >
          {/* Sticky header */}
          <div className="flex items-start justify-between gap-3 px-6 pt-5 pb-4 border-b border-neutral-800 shrink-0">
            <div>
              <h2 className="text-xl font-semibold">Create custom agent</h2>
              <p className="text-xs text-neutral-500 mt-0.5">
                Pick a strategy + model and tune the rules. Your numbers go straight
                into the agent's system prompt and validator.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="btn-ghost h-8 w-8 p-0 shrink-0"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          {/* Scrollable body */}
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 min-h-0">
            {/* Name */}
            <div>
              <label className="block text-xs font-medium text-neutral-300 mb-1">
                Agent name
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. My GPT Premium Seller"
                maxLength={64}
                className="input w-full"
              />
            </div>

            {/* Focus */}
            <div>
              <label className="block text-xs font-medium text-neutral-300 mb-1">
                Strategy focus
              </label>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                {(Object.keys(FOCUS_TEMPLATES) as FocusKey[]).map((k) => {
                  const tt = FOCUS_TEMPLATES[k];
                  const active = focus === k;
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setFocus(k)}
                      className={`text-left rounded-lg border px-3 py-2 transition-colors ${
                        active
                          ? "border-gold-400/60 bg-gold-400/10"
                          : "border-neutral-800 hover:border-neutral-700 bg-neutral-900/40"
                      }`}
                    >
                      <div className="font-semibold text-sm text-neutral-100">
                        {tt.shortLabel}
                      </div>
                      <div className="text-[11px] text-neutral-500 mt-0.5">
                        {tt.tagline}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Model */}
            <div>
              <label className="block text-xs font-medium text-neutral-300 mb-1">
                Model
              </label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="input w-full"
              >
                {AVAILABLE_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Numeric grid */}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <NumberField
                label="Starting capital ($)"
                value={startingCapital}
                onChange={setStartingCapital}
                step={1000}
                min={1000}
                max={1_000_000}
              />
              <NumberField
                label="Confidence floor"
                value={minConf}
                onChange={setMinConf}
                step={0.01}
                min={0.5}
                max={0.95}
              />
              <NumberField
                label="Max concurrent"
                value={maxConcurrent}
                onChange={setMaxConcurrent}
                step={1}
                min={1}
                max={20}
              />
              <NumberField
                label="Max position % of capital"
                value={maxPositionPct}
                onChange={setMaxPositionPct}
                step={0.01}
                min={0.01}
                max={0.5}
              />
              <NumberField
                label="Max symbol concentration %"
                value={maxConcentrationPct}
                onChange={setMaxConcentrationPct}
                step={0.01}
                min={0.05}
                max={1.0}
              />
              <div className="grid grid-cols-2 gap-2">
                <NumberField
                  label="Min DTE"
                  value={minDte}
                  onChange={setMinDte}
                  step={1}
                  min={1}
                  max={120}
                />
                <NumberField
                  label="Max DTE"
                  value={maxDte}
                  onChange={setMaxDte}
                  step={1}
                  min={2}
                  max={400}
                />
              </div>
            </div>

            {/* Symbols — selected list + search-to-add */}
            <div>
              <div className="flex items-baseline justify-between mb-1.5">
                <label className="block text-xs font-medium text-neutral-300">
                  Watched symbols
                </label>
                <span className="text-[10px] text-neutral-500">
                  {watchedSymbols.length} / {MAX_WATCHED} · NDX-100 only
                </span>
              </div>

              {/* Selected chips */}
              <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-2 mb-2 min-h-[44px]">
                {watchedSymbols.length === 0 ? (
                  <p className="text-[11px] text-neutral-500 px-1 py-1">
                    No symbols yet — search below to add.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {watchedSymbols.map((sym) => (
                      <span
                        key={sym}
                        className="pill border bg-gold-400/15 border-gold-400/60 text-gold-200 font-mono text-[11px] gap-1.5"
                        title={bySymbol.get(sym)?.name ?? sym}
                      >
                        {sym}
                        <button
                          type="button"
                          onClick={() => removeSymbol(sym)}
                          className="text-gold-200/60 hover:text-rose-300 leading-none"
                          aria-label={`Remove ${sym}`}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Search-to-add — hidden once the cap is reached. */}
              {watchedSymbols.length >= MAX_WATCHED ? (
                <p className="text-[11px] text-neutral-500 italic">
                  Max {MAX_WATCHED} symbols selected. Remove one to add another.
                </p>
              ) : (
                <div className="relative">
                  <input
                    value={symbolQuery}
                    onChange={(e) => {
                      setSymbolQuery(e.target.value);
                      setSymbolDropdownOpen(true);
                    }}
                    onFocus={() => setSymbolDropdownOpen(true)}
                    onBlur={() => {
                      // Defer to allow click handlers on the dropdown to fire.
                      window.setTimeout(() => setSymbolDropdownOpen(false), 120);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && symbolMatches.length > 0) {
                        e.preventDefault();
                        addSymbol(symbolMatches[0]);
                      } else if (e.key === "Escape") {
                        setSymbolDropdownOpen(false);
                      }
                    }}
                    placeholder="Search by ticker or company…"
                    className="input w-full"
                  />
                  {symbolDropdownOpen && symbolQuery.trim() && (
                    <div className="absolute top-full left-0 right-0 mt-1 z-10 bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden shadow-2xl max-h-60 overflow-y-auto">
                      {symbolMatches.length === 0 ? (
                        <div className="px-3 py-2 text-[11px] text-neutral-500">
                          No NDX-100 matches.
                        </div>
                      ) : (
                        <ul>
                          {symbolMatches.map((sym, i) => (
                            <li key={sym}>
                              <button
                                type="button"
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  addSymbol(sym);
                                }}
                                className={`w-full text-left flex items-center gap-3 px-3 py-2 hover:bg-neutral-800 ${
                                  i === 0 ? "bg-neutral-900/70" : ""
                                }`}
                              >
                                <span className="font-mono font-semibold text-neutral-100 min-w-[60px] text-[12px]">
                                  {sym}
                                </span>
                                <span className="text-[11px] text-neutral-400 truncate">
                                  {bySymbol.get(sym)?.name ?? "—"}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Methodology preview */}
            <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-3 text-[11px] text-neutral-400">
              <div className="text-neutral-300 font-medium mb-1">Methodology preview</div>
              <div>
                <span className="text-neutral-500">vol regime:</span>{" "}
                {t.volViewRequired.replace("_", " ")}
              </div>
              <div className="mt-0.5">
                <span className="text-neutral-500">allowed strategies:</span>{" "}
                {t.allowedStrategies.map((s) => s.replace(/_/g, " ")).join(", ")}
              </div>
              <details className="mt-2">
                <summary className="cursor-pointer text-neutral-300 hover:text-neutral-100">
                  Show full system prompt (with your numbers filled in)
                </summary>
                <pre className="mt-2 whitespace-pre-wrap text-[10.5px] text-neutral-400 max-h-56 overflow-y-auto">
                  {t.buildSystemPrompt(currentPreset)}
                </pre>
              </details>
            </div>

            {err && <p className="text-sm text-red-400">{err}</p>}
          </div>

          {/* Sticky footer */}
          <div className="flex items-center justify-end gap-2 px-6 py-3 border-t border-neutral-800 shrink-0">
            <button type="button" onClick={onClose} className="btn-ghost">
              Cancel
            </button>
            <button type="submit" disabled={submitting} className="btn-primary">
              {submitting ? "Creating…" : "Create agent"}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}

function NumberField({
  label,
  value,
  onChange,
  step,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  step: number;
  min: number;
  max: number;
}) {
  return (
    <label className="block">
      <span className="block text-[10px] uppercase tracking-wider text-neutral-500 mb-0.5">
        {label}
      </span>
      <input
        type="number"
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
        step={step}
        min={min}
        max={max}
        className="input w-full"
      />
    </label>
  );
}
