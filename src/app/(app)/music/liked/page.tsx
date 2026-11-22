import { requireProfile } from "@/server/auth";
import { LikedView } from "./view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Liked songs" };
export default async function Page() {
  await requireProfile();
  return <LikedView />;
}
