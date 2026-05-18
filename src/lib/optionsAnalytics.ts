import type { OptionContract, RealizedVol } from "./types";

export interface ChainMetrics {
  atmIV: number | null;
  atmCallIV: number | null;
  atmPutIV: number | null;
  putCallSkew: number | null; // 25Δ put IV − 25Δ call IV
  rr25: number | null; // risk reversal: 25Δ call IV − 25Δ put IV
  termStructure: { expiration: string; atmIV: number | null }[];
  putCallOIRatio: number | null;
  putCallVolRatio: number | null;
  totalCallOI: number;
  totalPutOI: number;
  totalCallVolume: number;
  totalPutVolume: number;
  ivPercentileByExp: { expiration: string; min: number; max: number; mean: number }[];
}

export function daysToExpiration(expiration: string, now = new Date()): number {
  const e = new Date(expiration + "T16:00:00Z").getTime();
  const n = now.getTime();
  return Math.max((e - n) / (1000 * 60 * 60 * 24), 0);
}

export function nearestExpiration(expirations: string[], targetDays = 30): string | null {
  if (!expirations.length) return null;
  let best = expirations[0];
  let bestDiff = Math.abs(daysToExpiration(best) - targetDays);
  for (const e of expirations) {
    const d = Math.abs(daysToExpiration(e) - targetDays);
    if (d < bestDiff) {
      best = e;
      bestDiff = d;
    }
  }
  return best;
}

function num(x: number | null | undefined): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function nearestByDelta(
  contracts: OptionContract[],
  targetDelta: number,
): OptionContract | null {
  let best: OptionContract | null = null;
  let bestDiff = Infinity;
  for (const c of contracts) {
    const d = num(c.delta);
    if (d === null) continue;
    const diff = Math.abs(d - targetDelta);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = c;
    }
  }
  return best;
}

function nearestByStrike(contracts: OptionContract[], spot: number): OptionContract | null {
  let best: OptionContract | null = null;
  let bestDiff = Infinity;
  for (const c of contracts) {
    const diff = Math.abs(c.strike - spot);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = c;
    }
  }
  return best;
}

export function computeChainMetrics(
  contracts: OptionContract[],
  expirations: string[],
  spot: number | null,
): ChainMetrics {
  const target = nearestExpiration(expirations, 30);
  const calls = contracts.filter((c) => c.type === "call" && c.expiration === target);
  const puts = contracts.filter((c) => c.type === "put" && c.expiration === target);

  // ATM IV: closest call & put to spot, average their IVs
  let atmCallIV: number | null = null;
  let atmPutIV: number | null = null;
  if (spot !== null) {
    const atmCall = nearestByStrike(calls, spot);
    const atmPut = nearestByStrike(puts, spot);
    atmCallIV = atmCall?.iv ?? null;
    atmPutIV = atmPut?.iv ?? null;
  }
  const atmIV =
    atmCallIV !== null && atmPutIV !== null
      ? (atmCallIV + atmPutIV) / 2
      : (atmCallIV ?? atmPutIV);

  // Skew via 25-delta wings
  const call25 = nearestByDelta(calls, 0.25);
  const put25 = nearestByDelta(puts, -0.25);
  const putCallSkew =
    put25?.iv !== undefined && put25?.iv !== null && call25?.iv !== undefined && call25?.iv !== null
      ? put25.iv - call25.iv
      : null;
  const rr25 =
    call25?.iv !== undefined && call25?.iv !== null && put25?.iv !== undefined && put25?.iv !== null
      ? call25.iv - put25.iv
      : null;

  // Term structure: ATM IV per expiration
  const termStructure = expirations.map((exp) => {
    const expCalls = contracts.filter((c) => c.type === "call" && c.expiration === exp);
    const expPuts = contracts.filter((c) => c.type === "put" && c.expiration === exp);
    let atm: number | null = null;
    if (spot !== null) {
      const ca = nearestByStrike(expCalls, spot);
      const pu = nearestByStrike(expPuts, spot);
      const civ = num(ca?.iv);
      const piv = num(pu?.iv);
      atm = civ !== null && piv !== null ? (civ + piv) / 2 : (civ ?? piv);
    }
    return { expiration: exp, atmIV: atm };
  });

  // OI / Volume ratios
  let totalCallOI = 0,
    totalPutOI = 0,
    totalCallVolume = 0,
    totalPutVolume = 0;
  for (const c of contracts) {
    if (c.type === "call") {
      totalCallOI += c.openInterest ?? 0;
      totalCallVolume += c.volume ?? 0;
    } else {
      totalPutOI += c.openInterest ?? 0;
      totalPutVolume += c.volume ?? 0;
    }
  }
  const putCallOIRatio = totalCallOI > 0 ? totalPutOI / totalCallOI : null;
  const putCallVolRatio = totalCallVolume > 0 ? totalPutVolume / totalCallVolume : null;

  // IV stats per expiration
  const ivPercentileByExp = expirations.map((exp) => {
    const ivs: number[] = [];
    for (const c of contracts) {
      if (c.expiration === exp && typeof c.iv === "number" && Number.isFinite(c.iv)) ivs.push(c.iv);
    }
    if (ivs.length === 0) return { expiration: exp, min: 0, max: 0, mean: 0 };
    const min = Math.min(...ivs);
    const max = Math.max(...ivs);
    const mean = ivs.reduce((a, b) => a + b, 0) / ivs.length;
    return { expiration: exp, min, max, mean };
  });

  return {
    atmIV,
    atmCallIV,
    atmPutIV,
    putCallSkew,
    rr25,
    termStructure,
    putCallOIRatio,
    putCallVolRatio,
    totalCallOI,
    totalPutOI,
    totalCallVolume,
    totalPutVolume,
    ivPercentileByExp,
  };
}

