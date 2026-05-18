// Star toggle for adding/removing the current symbol to the watchlist.
// Hidden for anon users (watchlist is a signed-in feature). Uses the
// SubscriptionsContext's optimistic add/remove — no spinner, no disabled
// state, the star flips instantly on click.

import { useMemo } from "react";
import { useAuth } from "../lib/AuthContext";
import { useSubscriptions } from "../lib/SubscriptionsContext";

export default function WatchlistStarButton({ symbol }: { symbol: string }) {
  const { user } = useAuth();
  const { subscriptions, addSymbol, removeSubscription } = useSubscriptions();

  const subscribed = useMemo(
    () => subscriptions.find((s) => s.symbol === symbol) ?? null,
    [subscriptions, symbol],
  );

  if (!user) return null;

  function toggle() {
    if (subscribed) {
      // Fire-and-forget. SubscriptionsContext reverts the local state if the
      // server call fails; the user sees an instant flip either way.
      void removeSubscription(subscribed.id);
    } else {
      void addSymbol(symbol);
    }
  }

  const isOn = !!subscribed;
  return (
    <button
      type="button"
      onClick={toggle}
      title={isOn ? "Remove from watchlist" : "Add to watchlist"}
      aria-label={isOn ? "Remove from watchlist" : "Add to watchlist"}
      aria-pressed={isOn}
      className={`inline-flex items-center justify-center h-8 w-8 rounded-lg border transition-colors ${
        isOn
          ? "bg-gold-400/15 border-gold-400/60 text-gold-300 hover:bg-gold-400/25"
          : "bg-neutral-900 border-neutral-700 text-neutral-500 hover:text-gold-300 hover:border-neutral-600"
      }`}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 20 20"
        fill={isOn ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <path
          strokeLinejoin="round"
          d="M9.05 3.55a1.06 1.06 0 011.9 0l1.78 3.6 3.97.58c.86.13 1.2 1.18.58 1.78l-2.87 2.8.68 3.95c.15.85-.75 1.5-1.51 1.1l-3.55-1.86-3.55 1.86c-.76.4-1.66-.25-1.51-1.1l.68-3.95-2.87-2.8c-.62-.6-.28-1.65.58-1.78l3.97-.58 1.78-3.6z"
        />
      </svg>
    </button>
  );
}
