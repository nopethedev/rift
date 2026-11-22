"use client";
import { usePathname } from "next/navigation";
import { MobileTabs, Navbar } from "./navbar";
import { MusicShell } from "./music/shell";
import { MusicSpacer, PlayerBar } from "./music/player-bar";

/** Stream (movies/TV) and Music are two apps with their own chrome; the URL decides which one is showing. */
export function AppChrome({ profile, isAdmin, children }: { profile: { name: string; avatar: string }; isAdmin: boolean; children: React.ReactNode }) {
  const music = usePathname().startsWith("/music");
  if (music) {
    return (
      <>
        <MusicShell profile={profile} isAdmin={isAdmin}>{children}</MusicShell>
        <PlayerBar />
      </>
    );
  }
  return (
    <>
      <Navbar profile={profile} isAdmin={isAdmin} />
      <main className="pb-24 md:pb-16">{children}<MusicSpacer /></main>
      <PlayerBar />
      <MobileTabs />
    </>
  );
}