export function buildSkewCurve(
  contracts: OptionContract[],
  expiration: string,
): { strike: number; callIV: number | null; putIV: number | null }[] {
  const strikes = Array.from(
    new Set(contracts.filter((c) => c.expiration === expiration).map((c) => c.strike)),
  ).sort((a, b) => a - b);
  return strikes.map((strike) => {
    const c = contracts.find((x) => x.expiration === expiration && x.strike === strike && x.type === "call");
    const p = contracts.find((x) => x.expiration === expiration && x.strike === strike && x.type === "put");
    return { strike, callIV: num(c?.iv), putIV: num(p?.iv) };
  });
}

export function buildOIByStrike(
  contracts: OptionContract[],
  expiration: string,
): { strike: number; callOI: number; putOI: number }[] {
  const strikes = Array.from(
    new Set(contracts.filter((c) => c.expiration === expiration).map((c) => c.strike)),
  ).sort((a, b) => a - b);
  return strikes.map((strike) => {
    const c = contracts.find((x) => x.expiration === expiration && x.strike === strike && x.type === "call");
    const p = contracts.find((x) => x.expiration === expiration && x.strike === strike && x.type === "put");
    return { strike, callOI: c?.openInterest ?? 0, putOI: p?.openInterest ?? 0 };
  });
}

export interface RegimeClassification {
  ivRichness: "rich" | "fair" | "cheap" | "unknown"; // IV vs HV
  ivHvRatio: number | null;
  ivRank: number | null; // 0..1 percentile within trailing 1y, when available
  ivRankSamples: number;
  skewBias: "steep_put" | "moderate_put" | "flat" | "moderate_call" | "steep_call";
  termShape: "contango" | "backwardation" | "flat" | "unknown";
  flowBias: "bullish" | "neutral" | "bearish";
  premiumPosture: "sell_premium" | "lean_sell" | "neutral" | "lean_buy" | "buy_premium";
  notes: string[];
}

