// Every knob the server reads from the environment, in one place. Provider
// credentials are optional at boot so the app can come up (and show a clear
// health status) before the operator has set them.

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: num(process.env.PORT, 8080),
  databaseUrl: process.env.DATABASE_URL ?? "",
  alpacaKey: process.env.ALPACA_API_KEY ?? "",
  alpacaSecret: process.env.ALPACA_API_SECRET ?? "",
  openrouterKey: process.env.OPENROUTER_API_KEY ?? "",
  finnhubKey: process.env.FINNHUB_API_KEY ?? "",
  posthogKey: process.env.POSTHOG_API_KEY ?? "",
  posthogHost: process.env.POSTHOG_HOST ?? "https://us.i.posthog.com",
  // SCHEDULER=off runs the API without cron — for local dev against a DB
  // that a deployed instance is already feeding.
  schedulerEnabled: process.env.SCHEDULER !== "off",
  agentConcurrency: num(process.env.AGENT_CONCURRENCY, 3),
};

export const hasAlpaca = () => Boolean(env.alpacaKey && env.alpacaSecret);
export const hasOpenRouter = () => Boolean(env.openrouterKey);
export const hasFinnhub = () => Boolean(env.finnhubKey);

export function credentialStatus() {
  return {
    database: Boolean(env.databaseUrl),
    alpaca: hasAlpaca(),
    openrouter: hasOpenRouter(),
    finnhub: hasFinnhub(),
    posthog: Boolean(env.posthogKey),
  };
}
