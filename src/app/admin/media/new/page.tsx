import { Suspense } from "react";
import { Wizard } from "./wizard";

export const metadata = { title: "Add media" };

export default function NewMediaPage() {
  return <Suspense><Wizard /></Suspense>;
}
