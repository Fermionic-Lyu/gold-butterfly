import { createContext, useContext, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { insforge } from "./insforge";
import type { Subscription } from "./types";

// Selection lives in the URL now (router-driven). This context owns only the
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

  // Single source of truth for the user's watchlist. Disabled when not
  // signed in (the query data stays an empty array via the data selector).
  const listQuery = useQuery<Subscription[]>({
    queryKey: SUBS_KEY,
    enabled: isAuthed,
    queryFn: async () => {
      const { data, error } = await insforge.database
        .from("subscriptions")
        .select("*")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Subscription[];
    },
  });
  const subscriptions = listQuery.data ?? [];

  // Optimistic add: cache update happens immediately via onMutate, the
  // real row replaces the temp on success, and the cache is rolled back
  // on failure. TanStack's mutation lifecycle handles all of this — no
  // hand-rolled cancellation flags.
  const addMutation = useMutation<
    Subscription,
    Error,
    string,
    { tempId: string }
  >({
    mutationFn: async (symbol: string) => {
      const { data, error } = await insforge.database
        .from("subscriptions")
        .insert([{ user_id: userId, symbol }])
        .select("*");
      if (error) throw error;
      const rows = (data ?? []) as Subscription[];
      if (rows.length === 0) throw new Error("Insert returned no rows");
      return rows[0];
    },
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
      queryClient.setQueryData<Subscription[]>(SUBS_KEY, (curr) => [
        ...(curr ?? []),
        tempRow,
      ]);
      return { tempId };
    },
    onSuccess: (real, _symbol, ctx) => {
      queryClient.setQueryData<Subscription[]>(SUBS_KEY, (curr) =>
        (curr ?? []).map((s) => (s.id === ctx?.tempId ? real : s)),
      );
    },
    onError: (_err, _symbol, ctx) => {
      // Drop the optimistic row on failure.
      queryClient.setQueryData<Subscription[]>(SUBS_KEY, (curr) =>
        (curr ?? []).filter((s) => s.id !== ctx?.tempId),
      );
    },
  });

  const removeMutation = useMutation<
    void,
    Error,
    string,
    { removed: Subscription | undefined }
  >({
    mutationFn: async (id: string) => {
      const { error } = await insforge.database.from("subscriptions").delete().eq("id", id);
      if (error) throw error;
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
          (a, b) =>
            new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
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
      const msg = err?.message ?? "Failed to add";
      return {
        error: msg.includes("duplicate") ? `${symbol} is already in your watchlist.` : msg,
        symbol: null,
      };
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
