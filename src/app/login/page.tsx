import { redirect } from "next/navigation";
import { getAuth, isSetupComplete } from "@/server/auth";
import { Logo } from "@/components/brand";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (!(await isSetupComplete())) redirect("/setup");
  if (await getAuth()) redirect("/");
  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,rgba(139,92,246,0.28),transparent)]" />
      <div className="relative w-full max-w-sm">
        <Logo className="mb-8 justify-center" size={36} />
        <div className="rounded-2xl border border-line bg-surface/80 p-7 shadow-2xl backdrop-blur">
          <h1 className="mb-1 text-2xl font-bold">Welcome back</h1>
          <p className="mb-6 text-sm text-muted">Sign in to continue watching.</p>
          <LoginForm />
        </div>
      </div>
    </main>
  );
}
