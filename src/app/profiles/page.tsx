import { redirect } from "next/navigation";
import { db } from "@/server/db";
import { requireUser, MAX_PROFILES } from "@/server/auth";
import { parseFavoriteGenres } from "@/lib/taste";
import { ProfilePicker } from "./picker";

export const metadata = { title: "Who's watching?" };

export default async function ProfilesPage({ searchParams }: { searchParams: Promise<{ manage?: string }> }) {
  const auth = await requireUser();
  const profiles = await db.profile.findMany({ where: { userId: auth.user.id }, orderBy: { createdAt: "asc" } });
  if (!profiles.length) redirect("/setup");
  const sp = await searchParams;
  return (
    <ProfilePicker
      max={MAX_PROFILES}
      startManaging={sp.manage === "1"}
      profiles={profiles.map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, isKids: p.isKids, hasPin: !!p.pinHash, favoriteGenres: parseFavoriteGenres(p.favoriteGenres) }))}
    />
  );
}
