"use client";
import clsx from "clsx";
import { Loader2 } from "lucide-react";
import { forwardRef } from "react";

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button(
  { variant = "primary", size = "md", loading, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={clsx(
        "inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition select-none disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white",
        size === "sm" && "px-3 py-1.5 text-sm",
        size === "md" && "px-4 py-2.5 text-sm",
        size === "lg" && "px-6 py-3 text-base",
        variant === "primary" && "btn-primary text-white",
        variant === "secondary" && "bg-white/10 hover:bg-white/20 text-white border border-white/10",
        variant === "ghost" && "hover:bg-white/10 text-white/90",
        variant === "danger" && "bg-red-600/90 hover:bg-red-500 text-white",
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  );
});

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: string }>(function Input(
  { label, hint, className, id, ...rest },
  ref,
) {
  const iid = id ?? rest.name;
  return (
    <label className="block text-sm" htmlFor={iid}>
      {label && <span className="mb-1.5 block font-medium text-white/80">{label}</span>}
      <input
        ref={ref}
        id={iid}
        className={clsx(
          "w-full rounded-lg border border-line bg-surface px-3.5 py-2.5 text-white placeholder:text-white/30 outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/30 disabled:opacity-50",
          className,
        )}
        {...rest}
      />
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
});

export function Select({ label, className, children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement> & { label?: string }) {
  return (
    <label className="block text-sm">
      {label && <span className="mb-1.5 block font-medium text-white/80">{label}</span>}
      <select
        className={clsx("w-full rounded-lg border border-line bg-surface px-3.5 py-2.5 text-white outline-none focus:border-accent focus:ring-2 focus:ring-accent/30", className)}
        {...rest}
      >
        {children}
      </select>
    </label>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx("skeleton", className)} />;
}

export function Badge({ children, tone = "default", className }: { children: React.ReactNode; tone?: "default" | "accent" | "green" | "amber" | "red"; className?: string }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
        tone === "default" && "bg-white/10 text-white/80",
        tone === "accent" && "bg-accent/25 text-violet-200",
        tone === "green" && "bg-emerald-500/20 text-emerald-300",
        tone === "amber" && "bg-amber-500/20 text-amber-300",
        tone === "red" && "bg-red-500/20 text-red-300",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={clsx("rounded-2xl border border-line bg-surface p-5", className)}>{children}</div>;
}

export function ProgressBar({ value, className }: { value: number; className?: string }) {
  return (
    <div className={clsx("h-1.5 overflow-hidden rounded-full bg-white/10", className)}>
      <div className="h-full rounded-full bg-gradient-to-r from-accent to-accent-dark transition-[width]" style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }} />
    </div>
  );
}

export async function api<T = any>(url: string, init?: Omit<RequestInit, "body"> & { body?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init?.body !== undefined ? { "content-type": "application/json" } : {}), ...(init?.headers ?? {}) },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}
