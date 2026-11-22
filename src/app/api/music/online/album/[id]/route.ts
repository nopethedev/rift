import { route } from "@/server/api";
import { albumDetail } from "@/server/music/online";
import { online } from "@/server/music/online-api";

export const dynamic = "force-dynamic";
export const GET = route<{ id: string }>("profile", async ({ params }) => online(() => albumDetail(params.id)));
