import { Suspense } from "react";
import { SearchView } from "./view";
export const dynamic = "force-dynamic";
export default function Page() { return <Suspense><SearchView /></Suspense>; }
