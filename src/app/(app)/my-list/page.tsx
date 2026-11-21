import { requireProfile } from "@/server/auth";
import { myList } from "@/server/catalog";
import { PosterCard } from "@/components/poster-card";
import { Bookmark } from "lucide-react";

export const metadata = { title: "My List" };
export const dynamic = "force-dynamic";

export default async function MyListPage() {
  const { profile } = await requireProfile();
  const items = await myList(profile.id);
  return (
    <div className="px-4 pt-24 sm:px-12">
      <h1 className="mb-6 text-3xl font-bold">My List</h1>
      {items.length ? (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
          {items.map((i) => <PosterCard key={i.key} item={i} />)}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 py-24 text-center text-muted">
          <Bookmark className="size-10" />
          <p>Nothing here yet. Use the + button on any title to save it for later.</p>
        </div>
      )}
    </div>
  );
}
