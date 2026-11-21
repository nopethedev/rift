import { requireProfile } from "@/server/auth";
import { SearchResults } from "./results";

export const metadata = { title: "Search" };

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireProfile();
  const { q = "" } = await searchParams;
  return (
    <div className="px-4 pt-24 sm:px-12">
      <SearchResults q={q} />
    </div>
  );
}
