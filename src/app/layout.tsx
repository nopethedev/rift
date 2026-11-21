import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Rift", template: "%s · Rift" },
  description: "Your media. Your server. Your rules.",
};

export const viewport: Viewport = { themeColor: "#0B0B12", colorScheme: "dark" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-bg text-white">{children}</body>
    </html>
  );
}
