import { requireProfile } from "@/server/auth";
import { GenreView } from "./view";

export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requireProfile();
  return <GenreView id={(await params).id} />;
}
