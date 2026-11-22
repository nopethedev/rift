import { route } from "@/server/api";
import { resetWorkerStatus, workerStatus } from "@/server/subtitle-ai";

export const dynamic = "force-dynamic";
/** Admin: does the worker have the speech engine, and how busy is it? */
export const GET = route("admin", async () => { resetWorkerStatus(); return workerStatus(); });
