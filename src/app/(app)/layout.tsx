import { requireProfile } from "@/server/auth";
import { onDemandAllowed } from "@/server/ondemand";
import { AppProviders } from "@/components/providers";
import { AppChrome } from "@/components/app-chrome";
import { MusicProvider } from "@/components/music/player-provider";
import { SavedProvider } from "@/components/music/saved-provider";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const auth = await requireProfile();
  return (
    <AppProviders onDemand={await onDemandAllowed(auth)}>
      <MusicProvider>
        <SavedProvider>
          <AppChrome profile={{ name: auth.profile.name, avatar: auth.profile.avatar }} isAdmin={auth.user.role === "ADMIN"}>{children}</AppChrome>
        </SavedProvider>
      </MusicProvider>
    </AppProviders>
  );
}
