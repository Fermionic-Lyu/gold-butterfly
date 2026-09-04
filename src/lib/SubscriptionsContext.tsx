import { createContext, useContext, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type { Subscription } from "./types";

// Selection lives in the URL (router-driven). This context owns only the
// list and its mutations.
interface SubscriptionsContextValue {
  subscriptions: Subscription[];
  loading: boolean;
  addSymbol: (symbol: string) => Promise<{ error: string | null; symbol: string | null }>;
  removeSubscription: (id: string) => Promise<{ error: string | null }>;
  reload: () => Promise<void>;
}

const SubscriptionsContext = createContext<SubscriptionsContextValue | undefined>(undefined);

const SUBS_KEY = ["subscriptions"] as const;

export function SubscriptionsProvider({
  userId,
  children,
}: {
  userId: string;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const isAuthed = userId.length > 0;

  const listQuery = useQuery<Subscription[]>({
    queryKey: SUBS_KEY,
    enabled: isAuthed,
    queryFn: () => api.get<Subscription[]>("/api/subscriptions"),
  });
  const subscriptions = listQuery.data ?? [];

  // Optimistic add: the temp row is swapped for the real one on success and
  // dropped on failure.
  const addMutation = useMutation<Subscription, Error, string, { tempId: string }>({
    mutationFn: (symbol: string) => api.post<Subscription>("/api/subscriptions", { symbol }),
    onMutate: async (symbol) => {
      await queryClient.cancelQueries({ queryKey: SUBS_KEY });
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const tempRow: Subscription = {
        id: tempId,
        user_id: userId,
        symbol,
        notes: null,
        created_at: new Date().toISOString(),
      };
      queryClient.setQueryData<Subscription[]>(SUBS_KEY, (curr) => [...(curr ?? []), tempRow]);
      return { tempId };
    },
    onSuccess: (real, _symbol, ctx) => {
      queryClient.setQueryData<Subscription[]>(SUBS_KEY, (curr) =>
        (curr ?? []).map((s) => (s.id === ctx?.tempId ? real : s)),
      );
    },
    onError: (_err, _symbol, ctx) => {
      queryClient.setQueryData<Subscription[]>(SUBS_KEY, (curr) =>
        (curr ?? []).filter((s) => s.id !== ctx?.tempId),
      );
    },
  });

  const removeMutation = useMutation<void, Error, string, { removed: Subscription | undefined }>({
    mutationFn: async (id: string) => {
      await api.del(`/api/subscriptions/${id}`);
    },
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: SUBS_KEY });
      const curr = queryClient.getQueryData<Subscription[]>(SUBS_KEY) ?? [];
      const removed = curr.find((s) => s.id === id);
      queryClient.setQueryData<Subscription[]>(SUBS_KEY, curr.filter((s) => s.id !== id));
      return { removed };
    },
    onError: (_err, _id, ctx) => {
      if (!ctx?.removed) return;
      const removed = ctx.removed;
      queryClient.setQueryData<Subscription[]>(SUBS_KEY, (curr) =>
        [...(curr ?? []), removed].sort(
          (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
        ),
      );
    },
  });

  const addSymbol: SubscriptionsContextValue["addSymbol"] = async (raw) => {
    const symbol = raw.trim().toUpperCase();
    if (!symbol) return { error: "Empty symbol", symbol: null };
    if (!isAuthed) return { error: "Sign in to save symbols.", symbol: null };
    if (subscriptions.some((s) => s.symbol === symbol)) {
      return { error: `${symbol} is already in your watchlist.`, symbol: null };
    }
    try {
      await addMutation.mutateAsync(symbol);
      return { error: null, symbol };
    } catch (err: any) {
      return { error: err?.message ?? "Failed to add", symbol: null };
    }
  };

  const removeSubscription: SubscriptionsContextValue["removeSubscription"] = async (id) => {
    if (!isAuthed) return { error: "Sign in required" };
    if (!subscriptions.some((s) => s.id === id)) return { error: "Not found" };
    try {
      await removeMutation.mutateAsync(id);
      return { error: null };
    } catch (err: any) {
      return { error: err?.message ?? "Failed to remove" };
    }
  };

  const reload = async () => {
    await queryClient.invalidateQueries({ queryKey: SUBS_KEY });
  };

  return (
    <SubscriptionsContext.Provider
      value={{
        subscriptions,
        loading: listQuery.isPending && isAuthed,
        addSymbol,
        removeSubscription,
        reload,
      }}
    >
      {children}
    </SubscriptionsContext.Provider>
  );
}

export function useSubscriptions() {
  const ctx = useContext(SubscriptionsContext);
  if (!ctx) throw new Error("useSubscriptions must be used within SubscriptionsProvider");
  return ctx;
}
