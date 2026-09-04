export type JobArgs = Record<string, any>;

export interface RunOutcome {
  runId: number | null;
  status: "done" | "error" | "skipped";
  result?: unknown;
  error?: string;
}

export interface JobContext {
  trigger: string;
  // Lets a job chain another (scrape-news → analyze-news) without importing
  // the registry.
  runJob: (name: string, args?: JobArgs) => Promise<RunOutcome>;
}

export type JobHandler = (args: JobArgs, ctx: JobContext) => Promise<unknown>;

export type Credential = "alpaca" | "openrouter" | "finnhub";

export interface JobDef {
  name: string;
  description: string;
  // Cron expressions evaluated in America/New_York.
  schedules: string[];
  requires: Credential[];
  run: JobHandler;
}
