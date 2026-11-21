"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, api } from "@/components/ui";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setLoading(true);
    setError("");
    try {
      await api("/api/auth/login", { method: "POST", body: { username: f.get("username"), password: f.get("password") } });
      router.replace("/profiles");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Input name="username" label="Username" autoComplete="username" autoFocus required />
      <Input name="password" type="password" label="Password" autoComplete="current-password" required />
      {error && <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}
      <Button type="submit" loading={loading} className="w-full" size="lg">Sign in</Button>
    </form>
  );
}
