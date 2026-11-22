import { requireProfile } from "@/server/auth";
import { lastApp } from "@/server/app-choice";
import { musicMode } from "@/server/music/config";
import { getSettings } from "@/server/settings";
import { AppPicker } from "./picker";

export const metadata = { title: "Choose an app" };
export const dynamic = "force-dynamic";

export default async function AppsPage() {
  const a = await requireProfile();
  const s = await getSettings();
  const m = musicMode(s, a.user);
  return <AppPicker profile={{ name: a.profile.name, avatar: a.profile.avatar }} last={await lastApp()} musicHint={s.musicSource === "local" ? "Your library" : m.onDemand ? "Library + on-demand" : "Your library"} />;
}
