"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { Lock, Pencil, Plus, Trash2, X } from "lucide-react";
import { Avatar, Logo } from "@/components/brand";
import { Button, Input, api } from "@/components/ui";
import { AVATAR_COLORS, AVATAR_ICONS } from "@/lib/types";

interface P { id: string; name: string; avatar: string; isKids: boolean; hasPin: boolean }

export function ProfilePicker({ profiles, max, startManaging }: { profiles: P[]; max: number; startManaging: boolean }) {
  const router = useRouter();
  const [managing, setManaging] = useState(startManaging);
  const [pinFor, setPinFor] = useState<P | null>(null);
  const [editing, setEditing] = useState<P | "new" | null>(null);
  const [error, setError] = useState("");

  async function choose(p: P, pin?: string) {
    setError("");
    try {
      await api(`/api/profiles/${p.id}`, { method: "POST", body: { pin } });
      router.replace("/");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <Logo className="absolute left-6 top-6" />
      <motion.h1 initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mb-10 text-3xl font-bold sm:text-5xl">
        {managing ? "Manage profiles" : "Who's watching?"}
      </motion.h1>
      <div className="flex max-w-3xl flex-wrap justify-center gap-5 sm:gap-8">
        {profiles.map((p, i) => (
          <motion.button
            key={p.id}
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
            whileHover={{ scale: 1.06 }}
            onClick={() => (managing ? setEditing(p) : p.hasPin ? setPinFor(p) : choose(p))}
            className="group flex w-28 flex-col items-center gap-3 outline-none sm:w-32"
          >
            <span className="relative rounded-xl ring-2 ring-transparent transition group-hover:ring-white/80 group-focus-visible:ring-accent">
              <Avatar avatar={p.avatar} size={112} />
              {managing && (
                <span className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/55"><Pencil className="size-7" /></span>
              )}
              {p.hasPin && !managing && <Lock className="absolute bottom-1.5 right-1.5 size-4 rounded bg-black/60 p-0.5" />}
            </span>
            <span className="max-w-full truncate text-base text-white/70 group-hover:text-white">{p.name}</span>
            {p.isKids && <span className="-mt-2 text-[10px] font-semibold uppercase text-sky-300">Kids</span>}
          </motion.button>
        ))}
        {profiles.length < max && (
          <motion.button
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} whileHover={{ scale: 1.06 }}
            onClick={() => setEditing("new")}
            className="group flex w-28 flex-col items-center gap-3 outline-none sm:w-32"
          >
            <span className="flex size-28 items-center justify-center rounded-xl border-2 border-dashed border-line text-muted transition group-hover:border-white/70 group-hover:text-white group-focus-visible:border-accent">
              <Plus className="size-10" />
            </span>
            <span className="text-base text-white/70">Add profile</span>
          </motion.button>
        )}
      </div>
      {error && !pinFor && <p className="mt-6 text-sm text-red-300">{error}</p>}
      <Button variant="secondary" className="mt-12" onClick={() => setManaging((m) => !m)}>{managing ? "Done" : "Manage profiles"}</Button>

      <AnimatePresence>
        {pinFor && <PinModal profile={pinFor} error={error} onClose={() => { setPinFor(null); setError(""); }} onSubmit={(pin) => choose(pinFor, pin)} />}
        {editing && <EditModal profile={editing === "new" ? null : editing} canDelete={profiles.length > 1} onClose={() => setEditing(null)} onDone={() => { setEditing(null); router.refresh(); }} />}
      </AnimatePresence>
    </main>
  );
}

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <motion.div initial={{ scale: 0.95, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, opacity: 0 }} className="relative w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} aria-label="Close" className="absolute right-4 top-4 text-muted hover:text-white"><X className="size-5" /></button>
        {children}
      </motion.div>
    </motion.div>
  );
}

function PinModal({ profile, error, onClose, onSubmit }: { profile: P; error: string; onClose: () => void; onSubmit: (pin: string) => void }) {
  const [pin, setPin] = useState("");
  return (
    <Overlay onClose={onClose}>
      <div className="flex flex-col items-center gap-4 text-center">
        <Avatar avatar={profile.avatar} size={72} />
        <h2 className="text-xl font-bold">Enter PIN for {profile.name}</h2>
        <form onSubmit={(e) => { e.preventDefault(); onSubmit(pin); setPin(""); }} className="w-full space-y-3">
          <Input autoFocus inputMode="numeric" maxLength={4} pattern="\d{4}" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} className="text-center text-2xl tracking-[0.6em]" aria-label="PIN" />
          {error && <p className="text-sm text-red-300">{error}</p>}
          <Button type="submit" className="w-full" disabled={pin.length !== 4}>Unlock</Button>
        </form>
      </div>
    </Overlay>
  );
}