export function classifyRegime(
  metrics: ChainMetrics,
  realized: RealizedVol | null | undefined,
  ivRank?: { rank: number | null; samples: number; min: number | null; max: number | null } | null,
): RegimeClassification {
  const notes: string[] = [];

  // 1) IV richness via IV / HV — closest match by horizon (30d ATM IV vs 30d HV).
  let ivHvRatio: number | null = null;
  let ivRichness: RegimeClassification["ivRichness"] = "unknown";
  const hv = realized?.hv30 ?? realized?.hv10 ?? realized?.hv90 ?? null;
  if (metrics.atmIV !== null && hv !== null && hv > 0) {
    ivHvRatio = metrics.atmIV / hv;
    if (ivHvRatio >= 1.25) ivRichness = "rich";
    else if (ivHvRatio >= 0.85) ivRichness = "fair";
    else ivRichness = "cheap";
    notes.push(
      `IV/HV ≈ ${ivHvRatio.toFixed(2)} → vol is ${ivRichness}; mean-reversion edge ${
        ivRichness === "rich" ? "favors sellers" : ivRichness === "cheap" ? "favors buyers" : "neutral"
      }.`,
    );
  }

  // 1b) IV Rank — preferred signal when we have enough history.
  const rank = ivRank?.rank ?? null;
  const samples = ivRank?.samples ?? 0;
  if (rank !== null && samples >= 20) {
    notes.push(
      `IV Rank ≈ ${(rank * 100).toFixed(0)}% (${samples} snapshots, range ${
        ivRank?.min !== null && ivRank?.min !== undefined ? (ivRank.min * 100).toFixed(0) + "%" : "—"
      }–${
        ivRank?.max !== null && ivRank?.max !== undefined ? (ivRank.max * 100).toFixed(0) + "%" : "—"
      }).`,
    );
  }

  // 2) Skew classification — 25Δ put-IV minus 25Δ call-IV. Stocks usually run a small put-skew.
  let skewBias: RegimeClassification["skewBias"] = "flat";
  const skew = metrics.putCallSkew;
  if (skew !== null) {
    if (skew > 0.06) skewBias = "steep_put";
    else if (skew > 0.02) skewBias = "moderate_put";
    else if (skew < -0.04) skewBias = "steep_call";
    else if (skew < -0.01) skewBias = "moderate_call";
    else skewBias = "flat";
    if (skewBias === "steep_put") notes.push("Steep put skew — downside fear is bid; selling puts is rich.");
    if (skewBias === "steep_call") notes.push("Rare steep call skew — upside calls bid; consider call ratio plays.");
  }

  // 3) Term structure — front-month vs ~90d ATM IV.
  const front = metrics.termStructure.find((t) => t.atmIV !== null);
  const back = [...metrics.termStructure].reverse().find((t) => t.atmIV !== null);
  let termShape: RegimeClassification["termShape"] = "unknown";
  if (front && back && front.expiration !== back.expiration && front.atmIV && back.atmIV) {
    const diff = back.atmIV - front.atmIV;
    if (diff > 0.01) termShape = "contango";
    else if (diff < -0.01) termShape = "backwardation";
    else termShape = "flat";
    if (termShape === "backwardation")
      notes.push("Backwardation — front month richer than back; possible event/earnings premium.");
  }

  // 4) Flow bias from put/call OI ratio.
  let flowBias: RegimeClassification["flowBias"] = "neutral";
  if (metrics.putCallOIRatio !== null) {
    if (metrics.putCallOIRatio > 1.3) flowBias = "bearish";
    else if (metrics.putCallOIRatio < 0.7) flowBias = "bullish";
  }

  // 5) Overall premium posture — prefer TastyTrade IV-Rank thresholds when we have
  // enough history; otherwise fall back to IV/HV richness.
  let premiumPosture: RegimeClassification["premiumPosture"] = "neutral";
  if (rank !== null && samples >= 20) {
    if (rank >= 0.5) premiumPosture = "sell_premium";
    else if (rank >= 0.3) premiumPosture = "lean_sell";
    else if (rank < 0.15) premiumPosture = "buy_premium";
    else premiumPosture = "lean_buy";
  } else if (ivRichness === "rich") premiumPosture = "sell_premium";
  else if (ivRichness === "fair" && ivHvRatio !== null && ivHvRatio >= 1.1) premiumPosture = "lean_sell";
  else if (ivRichness === "cheap") premiumPosture = "buy_premium";
  else if (ivRichness === "fair" && ivHvRatio !== null && ivHvRatio < 0.95) premiumPosture = "lean_buy";

  return {
    ivRichness,
    ivHvRatio,
    ivRank: rank,
    ivRankSamples: samples,
    skewBias,
    termShape,
    flowBias,
    premiumPosture,
    notes,
  };
}

