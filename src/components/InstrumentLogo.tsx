// Inline company-logo image with a graceful fallback when the source is
// missing or fails to load. Used in the dashboard header, watchlist drawer,
// and search dropdown.

import { useState } from "react";

interface Props {
  symbol: string;
  url?: string | null;
  className?: string;
}

export default function InstrumentLogo({ symbol, url, className }: Props) {
  const [errored, setErrored] = useState(false);

  if (!url || errored) {
    // Initials-style fallback: a small dark square with the first letter.
    const initial = symbol.slice(0, 1);
    return (
      <span
        className={`inline-flex items-center justify-center bg-neutral-800 text-neutral-400 text-[11px] font-mono font-semibold rounded ${className ?? "w-6 h-6"}`}
        aria-hidden="true"
      >
        {initial}
      </span>
    );
  }
  return (
    <img
      src={url}
      alt=""
      className={`bg-white rounded object-contain ${className ?? "w-6 h-6 p-0.5"}`}
      loading="lazy"
      onError={() => setErrored(true)}
    />
  );
}
