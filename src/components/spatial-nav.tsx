"use client";
import { useEffect } from "react";
import { type Box, type Dir, pickNext } from "@/lib/spatial";

const KEY_DIR: Record<string, Dir> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
/** Remote "back" buttons: generic, Tizen (10009), webOS (461), Android TV (4). */
const BACK_KEY = new Set(["BrowserBack", "GoBack", "XF86Back"]);
const BACK_CODE = new Set([10009, 461]);
const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex], [data-focusable]';
const TV_UA = /SMART-TV|SmartTV|Tizen|Web0S|WebOS|NetCast|VIDAA|HbbTV|BRAVIA|AFTM|AFTT|AFTS|Android TV|GoogleTV|CrKey|Roku|Xbox|PlayStation|Hisense/i;

export const TV_STORAGE_KEY = "rift.tv";
export const isTvMode = () => document.documentElement.classList.contains("tv");
export function setTvMode(on: boolean) {
  document.documentElement.classList.toggle("tv", on);
  try { on ? localStorage.setItem(TV_STORAGE_KEY, "1") : localStorage.removeItem(TV_STORAGE_KEY); } catch { /* private mode */ }
}

const visible = (el: HTMLElement) => {
  if (el.hasAttribute("disabled") || el.closest('[inert], [aria-hidden="true"]')) return false;
  if (el.getAttribute("tabindex") === "-1" && !el.hasAttribute("data-focusable")) return false;
  if (el instanceof HTMLInputElement && el.type === "hidden") return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const s = getComputedStyle(el);
  return s.visibility !== "hidden" && s.display !== "none";
};

const boxOf = (el: Element): Box => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };

function candidates(active: Element | null): HTMLElement[] {
  // An open modal traps navigation.
  const modals = document.querySelectorAll<HTMLElement>('[aria-modal="true"]');
  const scope: ParentNode = modals.length ? modals[modals.length - 1] : document;
  // A floating hover preview is only part of the grid while focus is inside it (cards are reached with Down).
  const inPreview = !!active?.closest("[data-preview]");
  return [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => visible(el) && (inPreview || !el.closest("[data-preview]")));
}

/** Whether the focused element wants this arrow key for itself (text caret, native slider, dropdown…). */
function ownsKey(el: Element | null, dir: Dir): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable) return true;
  if (el instanceof HTMLInputElement) {
    const t = el.type;
    if (t === "range") return dir === "left" || dir === "right";
    if (t === "number") return dir === "up" || dir === "down" || dir === "left" || dir === "right";
    if (["text", "search", "email", "password", "url", "tel"].includes(t)) {
      if (dir === "up" || dir === "down") return false;
      // Let the caret move; hand over once it sits at the edge so you can leave the field.
      const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
      const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
      return dir === "left" ? !atStart : !atEnd;
    }
  }
  return false;
}

function focusEl(el: HTMLElement, dir: Dir | null) {
  el.focus({ preventScroll: true });
  if (el.closest("nav, [data-fixed]")) return; // fixed bars never need scrolling
  el.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  void dir;
}

/** Arrow-key / D-pad navigation for the whole app (TV remotes send arrow keys + Enter). Mounted once in the root layout. */
export function SpatialNav() {
  useEffect(() => {
    // TV browsers get the 10-foot UI automatically; anyone can toggle it from the account menu or with ?tv=1 / ?tv=0.
    const q = new URLSearchParams(location.search).get("tv");
    let stored = false;
    try { stored = localStorage.getItem(TV_STORAGE_KEY) === "1"; } catch { /* ignore */ }
    if (q === "0") setTvMode(false);
    else if (q === "1" || stored || TV_UA.test(navigator.userAgent)) document.documentElement.classList.add("tv");

    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;

      if (BACK_KEY.has(e.key) || BACK_CODE.has(e.keyCode) || (e.key === "Backspace" && isTvMode() && !ownsText(document.activeElement))) {
        e.preventDefault();
        history.back();
        return;
      }

      const active = document.activeElement as HTMLElement | null;
      // Remote "OK" on non-native focusables.
      if ((e.key === "Enter" || e.key === " ") && active?.hasAttribute("data-focusable") && !active.matches("a,button,input,select,textarea,summary")) {
        e.preventDefault();
        active.click();
        return;
      }

      const dir = KEY_DIR[e.key];
      if (!dir || e.shiftKey) return;
      if (ownsKey(active, dir)) return;

      // Hover preview (opens when a card is selected for a moment): Down enters it, Up leaves it back to the card.
      const preview = document.querySelector<HTMLElement>("[data-preview]");
      if (preview) {
        if (dir === "down" && active?.hasAttribute("data-card")) {
          const first = [...preview.querySelectorAll<HTMLElement>(FOCUSABLE)].find(visible);
          if (first) { e.preventDefault(); first.focus({ preventScroll: true }); return; }
        }
        if (dir === "up" && active && preview.contains(active)) {
          const card = document.elementsFromPoint(+preview.dataset.ox!, +preview.dataset.oy!).find((el): el is HTMLElement => el instanceof HTMLElement && el.hasAttribute("data-card"));
          if (card) { e.preventDefault(); card.focus({ preventScroll: true }); return; }
        }
      }

      const list = candidates(active);
      if (!list.length) return;
      const idx = active ? list.indexOf(active) : -1;

      e.preventDefault();
      if (idx < 0) {
        // Nothing (valid) focused yet: start at the page's primary action, else the first thing on screen.
        const start = list.find((el) => el.hasAttribute("data-autofocus")) ?? list.find((el) => el.closest("main") && inView(el)) ?? list.find(inView) ?? list[0];
        focusEl(start, null);
        return;
      }
      const others = list.filter((_, i) => i !== idx);
      const next = pickNext(boxOf(list[idx]), others.map(boxOf), dir);
      if (next >= 0) focusEl(others[next], dir);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return null;
}

const ownsText = (el: Element | null) => !!el && (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit", "range"].includes(el.type)) || (el as HTMLElement).isContentEditable);
const inView = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; };