function snapshotContract(c: OptionContract) {
  return {
    symbol: c.symbol,
    type: c.type,
    strike: c.strike,
    expiration: c.expiration,
    delta: c.delta,
    iv: c.iv,
    bid: c.bid,
    ask: c.ask,
    mid:
      c.bid !== null && c.ask !== null && Number.isFinite(c.bid) && Number.isFinite(c.ask)
        ? (c.bid + c.ask) / 2
        : null,
    openInterest: c.openInterest,
  };
}

function quotedContractsAtExpiration(contracts: OptionContract[], expiration: string) {
  const calls = contracts.filter((c) => c.type === "call" && c.expiration === expiration);
  const puts = contracts.filter((c) => c.type === "put" && c.expiration === expiration);
  const targets: { tag: string; c: OptionContract | null }[] = [
    { tag: "call_50d", c: nearestByDelta(calls, 0.5) },
    { tag: "call_30d", c: nearestByDelta(calls, 0.3) },
    { tag: "call_16d", c: nearestByDelta(calls, 0.16) },
    { tag: "call_10d", c: nearestByDelta(calls, 0.1) },
    { tag: "put_50d", c: nearestByDelta(puts, -0.5) },
    { tag: "put_30d", c: nearestByDelta(puts, -0.3) },
    { tag: "put_16d", c: nearestByDelta(puts, -0.16) },
    { tag: "put_10d", c: nearestByDelta(puts, -0.1) },
  ];
  return targets
    .filter((t) => t.c !== null)
    .map((t) => ({ tag: t.tag, ...snapshotContract(t.c!) }));
}

export function strategySummary(
  symbol: string,
  spot: number | null,
  expirations: string[],
  contracts: OptionContract[],
  metrics: ChainMetrics,
  realized: RealizedVol | null | undefined,
  ivRank?: { rank: number | null; samples: number; min: number | null; max: number | null } | null,
) {
  const regime = classifyRegime(metrics, realized, ivRank);

  // Three horizons: front (~14d), primary (~30-45d, the credit-spread sweet spot),
  // and longer-dated (~90d). Strategy candidates differ across these.
  const exp14 = nearestExpiration(expirations, 14);
  const exp35 = nearestExpiration(expirations, 35);
  const exp90 = nearestExpiration(expirations, 90);

  const horizons = [
    { tag: "near_14d", expiration: exp14 },
    { tag: "primary_35d", expiration: exp35 },
    { tag: "long_90d", expiration: exp90 },
  ]
    .filter((h) => h.expiration)
    .map((h) => ({
      tag: h.tag,
      expiration: h.expiration,
      days: Math.round(daysToExpiration(h.expiration!)),
      contracts: quotedContractsAtExpiration(contracts, h.expiration!),
    }));

  return {
    symbol,
    spot,
    asOf: new Date().toISOString(),
    regime,
    metrics: {
      atmIV: metrics.atmIV,
      atmCallIV: metrics.atmCallIV,
      atmPutIV: metrics.atmPutIV,
      skew_25d_put_minus_call: metrics.putCallSkew,
      riskReversal_25d_call_minus_put: metrics.rr25,
      putCallOIRatio: metrics.putCallOIRatio,
      putCallVolumeRatio: metrics.putCallVolRatio,
      totalCallOI: metrics.totalCallOI,
      totalPutOI: metrics.totalPutOI,
    },
    realized: realized ?? null,
    termStructure: metrics.termStructure
      .filter((t) => t.atmIV !== null)
      .map((t) => ({
        expiration: t.expiration,
        days: Math.round(daysToExpiration(t.expiration)),
        atmIV: t.atmIV,
      })),
    horizons,
  };
}
