"use client";
// Android stops background apps to save battery: older versions and most phone makers' own systems do it even while
// music is playing. Rift is a web app, so it can't change that setting or open it; this explains where it is.
import { useEffect, useState } from "react";
import { BatteryWarning, ExternalLink, X } from "lucide-react";
import clsx from "clsx";

type Vendor = "samsung" | "xiaomi" | "huawei" | "oneplus" | "vivo" | "other";
const VENDORS: { id: Vendor; label: string; kill: string }[] = [
  { id: "samsung", label: "Samsung", kill: "samsung" },
  { id: "xiaomi", label: "Xiaomi / Redmi / POCO", kill: "xiaomi" },
  { id: "huawei", label: "Huawei / Honor", kill: "huawei" },
  { id: "oneplus", label: "OnePlus / OPPO / realme", kill: "oneplus" },
  { id: "vivo", label: "vivo", kill: "vivo" },
  { id: "other", label: "Pixel / other", kill: "google" },
];

const STEPS: Record<Vendor, string[]> = {
  samsung: [
    "Settings → Battery (or Device care → Battery) → Background usage limits.",
    "Turn off “Put unused apps to sleep”, then open “Never sleeping apps” and add Chrome and Rift.",
  ],
  xiaomi: [
    "Long-press Chrome → App info → Battery saver → No restrictions. Turn on Autostart on the same screen.",
    "Do the same for Rift. In the recent-apps view, pull down on Rift's card to lock it.",
  ],
  huawei: [
    "Settings → Battery → App launch → Chrome: switch to “Manage manually” and allow all three options.",
    "Do the same for Rift.",
  ],
  oneplus: [
    "Long-press Chrome → App info → Battery usage → allow background activity (turn off “Optimise battery use” if it's there).",
    "Do the same for Rift, and lock Rift in the recent-apps view.",
  ],
  vivo: [
    "Settings → Battery → Background power consumption management → Chrome → allow high background power consumption.",
    "Do the same for Rift.",
  ],
  other: [],
};

function guessVendor(model: string): Vendor | null {
  if (/^(SM-|SC-|SCV|SCG)|galaxy/i.test(model)) return "samsung";
  if (/^(M\d{4}|\d{4,5}[A-Z0-9]{3,}|Redmi|POCO|Mi\s|MI\s|Xiaomi)/i.test(model)) return "xiaomi";
  if (/^(HUAWEI|HONOR|ELS|ANA|VOG|LYA|NOH|JNY|MAR|ANY|RMO|NTH|CMA|FNE)/i.test(model)) return "huawei";
  if (/^(ONEPLUS|CPH|NE2|LE2|IN20|KB2|GM19|HD19|RMX|PH[A-Z]\d)/i.test(model)) return "oneplus";
  if (/^(V\d{4}|vivo|I\d{4})/i.test(model)) return "vivo";
  if (/pixel/i.test(model)) return "other";
  return null;
}

export const isAndroid = () => typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
export const BG_TIP_KEY = "rift-bg-playback-tip";

/** Android version (and phone maker, when Chrome tells us the model). */
function useDevice() {
  const [d, setD] = useState<{ android: number | null; vendor: Vendor | null }>({ android: null, vendor: null });
  useEffect(() => {
    const v = /Android (\d+)/.exec(navigator.userAgent);
    const ua = (navigator as Navigator & { userAgentData?: { getHighEntropyValues(h: string[]): Promise<{ model?: string; platformVersion?: string }> } }).userAgentData;
    setD({ android: v ? Number(v[1]) : null, vendor: null });
    // Chrome hides the model from the plain user agent ("Android 10; K"); the client hints still have it.
    ua?.getHighEntropyValues(["model", "platformVersion"]).then((h) => setD({ android: h.platformVersion ? Number(h.platformVersion.split(".")[0]) || (v ? Number(v[1]) : null) : v ? Number(v[1]) : null, vendor: h.model ? guessVendor(h.model) : null })).catch(() => {});
  }, []);
  return d;
}

export function BackgroundPlaybackGuide() {
  const dev = useDevice();
  const [vendor, setVendor] = useState<Vendor | null>(null);
  const v = vendor ?? dev.vendor ?? "other";
  const old = dev.android !== null && dev.android < 12;
  return (
    <div className="space-y-4 text-sm">
      <p className="text-white/80">
        Android closes apps in the background to save battery. On older versions and on most phone makers&apos; systems it does that
        even while music is playing, so the music stops a few minutes after the screen goes off.
      </p>
      <p className="text-white/80">
        The installed Rift app runs inside Chrome, so Chrome needs the setting as well, not only Rift. A website can&apos;t open this
        setting for you, so here is where to find it:
      </p>
      <ol className="list-decimal space-y-2 pl-5 text-white/90">
        {old ? (
          <li>Settings → Apps → Chrome → Battery → Battery optimisation. Switch the list to “All apps”, find Chrome and choose “Don&apos;t optimise”. Do the same for Rift.</li>
        ) : (
          <li>Long-press Chrome → App info → App battery usage (or Battery) → Unrestricted. Do the same for Rift.</li>
        )}
        {STEPS[v].map((s) => <li key={s}>{s}</li>)}
      </ol>
      <div>
        <p className="mb-2 text-xs text-muted">Your phone</p>
        <div className="flex flex-wrap gap-1.5">
          {VENDORS.map((x) => (
            <button key={x.id} type="button" onClick={() => setVendor(x.id)} aria-pressed={v === x.id} className={clsx("rounded-full border px-3 py-1 text-xs", v === x.id ? "border-white bg-white text-black" : "border-white/20 text-white/80 hover:border-white/50")}>{x.label}</button>
          ))}
        </div>
      </div>
      <a href={`https://dontkillmyapp.com/${VENDORS.find((x) => x.id === v)!.kill}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-violet-300 hover:underline">More detail for this phone on dontkillmyapp.com <ExternalLink className="size-3.5" /></a>
    </div>
  );
}

/** One-time note on the music home for Android phones (until dismissed, or done during onboarding). */
export function BackgroundPlaybackTip() {
  const [show, setShow] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => { setShow(isAndroid() && !localStorage.getItem(BG_TIP_KEY)); }, []);
  if (!show) return null;
  const dismiss = () => { localStorage.setItem(BG_TIP_KEY, "dismissed"); setShow(false); };
  return (
    <section aria-label="Background playback" className="mb-6 rounded-xl border border-amber-300/20 bg-amber-300/5 p-4">
      <div className="flex items-start gap-3">
        <BatteryWarning className="mt-0.5 size-5 shrink-0 text-amber-300" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Music stops when the screen is off?</p>
          {!open && <p className="mt-0.5 text-sm text-white/70">Android may be closing Chrome to save battery. <button onClick={() => setOpen(true)} className="font-semibold text-white underline-offset-2 hover:underline">Show me what to change</button></p>}
          {open && <div className="mt-3"><BackgroundPlaybackGuide /></div>}
        </div>
        <button onClick={dismiss} aria-label="Dismiss" className="rounded-full p-1 text-white/50 hover:bg-white/10 hover:text-white"><X className="size-4" /></button>
      </div>
      {open && <div className="mt-3 flex justify-end"><button onClick={() => { localStorage.setItem(BG_TIP_KEY, "done"); setShow(false); }} className="rounded-full bg-white px-4 py-1.5 text-sm font-semibold text-black">Done</button></div>}
    </section>
  );
}
