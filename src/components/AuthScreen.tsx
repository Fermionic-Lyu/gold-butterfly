import { useState, type FormEvent } from "react";
import { useAuth } from "../lib/AuthContext";
import ButterflyIcon from "./ButterflyIcon";

export default function AuthScreen({ onAuthed }: { onAuthed?: () => void } = {}) {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    const fn = mode === "signin" ? signIn : signUp;
    const { error } = await fn(email, password);
    setBusy(false);
    if (error) {
      setErr(error);
    } else {
      onAuthed?.();
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md card p-8">
        <div className="flex items-center gap-3 mb-1">
          <ButterflyIcon className="w-9 h-9" />
          <h1 className="text-2xl font-semibold tracking-tight">Gold Butterfly</h1>
        </div>
        <p className="text-sm text-neutral-400 mb-6">
          Live options analytics, Greeks, and AI strategy guidance.
        </p>

        <div className="flex gap-2 mb-4">
          <button
            type="button"
            className={`flex-1 btn ${mode === "signin" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setMode("signin")}
          >
            Sign in
          </button>
          <button
            type="button"
            className={`flex-1 btn ${mode === "signup" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setMode("signup")}
          >
            Sign up
          </button>
        </div>

        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-neutral-400 mb-1">Email</label>
            <input
              type="email"
              required
              className="input w-full"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-neutral-400 mb-1">Password</label>
            <input
              type="password"
              required
              minLength={6}
              className="input w-full"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              placeholder="••••••••"
            />
          </div>
          {err && <p className="text-sm text-red-400">{err}</p>}
          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? "Working…" : mode === "signin" ? "Sign in" : "Create account"}
          </button>
        </form>
        {mode === "signup" && (
          <p className="text-[11px] text-neutral-500 mt-4">
            The first account created on a fresh instance becomes its administrator.
          </p>
        )}
      </div>
    </div>
  );
}
