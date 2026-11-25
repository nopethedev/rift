import { headers } from "next/headers";
import { requireProfile } from "@/server/auth";
import { WelcomeView } from "./view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Set up Music" };

export default async function Page() {
  const a = await requireProfile();
  const android = /Android/i.test((await headers()).get("user-agent") ?? "");
  return <WelcomeView name={a.profile.name} android={android} />;
}
