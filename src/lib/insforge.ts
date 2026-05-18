import { createClient } from "@insforge/sdk";

const baseUrl = import.meta.env.VITE_INSFORGE_URL;
const anonKey = import.meta.env.VITE_INSFORGE_ANON_KEY;

if (!baseUrl || !anonKey) {
  throw new Error("Missing VITE_INSFORGE_URL or VITE_INSFORGE_ANON_KEY in .env");
}

// SDK default is 30s; AI calls (especially strategy-analysis with verbose
// reasoning models) can take minutes when chains are large. Give the client
// a 10-minute ceiling so the user-facing flows match what the function side
// is allowed to do. (See @insforge/sdk source: this.timeout = config.timeout
// ?? 3e4.)
export const insforge = createClient({ baseUrl, anonKey, timeout: 600_000 });
