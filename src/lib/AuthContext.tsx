import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import posthog from "posthog-js";
import { insforge } from "./insforge";

function identifyInPosthog(u: SessionUser) {
  if (!posthog.__loaded) return;
  posthog.identify(u.id, {
    email: u.email ?? undefined,
    name: u.name ?? undefined,
  });
}

function resetPosthog() {
  if (!posthog.__loaded) return;
  posthog.reset();
}

interface SessionUser {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

function toSessionUser(raw: any, fallbackEmail?: string): SessionUser {
  const u = raw?.user ?? raw ?? {};
  const profile = u.profile ?? {};
  const email = u.email ?? fallbackEmail ?? null;
  let name = profile.name ?? u.name ?? null;
  if (!name && email) name = email.split("@")[0];
  return {
    id: u.id,
    email,
    name,
    avatarUrl: profile.avatar_url ?? profile.avatarUrl ?? null,
  };
}

interface AuthContextValue {
  user: SessionUser | null;
  loading: boolean;
  signUp: (email: string, password: string) => Promise<{ error: string | null }>;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signInWithGoogle: () => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await insforge.auth.getCurrentUser();
        if (cancelled) return;
        if (error || !data) {
          setUser(null);
        } else {
          const next = toSessionUser(data);
          setUser(next);
          identifyInPosthog(next);
        }
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signUp = async (email: string, password: string) => {
    const { data, error } = await insforge.auth.signUp({ email, password });
    if (error) return { error: error.message ?? "Sign up failed" };
    if (data) {
      const next = toSessionUser(data, email);
      setUser(next);
      identifyInPosthog(next);
    }
    return { error: null };
  };

  const signIn = async (email: string, password: string) => {
    const { data, error } = await insforge.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message ?? "Sign in failed" };
    if (data) {
      const next = toSessionUser(data, email);
      setUser(next);
      identifyInPosthog(next);
    }
    return { error: null };
  };

  const signInWithGoogle = async () => {
    const { error } = await insforge.auth.signInWithOAuth({
      provider: "google",
      redirectTo: window.location.origin,
    });
    if (error) return { error: (error as any).message ?? "Google sign-in failed" };
    return { error: null };
    // On success the SDK redirects the browser to Google. After the
    // callback returns to redirectTo, the SDK exchanges insforge_code
    // for a session automatically; getCurrentUser() then resolves.
  };

  const signOut = async () => {
    await insforge.auth.signOut();
    setUser(null);
    resetPosthog();
  };

  return (
    <AuthContext.Provider value={{ user, loading, signUp, signIn, signInWithGoogle, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