function EditModal({ profile, canDelete, onClose, onDone }: { profile: P | null; canDelete: boolean; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(profile?.name ?? "");
  const [avatar, setAvatar] = useState(profile?.avatar ?? "smile:violet");
  const [isKids, setIsKids] = useState(profile?.isKids ?? false);
  const [pinMode, setPinMode] = useState<"keep" | "set" | "remove">("keep");
  const [pin, setPin] = useState("");
  const [currentPin, setCurrentPin] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [icon, color] = avatar.split(":");

  async function save() {
    setBusy(true);
    setErr("");
    try {
      const body: Record<string, unknown> = { name, avatar, isKids };
      if (pinMode === "set") body.pin = pin;
      if (pinMode === "remove") body.pin = null;
      if (profile?.hasPin) body.currentPin = currentPin;
      if (profile) await api(`/api/profiles/${profile.id}`, { method: "PATCH", body });
      else await api("/api/profiles", { method: "POST", body });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  async function remove() {
    if (!profile || !confirm(`Delete profile "${profile.name}" and its history?`)) return;
    setBusy(true);
    try {
      await api(`/api/profiles/${profile.id}?pin=${encodeURIComponent(currentPin)}`, { method: "DELETE" });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Overlay onClose={onClose}>
      <h2 className="mb-5 text-xl font-bold">{profile ? "Edit profile" : "New profile"}</h2>
      <div className="space-y-4">
        <div className="flex items-center gap-4">
          <Avatar avatar={avatar} size={72} />
          <Input label="Name" value={name} maxLength={24} onChange={(e) => setName(e.target.value)} className="flex-1" />
        </div>
        <div>
          <p className="mb-2 text-sm font-medium text-white/80">Avatar</p>
          <div className="flex flex-wrap gap-2">
            {AVATAR_ICONS.map((i) => (
              <button key={i} type="button" aria-label={i} onClick={() => setAvatar(`${i}:${color}`)} className={`rounded-lg p-0.5 ${i === icon ? "ring-2 ring-white" : "opacity-70 hover:opacity-100"}`}><Avatar avatar={`${i}:${color}`} size={36} /></button>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {AVATAR_COLORS.map((c) => (
              <button key={c} type="button" aria-label={c} onClick={() => setAvatar(`${icon}:${c}`)} className={`rounded-lg p-0.5 ${c === color ? "ring-2 ring-white" : "opacity-70 hover:opacity-100"}`}><Avatar avatar={`smile:${c}`} size={22} /></button>
            ))}
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={isKids} onChange={(e) => setIsKids(e.target.checked)} className="accent-violet-500" /> Kids profile (family-friendly content only)</label>
        {profile?.hasPin && <Input label="Current PIN" inputMode="numeric" maxLength={4} value={currentPin} onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, ""))} />}
        <div className="flex gap-2 text-sm">
          {(profile?.hasPin ? (["keep", "set", "remove"] as const) : (["keep", "set"] as const)).map((m) => (
            <button key={m} type="button" onClick={() => setPinMode(m)} className={`rounded-lg px-3 py-1.5 ${pinMode === m ? "bg-accent/30 text-white" : "bg-white/5 text-muted hover:text-white"}`}>
              {m === "keep" ? (profile?.hasPin ? "Keep PIN" : "No PIN") : m === "set" ? (profile?.hasPin ? "Change PIN" : "Set PIN") : "Remove PIN"}
            </button>
          ))}
        </div>
        {pinMode === "set" && <Input label="New 4-digit PIN" inputMode="numeric" maxLength={4} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />}
        {err && <p className="text-sm text-red-300">{err}</p>}
        <div className="flex items-center justify-between pt-2">
          {profile && canDelete ? <Button variant="ghost" onClick={remove} className="text-red-300"><Trash2 className="size-4" /> Delete</Button> : <span />}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={save} loading={busy} disabled={!name.trim() || (pinMode === "set" && pin.length !== 4)}>Save</Button>
          </div>
        </div>
      </div>
    </Overlay>
  );
}
