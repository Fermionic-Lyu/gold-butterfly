// Skeleton placeholder for the symbol page. Mirrors the section layout of
// Dashboard.tsx so the user sees the right cards "outlined" while the chain
// fetch is in flight, instead of a single "Loading…" line.

function Bar({ className = "" }: { className?: string }) {
  return <div className={`bg-neutral-800/70 rounded animate-pulse ${className}`} />;
}

function Box({ className = "" }: { className?: string }) {
  return <div className={`bg-neutral-800/40 rounded animate-pulse ${className}`} />;
}

export default function SymbolPageSkeleton({ symbol }: { symbol?: string }) {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading symbol page">
      {/* Header card */}
      <div className="card p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-3">
            <div className="flex items-baseline gap-3 flex-wrap">
              {symbol ? (
                <span className="text-3xl font-bold tracking-tight font-mono text-gold-300/40">
                  {symbol}
                </span>
              ) : (
                <Bar className="h-8 w-28" />
              )}
              <Bar className="h-5 w-44" />
              <Bar className="h-5 w-12" />
              <Bar className="h-5 w-12" />
            </div>
            <div className="flex items-baseline gap-3">
              <Bar className="h-7 w-32" />
              <Bar className="h-5 w-16" />
            </div>
            <Bar className="h-3 w-72" />
          </div>
          <div className="flex items-center gap-2">
            <Bar className="h-7 w-32" />
            <Bar className="h-7 w-20" />
          </div>
        </div>
      </div>

      {/* Metrics row */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-3">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="card p-4 space-y-2">
            <Bar className="h-3 w-16" />
            <Bar className="h-6 w-20" />
            <Bar className="h-3 w-24" />
          </div>
        ))}
      </div>

      {/* Regime card */}
      <div className="card p-4 space-y-2">
        <Bar className="h-3 w-20" />
        <div className="flex gap-2 flex-wrap">
          <Bar className="h-5 w-24" />
          <Bar className="h-5 w-28" />
          <Bar className="h-5 w-24" />
          <Bar className="h-5 w-20" />
        </div>
        <Bar className="h-3 w-full" />
        <Bar className="h-3 w-3/4" />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="card p-4">
            <div className="flex justify-between mb-3">
              <Bar className="h-5 w-32" />
              <Bar className="h-3 w-20" />
            </div>
            <Box className="h-52 w-full" />
          </div>
        ))}
      </div>

      {/* Option chain card */}
      <div className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <Bar className="h-6 w-32" />
          <div className="flex gap-1">
            {Array.from({ length: 5 }).map((_, i) => (
              <Bar key={i} className="h-6 w-12" />
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-1 mb-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Bar key={i} className="h-5 w-16" />
          ))}
        </div>
        <div className="space-y-1">
          {Array.from({ length: 9 }).map((_, i) => (
            <Bar key={i} className="h-7 w-full" />
          ))}
        </div>
      </div>

      {/* Strategy panel */}
      <div className="card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <Bar className="h-5 w-56" />
            <Bar className="h-3 w-80" />
          </div>
          <Bar className="h-9 w-32" />
        </div>
      </div>
    </div>
  );
}
