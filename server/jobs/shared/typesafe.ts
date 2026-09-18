// TypeSafe AI's System One decision endpoint (Jev): typed answers with
// calibrated probabilities over a state the caller supplies. Same body shape
// on OpenRouter's decisions route, so the OpenRouter key is enough.

import { env } from "../../env.ts";
import { sleep } from "./util.ts";

export class JevNotConfigured extends Error {
  constructor() {
    super("Jev needs OPENROUTER_API_KEY (or TYPESAFE_API_KEY for the direct route)");
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

export const isJevModel = (model: string) => /^~?typesafe\//.test(model);

// A TypeSafe key, when present, keeps billing where the operator put it.
function route(model: string): { url: string; key: string; model: string } {
  if (env.typesafeKey) {
    return { url: "https://api.typesafe.ai/v1/systemone", key: env.typesafeKey, model: "jev-latest" };
  }
  if (env.openrouterKey) {
    return { url: "https://openrouter.ai/api/alpha/decisions", key: env.openrouterKey, model };
  }
  throw new JevNotConfigured();
}

export async function systemOne(model: string, state: unknown, questions: Record<string, Question>): Promise<SystemOneResponse> {
  const r = route(model);
  const body = JSON.stringify({ model: r.model, state, questions });
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(r.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${r.key}`, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const transient = res.status === 429 || res.status >= 500;
    if (transient && attempt < 2) {
      await sleep(800 * Math.pow(2, attempt));
      continue;
    }
    if (!res.ok) throw new Error(`Jev ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as SystemOneResponse;
  }
}
