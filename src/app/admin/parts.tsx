"use client";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
          <motion.div role="dialog" aria-modal="true" aria-label={title} initial={{ scale: 0.96, y: 8 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, opacity: 0 }} onClick={(e) => e.stopPropagation()} className={`max-h-[90vh] w-full overflow-y-auto rounded-2xl border border-line bg-surface p-6 shadow-2xl ${wide ? "max-w-3xl" : "max-w-md"}`}>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold">{title}</h2>
              <button onClick={onClose} aria-label="Close" className="text-muted hover:text-white"><X className="size-5" /></button>
            </div>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function ErrorNote({ msg }: { msg: string }) {
  return msg ? <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{msg}</p> : null;
}

export const ago = (iso?: string | null) => {
  if (!iso) return "never";
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
