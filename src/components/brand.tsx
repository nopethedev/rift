import clsx from "clsx";
import { Ghost, Smile, Rocket, Cat, Bot, Crown, Flame, Gamepad2, Heart, Star, type LucideIcon } from "lucide-react";

export function Logo({ className, size = 28 }: { className?: string; size?: number }) {
  return (
    <span className={clsx("inline-flex items-center gap-2 font-extrabold tracking-tight", className)}>
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
        <defs>
          <linearGradient id="rg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#8B5CF6" />
            <stop offset="1" stopColor="#6D28D9" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="9" fill="url(#rg)" />
        <path d="M11 8h6.5a5 5 0 0 1 1.8 9.66L22 24h-3.6l-2.4-5.5H14V24h-3V8Zm3 3v4.5h3.4a2.25 2.25 0 0 0 0-4.5H14Z" fill="#fff" />
        <path d="M9 26 25 6" stroke="#0B0B12" strokeWidth="1.6" strokeLinecap="round" opacity=".55" />
      </svg>
      <span className="text-xl">Rift</span>
    </span>
  );
}

const ICONS: Record<string, LucideIcon> = { smile: Smile, ghost: Ghost, rocket: Rocket, cat: Cat, bot: Bot, crown: Crown, flame: Flame, gamepad: Gamepad2, heart: Heart, star: Star };
const COLORS: Record<string, string> = {
  violet: "from-violet-500 to-violet-800",
  rose: "from-rose-400 to-rose-700",
  amber: "from-amber-400 to-amber-700",
  emerald: "from-emerald-400 to-emerald-700",
  sky: "from-sky-400 to-sky-700",
  fuchsia: "from-fuchsia-400 to-fuchsia-700",
  orange: "from-orange-400 to-orange-700",
  teal: "from-teal-400 to-teal-700",
};

export function Avatar({ avatar, size = 96, className }: { avatar: string; size?: number; className?: string }) {
  const [icon, color] = avatar.split(":");
  const Icon = ICONS[icon] ?? Smile;
  return (
    <span
      className={clsx("inline-flex shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-lg", COLORS[color] ?? COLORS.violet, className)}
      style={{ width: size, height: size }}
    >
      <Icon style={{ width: size * 0.55, height: size * 0.55 }} strokeWidth={1.75} />
    </span>
  );
}
