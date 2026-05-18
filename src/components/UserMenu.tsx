import { useEffect, useRef, useState } from "react";
import { useAuth } from "../lib/AuthContext";

function initialsOf(name: string | null, email: string | null): string {
  const src = (name && name.trim()) || (email && email.split("@")[0]) || "?";
  const parts = src.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return src.slice(0, 1).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export default function UserMenu() {
  const { user, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!user) return null;
  const display = user.name ?? user.email ?? "Account";
  const initials = initialsOf(user.name, user.email);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-neutral-800 transition-colors"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {user.avatarUrl ? (
          <img
            src={user.avatarUrl}
            alt=""
            className="h-8 w-8 rounded-full object-cover ring-1 ring-neutral-700"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          <span className="h-8 w-8 rounded-full bg-gold-400/20 text-gold-200 text-xs font-semibold flex items-center justify-center ring-1 ring-gold-400/40">
            {initials}
          </span>
        )}
        <span className="hidden sm:inline text-sm text-neutral-200 max-w-[160px] truncate">
          {display}
        </span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 20 20"
          fill="currentColor"
          className={`text-neutral-500 transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.24 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-64 card p-2 shadow-2xl z-50"
        >
          <div className="px-3 py-2 border-b border-neutral-800 mb-1">
            <div className="text-sm font-medium text-neutral-100 truncate">{display}</div>
            {user.email && user.email !== display && (
              <div className="text-xs text-neutral-500 truncate">{user.email}</div>
            )}
          </div>
          <button
            type="button"
            onClick={async () => {
              setOpen(false);
              await signOut();
            }}
            className="w-full text-left text-sm rounded-md px-3 py-2 text-neutral-200 hover:bg-neutral-800"
            role="menuitem"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
