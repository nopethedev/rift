import { route } from "@/server/api";
import { getSettings } from "@/server/settings";
import { searchForFile } from "@/server/subtitle-service";

/** Search OpenSubtitles.com for a library file: ?fileId=&languages=en,fr&q=optional free text. */
export const GET = route("admin", async ({ req }) => {
  const sp = req.nextUrl.searchParams;
  const fileId = sp.get("fileId") ?? "";
  const s = await getSettings();
  const langs = (sp.get("languages") ?? "").split(",").map((l) => l.trim().toLowerCase()).filter((l) => /^[a-z]{2,3}(-[a-z]{2,4})?$/.test(l)).slice(0, 8);
  const languages = langs.length ? langs : s.subtitleLanguages;
  const results = await searchForFile(fileId, languages, sp.get("q") ?? undefined);
  return { results, languages };
}, { rate: { key: "os-search", max: 30, windowMs: 60_000 } });
