"use client";
import { useState } from "react";
import { KeyRound, Plus, ShieldCheck, Trash2, UserX, UserCheck } from "lucide-react";
import { usePoll } from "@/lib/use-poll";
import { Badge, Button, Card, Input, Select, Skeleton, api } from "@/components/ui";
import { ErrorNote, Modal, PageHeader, ago } from "../parts";

interface U { id: string; username: string; role: "ADMIN" | "USER"; disabled: boolean; lastLoginAt: string | null; profiles: number; sessions: number }

export default function UsersPage() {
  const { data, loading, reload } = usePoll<{ users: U[] }>("/api/admin/users");
  const [creating, setCreating] = useState(false);
  const [resetFor, setResetFor] = useState<U | null>(null);
  const [err, setErr] = useState("");

  const act = async (fn: () => Promise<unknown>) => {
    setErr("");
    try { await fn(); await reload(); } catch (e) { setErr((e as Error).message); }
  };

  return (
    <>
      <PageHeader title="Users" subtitle="Each user can have up to 5 profiles with separate history and lists." actions={<Button onClick={() => setCreating(true)}><Plus className="size-4" /> New user</Button>} />
      <ErrorNote msg={err} />
      <Card className="mt-3 overflow-x-auto p-0">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
            <tr><th className="px-4 py-3">User</th><th>Role</th><th>Profiles</th><th>Last login</th><th className="pr-4 text-right">Actions</th></tr>
          </thead>
          <tbody className="divide-y divide-line">
            {loading && Array.from({ length: 3 }).map((_, i) => <tr key={i}><td colSpan={5} className="p-3"><Skeleton className="h-8" /></td></tr>)}
            {data?.users.map((u) => (
              <tr key={u.id} className={u.disabled ? "opacity-50" : ""}>
                <td className="px-4 py-3 font-medium">{u.username} {u.disabled && <Badge tone="red">disabled</Badge>}</td>
                <td><Badge tone={u.role === "ADMIN" ? "accent" : "default"}>{u.role}</Badge></td>
                <td>{u.profiles}</td>
                <td className="text-muted">{ago(u.lastLoginAt)}</td>
                <td className="pr-4">
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="ghost" title={u.role === "ADMIN" ? "Make regular user" : "Make admin"} onClick={() => act(() => api(`/api/admin/users/${u.id}`, { method: "PATCH", body: { role: u.role === "ADMIN" ? "USER" : "ADMIN" } }))}><ShieldCheck className="size-4" /></Button>
                    <Button size="sm" variant="ghost" title="Reset password" onClick={() => setResetFor(u)}><KeyRound className="size-4" /></Button>
                    <Button size="sm" variant="ghost" title={u.disabled ? "Enable" : "Disable"} onClick={() => act(() => api(`/api/admin/users/${u.id}`, { method: "PATCH", body: { disabled: !u.disabled } }))}>{u.disabled ? <UserCheck className="size-4" /> : <UserX className="size-4" />}</Button>
                    <Button size="sm" variant="ghost" title="Delete" className="text-red-300" onClick={() => confirm(`Delete ${u.username} and all their profiles?`) && act(() => api(`/api/admin/users/${u.id}`, { method: "DELETE" }))}><Trash2 className="size-4" /></Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <CreateUser open={creating} onClose={() => setCreating(false)} onDone={() => { setCreating(false); reload(); }} />
      <ResetPw user={resetFor} onClose={() => setResetFor(null)} />
    </>
  );
}

function CreateUser({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ username: "", password: "", role: "USER" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={open} onClose={onClose} title="New user">
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr("");
        try { await api("/api/admin/users", { method: "POST", body: f }); setF({ username: "", password: "", role: "USER" }); onDone(); } catch (x) { setErr((x as Error).message); }
        setBusy(false);
      }}>
        <Input label="Username" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} required autoFocus />
        <Input label="Password" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} hint="At least 8 characters" required />
        <Select label="Role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="USER">User</option><option value="ADMIN">Administrator</option></Select>
        <ErrorNote msg={err} />
        <Button type="submit" loading={busy} className="w-full">Create user</Button>
      </form>
    </Modal>
  );
}

function ResetPw({ user, onClose }: { user: U | null; onClose: () => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  return (
    <Modal open={!!user} onClose={onClose} title={`Reset password · ${user?.username ?? ""}`}>
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault(); setErr("");
        try { await api(`/api/admin/users/${user!.id}`, { method: "PATCH", body: { password: pw } }); setPw(""); onClose(); } catch (x) { setErr((x as Error).message); }
      }}>
        <Input label="New password" type="password" value={pw} onChange={(e) => setPw(e.target.value)} hint="The user is signed out everywhere." required autoFocus />
        <ErrorNote msg={err} />
        <Button type="submit" className="w-full">Set password</Button>
      </form>
    </Modal>
  );
}
