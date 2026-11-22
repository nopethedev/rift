import { requireProfile } from "@/server/auth";
import { MusicHome } from "./home";

export const dynamic = "force-dynamic";
export default async function Page() {
  const a = await requireProfile();
  return <MusicHome isAdmin={a.user.role === "ADMIN"} />;
}
