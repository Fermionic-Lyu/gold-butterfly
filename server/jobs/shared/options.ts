import type { ChainContractLite as ChainContract } from "./alpaca.ts";

export type { ChainContract };

export interface Leg {
  sign: 1 | -1;
  qty: number;
  instrument: "stock" | "call" | "put";
  symbol: string;
  strike?: number;
  expiration?: string;
  fill_price: number;
  current_price?: number;
}

export const multiplier = (instrument: Leg["instrument"]) => (instrument === "stock" ? 1 : 100);
export const legValue = (leg: Leg, price: number) => leg.sign * leg.qty * price * multiplier(leg.instrument);
export const entryCost = (legs: Leg[], collateral: number) =>
  legs.reduce((sum, l) => sum + legValue(l, l.fill_price), 0) + collateral;
export const currentValue = (legs: Leg[], collateral: number) =>
  legs.reduce((sum, l) => sum + legValue(l, l.current_price ?? l.fill_price), 0) + collateral;

export function midOf(c: ChainContract): number | null {
  if (c.bid !== null && c.ask !== null && c.bid >= 0 && c.ask >= 0) {
    if (c.ask === 0) return null;
    return (c.bid + c.ask) / 2;
  }
  return null;
}

export function daysToExpiration(exp: string, now = new Date()): number {
  return Math.max((new Date(exp + "T16:00:00Z").getTime() - now.getTime()) / 86_400_000, 0);
}

export const expirationPassed = (exp: string, now = new Date()) => new Date(exp + "T20:00:00Z") < now;

export function nearestByDelta(contracts: ChainContract[], target: number): ChainContract | null {
  let best: ChainContract | null = null;
  let bestDiff = Infinity;
  for (const c of contracts) {
    if (c.delta === null) continue;
    const diff = Math.abs(c.delta - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = c;
    }
  }
  return best;
}

export function nearestByStrike(contracts: ChainContract[], spot: number): ChainContract | null {
  let best: ChainContract | null = null;
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

export function nearestExpiration(expirations: string[], targetDays: number): string | null {
  if (expirations.length === 0) return null;
  let best = expirations[0];
  let bestDiff = Infinity;
  for (const e of expirations) {
    const diff = Math.abs(daysToExpiration(e) - targetDays);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = e;
    }
  }
  return best;
}
