import { requireAdmin } from "@/server/auth";
import { StreamScreen } from "./screen";

export const metadata = { title: "Streaming" };
export const dynamic = "force-dynamic";

export default async function StreamPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  return <StreamScreen id={id} />;
}
