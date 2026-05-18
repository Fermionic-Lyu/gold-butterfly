import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useSubscriptions } from "../lib/SubscriptionsContext";
import {
  searchInstruments,
  useInstruments,
  type Instrument,
} from "../lib/instruments";
import InstrumentLogo from "./InstrumentLogo";

export default function SymbolAddBar() {
  const { subscriptions } = useSubscriptions();
  const { list } = useInstruments();
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const subscribedSet = useMemo(
    () => new Set(subscriptions.map((s) => s.symbol)),
    [subscriptions],
  );

  const matches = useMemo(() => searchInstruments(list, value, 8), [list, value]);

  useEffect(() => {
    setActive(0);
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  // Search is search-only now: navigate to the symbol's dashboard regardless
  // of watchlist membership. Adding to the watchlist happens via the Star
  // button on the dashboard itself.
  function commit(rawSymbol: string) {
    setErr(null);
    const upper = rawSymbol.trim().toUpperCase();
    if (!upper) return;
    setValue("");
    setOpen(false);
    inputRef.current?.blur();
    navigate(`/symbols/${upper}`);
  }

  function pickActive() {
    if (matches.length > 0) {
      const m = matches[Math.min(active, matches.length - 1)];
      commit(m.symbol);
      return;
    }
    if (value.trim()) commit(value.trim().toUpperCase());
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    pickActive();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      setOpen(true);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(matches.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Enter" && open) {
      e.preventDefault();
      pickActive();
    }
  }

  return (
    <div ref={wrapRef} className="relative w-full">
      <form onSubmit={onSubmit} className="flex items-center gap-2">
        <div className="relative flex-1">
          <svg
            width="14"
            height="14"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500 pointer-events-none"
          >
            <path
              fillRule="evenodd"
              d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.45 4.39l3.08 3.08a.75.75 0 11-1.06 1.06l-3.08-3.08A7 7 0 012 9z"
              clipRule="evenodd"
            />
          </svg>
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setOpen(true);
              if (err) setErr(null);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            placeholder="Search by symbol or company name"
            maxLength={48}
            className="input w-full pl-9"
            aria-label="Search ticker or company name"
            aria-autocomplete="list"
            aria-expanded={open}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <button type="submit" className="btn-primary" disabled={!value.trim()}>
          View
        </button>
      </form>

      {open && value.trim() && (
        <div
          role="listbox"
          className="absolute top-full left-0 right-0 mt-1 z-40 bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden shadow-2xl"
        >
          {matches.length === 0 ? (
            <div className="px-3 py-3 text-sm text-neutral-400">
              No match in S&amp;P 500 / Nasdaq-100. Press{" "}
              <span className="font-mono text-neutral-200">Enter</span> to add{" "}
              <span className="font-mono text-gold-300">{value.trim().toUpperCase()}</span> anyway.
            </div>
          ) : (
            <ul className="max-h-80 overflow-y-auto">
              {matches.map((m, idx) => (
                <SuggestionRow
                  key={m.symbol}
                  inst={m}
                  active={idx === active}
                  subscribed={subscribedSet.has(m.symbol)}
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => commit(m.symbol)}
                />
              ))}
            </ul>
          )}
        </div>
      )}

      {err && (
        <div className="absolute top-full left-0 right-0 mt-1 text-xs text-red-400 px-1">
          {err}
        </div>
      )}
    </div>
  );
}

function SuggestionRow({
  inst,
  active,
  subscribed,
  onMouseEnter,
  onClick,
}: {
  inst: Instrument;
  active: boolean;
  subscribed: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
}) {
  return (
    <li
      role="option"
      aria-selected={active}
      onMouseEnter={onMouseEnter}
      onMouseDown={(e) => {
        e.preventDefault();
        onClick();
      }}
      className={`flex items-center gap-3 px-3 py-2 cursor-pointer ${
        active ? "bg-gold-400/10" : "hover:bg-neutral-800/70"
      }`}
    >
      <InstrumentLogo symbol={inst.symbol} url={inst.logo_url} className="w-7 h-7 p-0.5 shrink-0" />
      <span className="font-mono font-semibold text-neutral-100 min-w-[60px]">{inst.symbol}</span>
      <span className="flex-1 text-sm text-neutral-300 truncate">{inst.name}</span>
      <span className="flex items-center gap-1">
        {inst.indices.map((idx) => (
          <span
            key={idx}
            className="pill bg-neutral-800 text-[10px] text-neutral-300 border border-neutral-700"
          >
            {idx}
          </span>
        ))}
        {subscribed && (
          <span className="pill bg-emerald-900/40 text-emerald-300 text-[10px] border border-emerald-800">
            ★
          </span>
        )}
      </span>
    </li>
  );
}
