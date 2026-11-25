import { redirect } from "next/navigation";
import { requireProfile } from "@/server/auth";
import { db } from "@/server/db";
import { MusicHome } from "./home";

export const dynamic = "force-dynamic";
export default async function Page() {
  const a = await requireProfile();
  const p = await db.profile.findUnique({ where: { id: a.profile.id }, select: { musicOnboardedAt: true } });
  if (!p?.musicOnboardedAt) {
    // Profiles that already use Music skip the setup; new ones start with it once.
    const [plays, lists, saved] = await Promise.all([db.musicPlay.count({ where: { profileId: a.profile.id } }), db.musicPlaylist.count({ where: { profileId: a.profile.id } }), db.musicSaved.count({ where: { profileId: a.profile.id } })]);
    if (plays >= 5 || lists > 0 || saved > 0) await db.profile.update({ where: { id: a.profile.id }, data: { musicOnboardedAt: new Date() } });
    else redirect("/music/welcome");
  }
  return <MusicHome name={a.profile.name} isAdmin={a.user.role === "ADMIN"} />;
}
