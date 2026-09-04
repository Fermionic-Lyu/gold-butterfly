import OpenAI from "openai";
import { env } from "../../env.ts";

export class OpenRouterNotConfigured extends Error {
  constructor() {
    super("OPENROUTER_API_KEY not configured");
  }
}

// One OpenAI-compatible client pointed at OpenRouter serves every model.
export function openrouterClient(): OpenAI {
  if (!env.openrouterKey) throw new OpenRouterNotConfigured();
  return new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: env.openrouterKey,
    timeout: 600_000,
  });
}

export interface JsonSchemaFormat {
  name: string;
  strict: boolean;
  schema: Record<string, unknown>;
}

const TRANSIENT = /\b5\d\d\b|timeout|ECONNRESET|socket hang up/i;

// Structured-output call with the retry shape every LLM job here relies on:
// one retry on a transient transport error, and one retry when a 200 comes
// back with a body that does not parse (some providers truncate mid-stream).
export async function chatJson(
  client: OpenAI,
  args: {
    model: string;
    system: string;
    user: string;
    schema: JsonSchemaFormat;
    temperature?: number;
    maxTokens?: number;
  },
): Promise<{ parsed: any | null; rawText: string; model: string | null }> {
  let rawText = "";
  let parsed: any = null;
  let usedModel: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let resp: any;
    try {
      resp = await client.chat.completions.create({
        model: args.model,
        messages: [
          { role: "system", content: args.system },
          { role: "user", content: args.user },
        ],
        temperature: args.temperature ?? 0.3,
        max_tokens: args.maxTokens ?? 2200,
        response_format: {
          type: "json_schema",
          json_schema: args.schema as any,
        },
      });
    } catch (e: any) {
      if (attempt === 0 && TRANSIENT.test(String(e?.message ?? e))) continue;
      throw e;
    }
    usedModel = resp?.model ?? null;
    rawText = resp?.choices?.[0]?.message?.content ?? "";
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = extractJson(rawText);
    }
    if (parsed !== null) break;
  }
  return { parsed, rawText, model: usedModel };
}

// Safety net for wrapper text around the JSON object.
export function extractJson(text: string): any | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < candidate.length; i++) {
    const c = candidate[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
