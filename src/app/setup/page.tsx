import { redirect } from "next/navigation";
import { isSetupComplete } from "@/server/auth";
import { env } from "@/server/config";
import { Logo } from "@/components/brand";
import { SetupWizard } from "./wizard";

export const metadata = { title: "Setup" };

export default async function SetupPage() {
  if (await isSetupComplete()) redirect("/login");
  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_45%_at_50%_0%,rgba(139,92,246,0.3),transparent)]" />
      <div className="relative w-full max-w-xl">
        <Logo className="mb-6 justify-center" size={40} />
        <SetupWizard defaults={{ mediaDir: env.mediaDir, downloadDir: env.downloadDir + "", hasEnvTmdb: !!env.tmdbKey }} />
      </div>
    </main>
  );
}
