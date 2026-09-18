// Jev returns typed choices, not legs, so the server builds every structure
// the range strategy allows from the quoted chain and Jev picks one (or
// hold) with a calibrated probability. The output has the same shape as a
// text model's decision, so Phase B treats both paths identically.

import {
  type ChainContract,
  type Leg,
  daysToExpiration,
  midOf,
  nearestByDelta,
  nearestByStrike,
  nearestExpiration,
} from "./shared/options.ts";
import { systemOne, type ChoiceAnswer, type Question } from "./shared/typesafe.ts";

interface PresetLike {
  min_dte: number;
  max_dte: number;
  max_position_size_pct: number;
  allowed_strategies: string[];
  profit_target_pct?: number;
  manage_at_dte?: number;
  stop_loss_pct?: number;
}

interface OpenPositionLike {
  id: string;
  strategy: string;
  legs: Leg[];
  entry_cost: number;
  current_value: number | null;
  opened_at: Date | string;
}

export interface RangeDecisionInput {
  symbol: string;
  runDate: string;
  agent: { model: string; system_prompt: string; preset: PresetLike; starting_capital: number; cash: number };
  spot: number;
  contracts: ChainContract[];
  atmIV: number | null;
  hv30: number | null;
  ivHvRatio: number | null;
  ivRank: number | null;
  priceHistory: unknown;
  events: { next_earnings: { date: string; days_until: number } | null; next_fomc: { date: string; days_until: number } | null };
  news: unknown;
  openCount: number;
  openPositions: OpenPositionLike[];
}

interface Candidate {
  key: string;
  strategy: string;
  legs: Leg[];
  lots: number;
  netPerShare: number;
  maxLossPerLot: number;
  description: string;
}

const MAX_LOTS = 10;
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const px = (n: number) => n.toFixed(2);
const pct = (n: number | null | undefined) => (n == null ? "n/a" : `${(n * 100).toFixed(1)}%`);

function leg(c: ChainContract, sign: 1 | -1, qty: number): Leg {
  const mid = midOf(c)!;
  return { sign, qty, instrument: c.type, symbol: c.symbol, strike: c.strike, expiration: c.expiration, fill_price: mid, current_price: mid };
}

const quoted = (c: ChainContract) => {
  const m = midOf(c);
  return m !== null && m > 0;
};

// Number of lots that keeps max loss near two-thirds of the size cap.
function lotsFor(maxLossPerLot: number, startingCapital: number, sizePct: number): number | null {
  const cap = startingCapital * sizePct;
  if (maxLossPerLot <= 0 || maxLossPerLot > cap) return null;
  return Math.min(MAX_LOTS, Math.max(1, Math.floor((cap * 2) / 3 / maxLossPerLot)));
}

