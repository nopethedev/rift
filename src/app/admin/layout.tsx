import { requireAdmin } from "@/server/auth";
import { AdminNav } from "./nav";

export const metadata = { title: { default: "Admin", template: "%s · Admin · Rift" } };
export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const auth = await requireAdmin();
  return (
    <div className="min-h-dvh lg:flex">
      <AdminNav username={auth.user.username} />
      <main className="min-w-0 flex-1 px-4 py-6 sm:px-8 lg:py-8">{children}</main>
    </div>
  );
}
