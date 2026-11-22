import { MusicTabs } from "./tabs";

export const metadata = { title: "Music" };

export default function MusicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 pt-24 sm:px-12">
      <MusicTabs />
      {children}
    </div>
  );
}
