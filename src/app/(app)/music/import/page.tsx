import { ImportView } from "./view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Import from Spotify" };

/** Also the PWA share target: Spotify → Share → Rift lands here with the link in `text`/`url`. */
export default async function Page({ searchParams }: { searchParams: Promise<{ url?: string; text?: string; title?: string }> }) {
  const sp = await searchParams;
  const shared = [sp.url, sp.text].filter(Boolean).join("\n").slice(0, 5000);
  return <ImportView shared={shared} />;
}
