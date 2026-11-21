import { requireProfile } from "@/server/auth";
import { Player } from "@/components/player/player";

export const metadata = { title: "Watch" };
export const dynamic = "force-dynamic";

export default async function WatchPage({ params }: { params: Promise<{ id: string }> }) {
  await requireProfile();
  const { id } = await params;
  return <Player key={id} fileId={id} />;
}
