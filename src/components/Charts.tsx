import { useMemo } from "react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  CartesianGrid,
  Legend,
} from "recharts";
import { fmtPct, fmtCompact, fmtNum } from "../lib/format";

const axis = { stroke: "#525252", fontSize: 11 };
const grid = { stroke: "#262626", strokeDasharray: "3 3" };

export function SkewChart({
  data,
  spot,
}: {
  data: { strike: number; callIV: number | null; putIV: number | null }[];
  spot: number | null;
}) {
  return (
    <div className="card p-4">
      <h3 className="text-sm font-semibold mb-2">IV Skew</h3>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid {...grid} />
          <XAxis dataKey="strike" tick={axis} tickFormatter={(v) => fmtNum(v, 0)} />
          <YAxis tick={axis} tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} domain={["auto", "auto"]} />
          <Tooltip
            contentStyle={{ background: "#171717", border: "1px solid #404040", fontSize: 12 }}
            labelStyle={{ color: "#a3a3a3" }}
            formatter={(v: any) => fmtPct(v, 2)}
            labelFormatter={(v) => `Strike ${fmtNum(v as number, 2)}`}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {spot !== null && (
            <ReferenceLine x={spot} stroke="#eeb71b" strokeDasharray="4 4" label={{ value: "spot", fontSize: 10, fill: "#eeb71b" }} />
          )}
          <Line type="monotone" dataKey="callIV" name="Call IV" stroke="#34d399" dot={false} strokeWidth={2} />
          <Line type="monotone" dataKey="putIV" name="Put IV" stroke="#fb7185" dot={false} strokeWidth={2} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface TermStructureMarker {
  /** YYYY-MM-DD */
  date: string;
  /** Short label rendered next to the vertical line. */
  label: string;
  /** Stroke + label color. */
  color: string;
}

export function TermStructureChart({
  data,
  markers = [],
}: {
  data: { expiration: string; atmIV: number | null }[];
  markers?: TermStructureMarker[];
}) {
  // Inject a synthetic null-IV entry for any marker date that isn't already
  // an expiration. recharts categorical x-axis only renders ReferenceLine at
  // existing category values, so the ghost entry gives us an anchor. The
  // Line gets connectNulls so the IV curve still flows across the gap.
  const augmented = useMemo(() => {
    if (markers.length === 0 || data.length === 0) return data;
    const existing = new Set(data.map((d) => d.expiration));
    const toAdd = markers
      .filter((m) => !existing.has(m.date))
      .map((m) => ({ expiration: m.date, atmIV: null as number | null }));
    if (toAdd.length === 0) return data;
    return [...data, ...toAdd].sort((a, b) => a.expiration.localeCompare(b.expiration));
  }, [data, markers]);

  // Only emit a ReferenceLine for markers that ended up in the data array.
  // (Always true now that we inject, but defensive against future changes.)
  const renderedMarkers = useMemo(() => {
    const inData = new Set(augmented.map((d) => d.expiration));
    return markers.filter((m) => inData.has(m.date));
  }, [augmented, markers]);

  return (
    <div className="card p-4">
      <h3 className="text-sm font-semibold mb-2">ATM IV Term Structure</h3>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={augmented} margin={{ top: 16, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid {...grid} />
          <XAxis
            dataKey="expiration"
            tick={{ ...axis, fontSize: 10 }}
            tickFormatter={(v) => {
              // v is "YYYY-MM-DD"; render as "M/D" so the axis stays clean
              // even at dense weekly expiration cadence.
              const parts = String(v).split("-");
              return parts.length === 3 ? `${Number(parts[1])}/${Number(parts[2])}` : String(v);
            }}
            minTickGap={20}
          />
          <YAxis tick={axis} tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} domain={["auto", "auto"]} />
          <Tooltip
            contentStyle={{ background: "#171717", border: "1px solid #404040", fontSize: 12 }}
            labelStyle={{ color: "#a3a3a3" }}
            formatter={(v: any) => fmtPct(v, 2)}
          />
          {renderedMarkers.map((m) => (
            <ReferenceLine
              key={`${m.date}-${m.label}`}
              x={m.date}
              stroke={m.color}
              strokeDasharray="4 4"
              ifOverflow="extendDomain"
              label={{
                value: m.label,
                fontSize: 10,
                fill: m.color,
                position: "insideTopRight",
                offset: 4,
              }}
            />
          ))}
          <Line
            type="monotone"
            dataKey="atmIV"
            name="ATM IV"
            stroke="#eeb71b"
            strokeWidth={2}
            dot={{ r: 3, fill: "#eeb71b" }}
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function OIChart({
  data,
  spot,
}: {
  data: { strike: number; callOI: number; putOI: number }[];
  spot: number | null;
}) {
  return (
    <div className="card p-4">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-sm font-semibold">Open Interest by Strike</h3>
        <span className="text-xs text-neutral-500">calls vs puts</span>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid {...grid} />
          <XAxis dataKey="strike" tick={axis} tickFormatter={(v) => fmtNum(v, 0)} />
          <YAxis tick={axis} tickFormatter={(v) => fmtCompact(v)} />
          <Tooltip
            contentStyle={{ background: "#171717", border: "1px solid #404040", fontSize: 12 }}
            labelStyle={{ color: "#a3a3a3" }}
            formatter={(v: any) => fmtCompact(v)}
            labelFormatter={(v) => `Strike ${fmtNum(v as number, 2)}`}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {spot !== null && (
            <ReferenceLine x={spot} stroke="#eeb71b" strokeDasharray="4 4" />
          )}
          <Bar dataKey="callOI" name="Calls" fill="#34d399" />
          <Bar dataKey="putOI" name="Puts" fill="#fb7185" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
