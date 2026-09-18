// TypeSafe AI's System One endpoint: typed decisions with calibrated
// probabilities over a state the caller supplies. No text generation.

import { env } from "../../env.ts";
import { sleep } from "./util.ts";

const BASE = "https://api.typesafe.ai/v1";

export class TypeSafeNotConfigured extends Error {
  constructor() {
    super("TYPESAFE_API_KEY not configured");
  }
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}
export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}
export interface NoulQuestion {
  type: "noul";
  instructions: string;
}
export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export interface ChoiceAnswer {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface ScoreAnswer {
  score: number;
  probabilities: number[];
  confidence: number;
}
export interface NoulAnswer {
  noul: number;
}
export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export interface SystemOneResponse {
  answers: Record<string, Answer>;
  model: string;
}

export const isJevModel = (model: string) => model.startsWith("typesafe/");

export async function systemOne(state: unknown, questions: Record<string, Question>): Promise<SystemOneResponse> {
  if (!env.typesafeKey) throw new TypeSafeNotConfigured();
  const body = JSON.stringify({ state, questions });
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}/systemone`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.typesafeKey}`, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const transient = res.status === 429 || res.status >= 500;
    if (transient && attempt < 2) {
      await sleep(800 * Math.pow(2, attempt));
      continue;
    }
    if (!res.ok) throw new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as SystemOneResponse;
  }
}
