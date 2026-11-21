import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SpatialNav } from "@/components/spatial-nav";

// Every page is per-user / database-backed: never prerender at build time (the DB does not exist in the image build).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "Rift", template: "%s · Rift" },
  description: "Your media. Your server. Your rules.",
};

export const viewport: Viewport = { themeColor: "#0B0B12", colorScheme: "dark" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-bg text-white">
        <SpatialNav />
        {children}
      </body>
    </html>
  );
}
