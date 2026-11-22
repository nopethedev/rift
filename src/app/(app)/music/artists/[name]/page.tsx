import { requireProfile } from "@/server/auth";
import { ArtistView } from "./view";

export const dynamic = "force-dynamic";
export default async function Page({ params, searchParams }: { params: Promise<{ name: string }>; searchParams: Promise<{ id?: string }> }) {
  await requireProfile();
  const { id } = await searchParams;
  return <ArtistView name={decodeURIComponent((await params).name)} id={id && /^\d{1,12}$/.test(id) ? id : undefined} />;
}
