import { requireProfile } from "@/server/auth";
import { ReleaseView } from "./view";

export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requireProfile();
  return <ReleaseView id={(await params).id} />;
}
