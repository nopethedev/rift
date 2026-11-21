import { requireProfile } from "@/server/auth";
import { StreamScreen } from "./screen";

export const metadata = { title: "Streaming" };
export const dynamic = "force-dynamic";

export default async function StreamPage({ params }: { params: Promise<{ id: string }> }) {
  await requireProfile(); // the API enforces on-demand access and ownership
  const { id } = await params;
  return <StreamScreen id={id} />;
}
