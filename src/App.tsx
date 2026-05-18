import { useEffect, useState } from "react";
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
} from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/AuthContext";
import { SubscriptionsProvider, useSubscriptions } from "./lib/SubscriptionsContext";
import AuthScreen from "./components/AuthScreen";
import Dashboard from "./components/Dashboard";
import WatchlistDrawer from "./components/WatchlistDrawer";
import AgentsDrawer from "./components/AgentsDrawer";
import UserMenu from "./components/UserMenu";
import SymbolAddBar from "./components/SymbolAddBar";
import AgentsPage from "./components/AgentsPage";
import ButterflyIcon from "./components/ButterflyIcon";

// Home is a router redirect: last viewed symbol → first watchlist → NVDA.
const LAST_SYMBOL_KEY = "gb.lastSymbol";
const DEFAULT_SYMBOL = "NVDA";

function HomeView() {
  const { subscriptions, loading } = useSubscriptions();
  const navigate = useNavigate();

  useEffect(() => {
    if (loading) return;
    let target: string | null = null;
    try {
      const stored = localStorage.getItem(LAST_SYMBOL_KEY);
      if (stored && /^[A-Z][A-Z0-9.\-]{0,7}$/.test(stored)) target = stored;
    } catch {
      // localStorage unavailable (private mode, etc.) — fall through.
    }
    if (!target && subscriptions.length > 0) target = subscriptions[0].symbol;
    if (!target) target = DEFAULT_SYMBOL;
    navigate(`/symbols/${target}`, { replace: true });
  }, [loading, subscriptions, navigate]);

  return <div className="card p-10 text-center text-neutral-500">Loading…</div>;
}

function SymbolRoute() {
  const { symbol } = useParams();
  const upper = symbol?.toUpperCase();
  useEffect(() => {
    if (upper) {
      try {
        localStorage.setItem(LAST_SYMBOL_KEY, upper);
      } catch {
        // ignore
      }
    }
  }, [upper]);
  if (!upper) return <Navigate to="/" replace />;
  return <Dashboard key={upper} symbol={upper} />;
}

function AgentRoute() {
  const { slug } = useParams();
  if (!slug) return <Navigate to="/" replace />;
  return <AgentsPage agentSlug={slug} />;
}

function AuthRoute() {
  const { user } = useAuth();
  const navigate = useNavigate();
  // If already signed in, bounce to home.
  useEffect(() => {
    if (user) navigate("/", { replace: true });
  }, [user, navigate]);
  return <AuthScreen onAuthed={() => navigate("/", { replace: true })} />;
}

function AgentsButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="btn-ghost gap-2 ml-4"
      aria-label="Open trading lab"
    >
      <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path d="M6 2.5A.5.5 0 016.5 2h7a.5.5 0 010 1H13v3.4a4 4 0 00.59 2.09l3.06 5.1a2 2 0 01-1.71 3.03H4.6a2 2 0 01-1.71-3.03l3.06-5.1A4 4 0 007 6.4V3h-.5a.5.5 0 01-.5-.5z" />
      </svg>
      <span className="hidden sm:inline">Trading Lab</span>
    </button>
  );
}

function WatchlistButton({ onClick }: { onClick: () => void }) {
  const { subscriptions } = useSubscriptions();
  return (
    <button
      type="button"
      onClick={onClick}
      className="btn-ghost gap-2"
      aria-label="Open watchlist"
    >
      <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
        <path d="M3 5.75A.75.75 0 013.75 5h12.5a.75.75 0 010 1.5H3.75A.75.75 0 013 5.75zM3 10a.75.75 0 01.75-.75h12.5a.75.75 0 010 1.5H3.75A.75.75 0 013 10zm.75 3.5a.75.75 0 000 1.5h12.5a.75.75 0 000-1.5H3.75z" />
      </svg>
      <span className="hidden sm:inline">Watchlist</span>
      {subscriptions.length > 0 && (
        <span className="pill bg-gold-400/20 text-gold-200 ml-1">{subscriptions.length}</span>
      )}
    </button>
  );
}

function SignInLink() {
  return (
    <Link
      to="/auth"
      className="btn-primary text-sm"
      aria-label="Sign in"
    >
      Sign in
    </Link>
  );
}

function Shell() {
  const { user, loading } = useAuth();
  const [watchlistOpen, setWatchlistOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-neutral-500">
        Loading…
      </div>
    );
  }

  // Anon users get the same shell but with reduced privileges. Pass
  // userId="" so SubscriptionsProvider knows to skip queries.
  return (
    <SubscriptionsProvider userId={user?.id ?? ""}>
      <div className="min-h-screen flex flex-col">
        <header className="border-b border-neutral-800 bg-neutral-950/80 backdrop-blur sticky top-0 z-30">
          <div className="max-w-[1500px] mx-auto px-4 sm:px-6 py-3 grid grid-cols-[1fr_2fr_1fr] items-center gap-4">
            <div className="flex items-center gap-2 min-w-0">
              <Link to="/" className="flex items-center gap-2 hover:opacity-80" aria-label="Home">
                <ButterflyIcon className="w-7 h-7" />
                <div className="hidden md:block text-left">
                  <div className="font-semibold tracking-tight leading-none">Gold Butterfly</div>
                  <div className="text-[10px] text-neutral-500 uppercase tracking-wider">
                    options intelligence
                  </div>
                </div>
              </Link>
              <AgentsButton onClick={() => setAgentsOpen(true)} />
            </div>

            <div className="flex justify-center min-w-0">
              <div className="w-full max-w-[640px]">
                <SymbolAddBar />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 min-w-0">
              {user ? <UserMenu /> : <SignInLink />}
              {user && <WatchlistButton onClick={() => setWatchlistOpen(true)} />}
            </div>
          </div>
        </header>

        <main className="flex-1 max-w-[1500px] mx-auto w-full px-4 sm:px-6 py-6">
          <Routes>
            <Route path="/" element={<HomeView />} />
            <Route path="/symbols/:symbol" element={<SymbolRoute />} />
            <Route path="/agents/:slug" element={<AgentRoute />} />
            <Route path="/auth" element={<AuthRoute />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>

        <WatchlistDrawer open={watchlistOpen} onClose={() => setWatchlistOpen(false)} />
        <AgentsDrawer open={agentsOpen} onClose={() => setAgentsOpen(false)} />
      </div>
    </SubscriptionsProvider>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Shell />
      </AuthProvider>
    </BrowserRouter>
  );
}
