"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, Check, Lock, Pencil, Plus, Trash2, X } from "lucide-react";
import { Avatar, Logo } from "@/components/brand";
import { Button, Input, api } from "@/components/ui";
import { AVATAR_COLORS, AVATAR_ICONS, tmdbImg } from "@/lib/types";
import { PICK_COUNT, TASTE_GENRES } from "@/lib/taste";

interface P { id: string; name: string; avatar: string; isKids: boolean; hasPin: boolean; favoriteGenres: string[] }

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
      document.cookie = "rift_app=; Path=/; Max-Age=0"; // a new profile starts at the app picker
      router.replace("/apps");
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

function Overlay({ children, onClose, wide }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <motion.div role="dialog" aria-modal="true" initial={{ scale: 0.95, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, opacity: 0 }} className={`relative max-h-[92vh] w-full overflow-y-auto rounded-2xl border border-line bg-surface p-6 shadow-2xl ${wide ? "max-w-2xl" : "max-w-md"}`} onClick={(e) => e.stopPropagation()}>
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
  const [step, setStep] = useState<"details" | "genres">("details");
  const [genres, setGenres] = useState<string[]>(profile?.favoriteGenres ?? []);
  const isNew = !profile;
  const genresChanged = JSON.stringify(genres) !== JSON.stringify(profile?.favoriteGenres ?? []);

  async function save(withGenres = genres) {
    setBusy(true);
    setErr("");
    try {
      const body: Record<string, unknown> = { name, avatar, isKids };
      if (isNew ? withGenres.length > 0 : genresChanged) body.favoriteGenres = withGenres;
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

  if (step === "genres") {
    return (
      <Overlay onClose={onClose} wide>
        <GenreStep
          selected={genres} onChange={setGenres} name={name.trim() || "this profile"} err={err} busy={busy}
          onBack={() => setStep("details")}
          onSkip={isNew ? () => { setGenres([]); save([]); } : undefined}
          onDone={isNew ? () => save() : () => setStep("details")}
          doneLabel={isNew ? "Create profile" : "Done"}
        />
      </Overlay>
    );
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
        {!isKids && !isNew && (
          <div className="flex items-center justify-between gap-3 rounded-lg bg-white/5 px-3 py-2.5 text-sm">
            <span className="min-w-0 truncate text-white/80">
              <span className="text-muted">Favourite genres: </span>
              {genres.length ? genres.map((k) => TASTE_GENRES.find((g) => g.key === k)?.label).filter(Boolean).join(" · ") : "not chosen"}
            </span>
            <button type="button" onClick={() => setStep("genres")} className="shrink-0 text-violet-300 hover:underline">{genres.length ? "Change" : "Choose"}</button>
          </div>
        )}
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
            {isNew && !isKids
              ? <Button onClick={() => setStep("genres")} disabled={!name.trim() || (pinMode === "set" && pin.length !== 4)}>Next</Button>
              : <Button onClick={() => save()} loading={busy} disabled={!name.trim() || (pinMode === "set" && pin.length !== 4)}>{isNew ? "Create profile" : "Save"}</Button>}
          </div>
        </div>
      </div>
    </Overlay>
  );
}

/** "What do you like?": pick PICK_COUNT genres; they seed the home-page recommendations until there is watch history. */
function GenreStep({ selected, onChange, name, err, busy, onBack, onSkip, onDone, doneLabel }: {
  selected: string[]; onChange: (g: string[]) => void; name: string; err: string; busy: boolean;
  onBack: () => void; onSkip?: () => void; onDone: () => void; doneLabel: string;
}) {
  const [posters, setPosters] = useState<Record<string, string[]>>({});
  useEffect(() => {
    api<{ genres: { key: string; posters: string[] }[] }>("/api/taste/genres")
      .then((r) => setPosters(Object.fromEntries(r.genres.map((g) => [g.key, g.posters]))))
      .catch(() => {});
  }, []);
  const full = selected.length >= PICK_COUNT;
  const toggle = (k: string) => onChange(selected.includes(k) ? selected.filter((x) => x !== k) : full ? selected : [...selected, k]);
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold">What does {name} like to watch?</h2>
        <p className="mt-1 text-sm text-muted">Pick {PICK_COUNT} genres. We start with these and learn from what gets watched and saved.</p>
      </div>
      <div role="group" aria-label="Genres" className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        {TASTE_GENRES.map((g) => {
          const idx = selected.indexOf(g.key);
          const on = idx >= 0;
          const imgs = (posters[g.key] ?? []).slice(0, 3);
          return (
            <motion.button
              key={g.key} type="button" aria-pressed={on} disabled={!on && full} onClick={() => toggle(g.key)}
              whileTap={{ scale: 0.97 }}
              style={{ backgroundImage: `linear-gradient(135deg, ${g.from}, ${g.to})` }}
              className={`relative flex h-24 flex-col justify-end overflow-hidden rounded-xl p-3 text-left transition ${on ? "ring-[3px] ring-white" : "ring-1 ring-white/10"} ${!on && full ? "opacity-40" : "hover:brightness-110"}`}
            >
              {imgs.length > 0 && (
                <span aria-hidden className="absolute -right-2 -top-1 flex -space-x-5 opacity-90">
                  {imgs.map((p, i) => <img key={p} src={tmdbImg(p, "w185")!} alt="" loading="lazy" draggable={false} style={{ transform: `rotate(${(i - 1) * 7}deg)` }} className="h-20 w-14 rounded-md object-cover shadow-lg ring-1 ring-black/40" />)}
                </span>
              )}
              <span aria-hidden className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
              <span className="relative text-sm font-bold leading-tight drop-shadow">{g.label}</span>
              {on && <span className="absolute left-2 top-2 flex size-6 items-center justify-center rounded-full bg-white text-xs font-bold text-black"><Check className="size-3.5" /></span>}
            </motion.button>
          );
        })}
      </div>
      {err && <p className="text-sm text-red-300">{err}</p>}
      <div className="sticky bottom-0 -mx-6 -mb-6 flex items-center justify-between gap-2 border-t border-line bg-surface px-6 py-4">
        <Button variant="ghost" onClick={onBack}><ArrowLeft className="size-4" /> Back</Button>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">{selected.length}/{PICK_COUNT}</span>
          {onSkip && <Button variant="secondary" onClick={onSkip} disabled={busy}>Skip</Button>}
          <Button onClick={onDone} loading={busy} disabled={selected.length !== PICK_COUNT}>{doneLabel}</Button>
        </div>
      </div>
    </div>
  );
}
