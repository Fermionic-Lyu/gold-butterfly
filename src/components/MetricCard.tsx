import type { ReactNode } from "react";

// Three-row internal layout pinned with flex so cards stay the same height
// regardless of whether `hint` is present. The hint slot is always rendered
// (non-breaking-space placeholder when empty) so a card without a footnote
// doesn't collapse and leave dead space above its neighbors.
export default function MetricCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: "default" | "good" | "bad" | "warn";
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-300"
      : tone === "bad"
        ? "text-red-300"
        : tone === "warn"
          ? "text-amber-300"
          : "text-neutral-100";
  return (
    <div className="card p-3 flex flex-col gap-1.5">
      <div className="text-[10px] uppercase tracking-wider text-neutral-400">
        {label}
      </div>
      <div className={`text-xl font-semibold tabular-nums ${toneClass}`}>
        {value}
      </div>
      <div className="text-[11px] text-neutral-500 mt-auto min-h-[1rem] leading-tight">
        {hint || " "}
      </div>
    </div>
  );
}