export function buildRangeCandidates(input: RangeDecisionInput): { candidates: Candidate[]; expiration: string | null; blocked: string | null } {
  const { spot, contracts, agent } = input;
  const preset = agent.preset;
  const inWindow = Array.from(new Set(contracts.map((c) => c.expiration))).filter((e) => {
    const dte = daysToExpiration(e);
    return dte >= preset.min_dte && dte <= preset.max_dte;
  });
  const expiration = nearestExpiration(inWindow, (preset.min_dte + preset.max_dte) / 2);
  if (!expiration) return { candidates: [], expiration: null, blocked: `no expiration inside ${preset.min_dte}–${preset.max_dte} DTE` };
  const dte = Math.round(daysToExpiration(expiration));
  const earnings = input.events.next_earnings;
  if (earnings && earnings.date <= expiration) {
    return { candidates: [], expiration, blocked: `earnings ${earnings.date} falls inside the ${expiration} expiration` };
  }

  const calls = contracts.filter((c) => c.type === "call" && c.expiration === expiration && quoted(c));
  const puts = contracts.filter((c) => c.type === "put" && c.expiration === expiration && quoted(c));
  const callStrikes = new Set(calls.map((c) => c.strike));
  const both = puts.filter((p) => callStrikes.has(p.strike)).map((p) => p.strike);
  if (both.length < 5) return { candidates: [], expiration, blocked: `too few two-sided strikes at ${expiration}` };
  const bodyPut = nearestByStrike(puts.filter((p) => both.includes(p.strike)), spot)!;
  const body = bodyPut.strike;
  const bodyCall = calls.find((c) => c.strike === body)!;
  const allowed = new Set(preset.allowed_strategies);
  const out: Candidate[] = [];
  const zone = (lo: number, hi: number) => `${px(lo)}–${px(hi)}`;

  if (allowed.has("iron_butterfly")) {
    const lp = nearestByDelta(puts.filter((p) => p.strike < body), -0.16);
    const lc = nearestByDelta(calls.filter((c) => c.strike > body), 0.16);
    if (lp && lc) {
      const credit = midOf(bodyPut)! + midOf(bodyCall)! - midOf(lp)! - midOf(lc)!;
      const width = Math.max(body - lp.strike, lc.strike - body);
      const maxLoss = (width - credit) * 100;
      const lots = credit > 0 ? lotsFor(maxLoss, agent.starting_capital, preset.max_position_size_pct) : null;
      if (lots) {
        out.push({
          key: "iron_butterfly",
          strategy: "iron_butterfly",
          lots,
          netPerShare: credit,
          maxLossPerLot: maxLoss,
          legs: [leg(lp, 1, lots), leg(bodyPut, -1, lots), leg(bodyCall, -1, lots), leg(lc, 1, lots)],
          description: `Iron butterfly ${expiration} (${dte} DTE): sell ${body}P and ${body}C, buy ${lp.strike}P / ${lc.strike}C wings. Credit ${px(credit)}/share; max loss ${usd(maxLoss)}/lot × ${lots} = ${usd(maxLoss * lots)}; profit zone ${zone(body - credit, body + credit)}.`,
        });
      }
    }
  }

  // One-sigma move to expiration sets the wing width for the debit flies.
  const vol = input.atmIV ?? input.hv30;
  const sigma = vol ? spot * vol * Math.sqrt(dte / 365) : null;
  const widths = both.filter((s) => s > body).map((s) => s - body).filter((w) => both.some((s) => Math.abs(s - (body - w)) < 1e-6));
  const width = sigma && widths.length ? widths.reduce((a, b) => (Math.abs(b - sigma) < Math.abs(a - sigma) ? b : a)) : null;

  const debitFly = (strategy: "long_call_butterfly" | "long_put_butterfly", pool: ChainContract[], label: string, right: string) => {
    if (!allowed.has(strategy) || !width) return;
    const lo = pool.find((c) => Math.abs(c.strike - (body - width)) < 1e-6);
    const mid = pool.find((c) => c.strike === body);
    const hi = pool.find((c) => Math.abs(c.strike - (body + width)) < 1e-6);
    if (!lo || !mid || !hi) return;
    const debit = midOf(lo)! + midOf(hi)! - 2 * midOf(mid)!;
    if (!(debit > 0 && debit < width)) return;
    const maxLoss = debit * 100;
    const lots = lotsFor(maxLoss, agent.starting_capital, preset.max_position_size_pct);
    if (!lots) return;
    out.push({
      key: strategy,
      strategy,
      lots,
      netPerShare: -debit,
      maxLossPerLot: maxLoss,
      legs: [leg(lo, 1, lots), leg(mid, -1, 2 * lots), leg(hi, 1, lots)],
      description: `${label} ${expiration} (${dte} DTE): buy ${lo.strike}${right}, sell 2× ${body}${right}, buy ${hi.strike}${right}. Debit ${px(debit)}/share = max loss ${usd(maxLoss)}/lot × ${lots} = ${usd(maxLoss * lots)}; max gain ${usd((width - debit) * 100)}/lot if pinned at ${body}; profit zone ${zone(lo.strike + debit, hi.strike - debit)}.`,
    });
  };
  debitFly("long_call_butterfly", calls, "Long call butterfly", "C");
  debitFly("long_put_butterfly", puts, "Long put butterfly", "P");

  if (allowed.has("iron_condor")) {
    const sp = nearestByDelta(puts.filter((p) => p.strike < body), -0.2);
    const sc = nearestByDelta(calls.filter((c) => c.strike > body), 0.2);
    const lp = sp ? nearestByDelta(puts.filter((p) => p.strike < sp.strike), -0.1) : null;
    const lc = sc ? nearestByDelta(calls.filter((c) => c.strike > sc.strike), 0.1) : null;
    if (sp && sc && lp && lc) {
      const credit = midOf(sp)! + midOf(sc)! - midOf(lp)! - midOf(lc)!;
      const w = Math.max(sp.strike - lp.strike, lc.strike - sc.strike);
      const maxLoss = (w - credit) * 100;
      const lots = credit > 0 ? lotsFor(maxLoss, agent.starting_capital, preset.max_position_size_pct) : null;
      if (lots) {
        out.push({
          key: "iron_condor",
          strategy: "iron_condor",
          lots,
          netPerShare: credit,
          maxLossPerLot: maxLoss,
          legs: [leg(lp, 1, lots), leg(sp, -1, lots), leg(sc, -1, lots), leg(lc, 1, lots)],
          description: `Iron condor ${expiration} (${dte} DTE): sell ${sp.strike}P / ${sc.strike}C (~20Δ), buy ${lp.strike}P / ${lc.strike}C. Credit ${px(credit)}/share; max loss ${usd(maxLoss)}/lot × ${lots} = ${usd(maxLoss * lots)}; profit zone ${zone(sp.strike - credit, sc.strike + credit)}.`,
        });
      }
    }
  }

  return { candidates: out, expiration, blocked: out.length === 0 ? `no viable structure at ${expiration}` : null };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function positionFacts(p: OpenPositionLike, spot: number) {
  const exp = p.legs.find((l) => l.expiration)?.expiration ?? null;
  const cv = p.current_value;
  return {
    id: p.id,
    strategy: p.strategy,
    opened_at: p.opened_at,
    dte: exp ? Math.round(daysToExpiration(exp)) : null,
    spot,
    legs: p.legs.map((l) => `${l.sign > 0 ? "+" : "-"}${l.qty} ${l.strike ?? ""}${l.instrument === "stock" ? "shares" : l.instrument === "call" ? "C" : "P"} filled ${px(l.fill_price)} now ${l.current_price == null ? "n/a" : px(l.current_price)}`),
    entry_cost: Math.round(p.entry_cost),
    current_value: cv == null ? null : Math.round(cv),
    unrealized_pnl_pct: cv == null || p.entry_cost <= 0 ? null : round3((cv - p.entry_cost) / p.entry_cost),
  };
}

export async function decideRangeWithJev(input: RangeDecisionInput): Promise<{ decision: any; rawText: string }> {
  const { symbol, agent, spot } = input;
  const preset = agent.preset;
  const hold = (confidence: number, reasoning: string, extra: Record<string, unknown> = {}) => ({
    decision: {
      action: "hold",
      confidence,
      reasoning,
      open_strategy: null,
      open_qty: null,
      open_legs: null,
      close_position_id: null,
      close_reason: null,
      ...extra,
    },
    rawText: JSON.stringify(extra),
  });

  const built = input.openPositions.length === 0 ? buildRangeCandidates(input) : { candidates: [] as Candidate[], expiration: null, blocked: null };
  const state = {
    symbol,
    run_date: input.runDate,
    spot,
    atm_iv: input.atmIV,
    hv30: input.hv30,
    iv_hv_ratio: input.ivHvRatio,
    iv_rank: input.ivRank,
    price_history: input.priceHistory,
    events: input.events,
    news_digest: input.news,
    portfolio: { starting_capital: agent.starting_capital, cash: Math.round(agent.cash), open_positions_total: input.openCount },
    open_positions_on_symbol: input.openPositions.map((p) => positionFacts(p, spot)),
    candidates: built.candidates.map((c) => ({
      key: c.key,
      strategy: c.strategy,
      lots: c.lots,
      net_per_share: round3(c.netPerShare),
      max_loss_total: Math.round(c.maxLossPerLot * c.lots),
      description: c.description,
    })),
  };

  const questions: Record<string, Question> = {};
  if (input.openPositions.length > 0) {
    const profit = pct(preset.profit_target_pct ?? 0.5);
    const manage = preset.manage_at_dte ?? 7;
    const stop = pct(preset.stop_loss_pct ?? 0.5);
    for (const p of input.openPositions) {
      questions[`manage_${p.id}`] = {
        type: "choice",
        instructions: `Position ${p.id} (${p.strategy}) on ${symbol} is listed in state.open_positions_on_symbol. Exit rules: take ~${profit} of the max value or credit, close at ${manage} DTE regardless, close early once spot trades beyond a wing, and cut a long butterfly at ${stop} loss of the debit. Should it be closed now?`,
        criteria: { keep: "Keep the position open through today", close: "Close the position now at current mid prices" },
      };
    }
  } else if (built.candidates.length > 0) {
    const criteria: Record<string, string> = { hold: `Do nothing on ${symbol} today.` };
    for (const c of built.candidates) criteria[c.key] = c.description;
    questions.structure = {
      type: "choice",
      instructions: `${agent.system_prompt}\n\nPick the single best action for ${symbol} today from the candidates in state.candidates. Choose "hold" unless one structure clearly fits the range, the vol regime and the calendar.`,
      criteria,
    };
  } else {
    return hold(0.9, `No trade: ${built.blocked ?? "nothing to decide"}.`, { jev: { blocked: built.blocked } });
  }

  const res = await systemOne(agent.model, state, questions);
  const rawText = JSON.stringify(res);
  const meta = { model: res.model, answers: res.answers };

  if (input.openPositions.length > 0) {
    let best: { id: string; pClose: number } | null = null;
    for (const p of input.openPositions) {
      const a = res.answers[`manage_${p.id}`] as ChoiceAnswer | undefined;
      const pClose = a?.probabilities?.close ?? (a?.choice === "close" ? 1 : 0);
      if (!best || pClose > best.pClose) best = { id: p.id, pClose };
    }
    if (best && best.pClose >= 0.5) {
      return {
        decision: {
          action: "close",
          confidence: round3(best.pClose),
          reasoning: `Jev ${res.model}: close ${best.id.slice(0, 8)} (p=${round3(best.pClose)}); spot ${px(spot)}.`,
          open_strategy: null,
          open_qty: null,
          open_legs: null,
          close_position_id: best.id,
          close_reason: `Jev p(close)=${round3(best.pClose)}`,
          jev: meta,
        },
        rawText,
      };
    }
    const r = hold(round3(1 - (best?.pClose ?? 0)), `Jev ${res.model}: keep open position(s) (max p(close)=${round3(best?.pClose ?? 0)}).`, { jev: meta });
    return { ...r, rawText };
  }

  const a = res.answers.structure as ChoiceAnswer;
  const probs = a.probabilities ?? {};
  const pHold = probs.hold ?? 0;
  const ranked = Object.entries(probs)
    .sort((x, y) => y[1] - x[1])
    .map(([k, v]) => `${k} ${round3(v)}`)
    .join(", ");
  const chosen = built.candidates.find((c) => c.key === a.choice);
  const ph = input.priceHistory as { range_20d_pct_of_spot?: number | null; drift_10d_pct?: number | null } | null;
  const context = `20d range ${pct(ph?.range_20d_pct_of_spot)}, 10d drift ${pct(ph?.drift_10d_pct)}, IV/HV ${input.ivHvRatio == null ? "n/a" : input.ivHvRatio.toFixed(2)}`;
  if (!chosen) {
    const r = hold(round3(pHold), `Jev ${res.model} chose hold (${ranked}); ${context}.`, { jev: meta });
    return { ...r, rawText };
  }
  return {
    decision: {
      action: "open",
      confidence: round3(1 - pHold),
      reasoning: `Jev ${res.model} chose ${chosen.strategy} ×${chosen.lots} (${ranked}; jev confidence ${round3(a.confidence ?? 0)}); ${context}.`,
      open_strategy: chosen.strategy,
      open_qty: chosen.lots,
      open_legs: chosen.legs,
      close_position_id: null,
      close_reason: null,
      jev: meta,
    },
    rawText,
  };
}
