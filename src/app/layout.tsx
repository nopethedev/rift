import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SpatialNav } from "@/components/spatial-nav";
import { Pwa } from "@/components/pwa";

// Every page is per-user / database-backed: never prerender at build time (the DB does not exist in the image build).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "Rift", template: "%s · Rift" },
  description: "Your media. Your server. Your rules.",
  applicationName: "Rift",
  appleWebApp: { capable: true, title: "Rift", statusBarStyle: "black" },
  formatDetection: { telephone: false },
};

// viewport-fit=cover lets the layout use the whole screen on notched phones (the bars add safe-area padding themselves).
export const viewport: Viewport = { themeColor: "#0B0B12", colorScheme: "dark", viewportFit: "cover" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-bg text-white">
        <SpatialNav />
        <Pwa />
        {children}
      </body>
    </html>
  );
}
