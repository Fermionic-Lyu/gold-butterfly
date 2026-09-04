import { PostHog } from "posthog-node";
import { env } from "../../env.ts";

// Short-lived client: flush per event so a job's events land before it exits.
export function createPostHog(): PostHog | null {
  if (!env.posthogKey) return null;
  return new PostHog(env.posthogKey, {
    host: env.posthogHost,
    flushAt: 1,
    flushInterval: 0,
  });
}
