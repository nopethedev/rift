import { requireProfile } from "@/server/auth";
import { AppProviders } from "@/components/providers";
import { MobileTabs, Navbar } from "@/components/navbar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const auth = await requireProfile();
  return (
    <AppProviders>
      <Navbar profile={{ name: auth.profile.name, avatar: auth.profile.avatar }} isAdmin={auth.user.role === "ADMIN"} />
      <main className="pb-24 md:pb-16">{children}</main>
      <MobileTabs />
    </AppProviders>
  );
}
