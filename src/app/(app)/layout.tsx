import { requireProfile } from "@/server/auth";
import { onDemandAllowed } from "@/server/ondemand";
import { AppProviders } from "@/components/providers";
import { MobileTabs, Navbar } from "@/components/navbar";
import { MusicProvider } from "@/components/music/player-provider";
import { MusicSpacer, PlayerBar } from "@/components/music/player-bar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const auth = await requireProfile();
  return (
    <AppProviders onDemand={await onDemandAllowed(auth)}>
      <MusicProvider>
        <Navbar profile={{ name: auth.profile.name, avatar: auth.profile.avatar }} isAdmin={auth.user.role === "ADMIN"} />
        <main className="pb-24 md:pb-16">{children}<MusicSpacer /></main>
        <PlayerBar />
        <MobileTabs />
      </MusicProvider>
    </AppProviders>
  );
}
