import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import posthog from "posthog-js";
import { api } from "./api";

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

export interface SessionUser {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
  isAdmin?: boolean;
}

function toSessionUser(raw: any, fallbackEmail?: string): SessionUser {
  const email = raw?.email ?? fallbackEmail ?? null;
  let name = raw?.name ?? null;
  if (!name && email) name = email.split("@")[0];
  return { id: raw.id, email, name, avatarUrl: raw?.avatarUrl ?? null, isAdmin: Boolean(raw?.isAdmin) };
}

interface AuthContextValue {
  user: SessionUser | null;
  loading: boolean;
  signUp: (email: string, password: string) => Promise<{ error: string | null }>;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
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
        const { user: raw } = await api.get<{ user: any | null }>("/api/auth/me");
        if (cancelled) return;
        if (raw) {
          const next = toSessionUser(raw);
          setUser(next);
          identifyInPosthog(next);
        } else {
          setUser(null);
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

  const authenticate = async (path: string, email: string, password: string, fallback: string) => {
    try {
      const { user: raw } = await api.post<{ user: any }>(path, { email, password });
      const next = toSessionUser(raw, email);
      setUser(next);
      identifyInPosthog(next);
      return { error: null };
    } catch (e: any) {
      return { error: e?.message ?? fallback };
    }
  };

  const signUp = (email: string, password: string) =>
    authenticate("/api/auth/signup", email, password, "Sign up failed");
  const signIn = (email: string, password: string) =>
    authenticate("/api/auth/signin", email, password, "Sign in failed");

  const signOut = async () => {
    await api.post("/api/auth/signout").catch(() => {});
    setUser(null);
    resetPosthog();
  };

  return (
    <AuthContext.Provider value={{ user, loading, signUp, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
