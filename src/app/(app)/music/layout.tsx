export const metadata = { title: "Music" };

/** The Music chrome (sidebar, top bar) comes from AppChrome; pages only add content. */
export default function MusicLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
