import { useState, type FormEvent } from "react";
import { useAuth } from "../lib/AuthContext";
import ButterflyIcon from "./ButterflyIcon";

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.6-6 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.4 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.4-4.5 2.4-7.2 2.4-5.3 0-9.7-3.4-11.3-8l-6.5 5C9.6 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.1 5.6l6.2 5.2C41.6 35.4 44 30 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

export default function AuthScreen({ onAuthed }: { onAuthed?: () => void } = {}) {
  const { signIn, signUp, signInWithGoogle } = useAuth();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [oauthBusy, setOauthBusy] = useState(false);
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

  async function onGoogle() {
    setErr(null);
    setOauthBusy(true);
    const { error } = await signInWithGoogle();
    if (error) {
      setErr(error);
      setOauthBusy(false);
    }
    // On success the browser redirects away to Google.
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

        <button
          type="button"
          onClick={onGoogle}
          disabled={oauthBusy}
          className="btn w-full bg-white text-neutral-900 hover:bg-neutral-100 mb-4 gap-2"
        >
          <GoogleIcon className="w-4 h-4" />
          {oauthBusy ? "Redirecting…" : "Continue with Google"}
        </button>

        <div className="flex items-center gap-3 mb-4">
          <div className="h-px flex-1 bg-neutral-800" />
          <span className="text-[11px] uppercase tracking-wider text-neutral-500">or email</span>
          <div className="h-px flex-1 bg-neutral-800" />
        </div>

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
      </div>
    </div>
  );
}
