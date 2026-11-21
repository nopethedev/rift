import { route } from "@/server/api";
import { osCall } from "@/server/subtitle-service";

/** Check the saved OpenSubtitles API key / login. */
export const POST = route("admin", async () => ({ result: await osCall((os) => os.test()) }), { rate: { key: "os-test", max: 10, windowMs: 60_000 } });
