import { requireProfile } from "@/server/auth";
import { StartScreen } from "./start";

export const metadata = { title: "Finding a source" };
export const dynamic = "force-dynamic";

export default async function StartPage() {
  await requireProfile();
  return <StartScreen />;
}
