import { DEFAULT_KELLY_BOARDS, DEFAULT_KELLY_MULTIPLIER } from "@clv/shared";
import type { KellySettingsMessage, KellySettingsResponse } from "./messages";

/**
 * The Kelly numbers, which live on the server.
 *
 * They are edited on the dashboard's Settings page rather than in the extension's options, so that
 * the bankroll is one number whichever browser is asking -- a bankroll that is 5000 on the desktop
 * and 2000 on the laptop is not a bankroll, it is two wrong answers.
 *
 * The board is never blocked on that, though. Reads fall back, in order, to the last good answer
 * (cached in `chrome.storage.local`, so it survives the worker being suspended) and then to the
 * built-in defaults. A server that is off costs a stale bankroll, not a missing button.
 */

export interface KellySettings {
  /** In dollars. 0 means "not set yet". */
  bankroll: number;
  kellyMultiplier: number;
  /** In dollars. 0 means 1% of bankroll. */
  unitSize: number;
  /** OddsJam board slugs that get the Kelly button. */
  kellyBoards: string[];
}

export const DEFAULT_KELLY_SETTINGS: KellySettings = {
  bankroll: 0,
  kellyMultiplier: DEFAULT_KELLY_MULTIPLIER,
  unitSize: 0,
  kellyBoards: [...DEFAULT_KELLY_BOARDS],
};

const CACHE_KEY = "kellySettingsCache";

/** Anything off the wire or out of the cache is checked field by field before it is trusted. */
export function coerce(raw: unknown): KellySettings | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<Record<keyof KellySettings, unknown>>;
  const number = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
  const boards = Array.isArray(value.kellyBoards)
    ? value.kellyBoards.filter((b): b is string => typeof b === "string" && b.trim().length > 0)
    : [];
  return {
    bankroll: number(value.bankroll, 0),
    kellyMultiplier: number(value.kellyMultiplier, DEFAULT_KELLY_MULTIPLIER) || DEFAULT_KELLY_MULTIPLIER,
    unitSize: number(value.unitSize, 0),
    kellyBoards: boards.length > 0 ? boards : [...DEFAULT_KELLY_BOARDS],
  };
}

async function cached(): Promise<KellySettings | null> {
  try {
    const stored = await chrome.storage.local.get(CACHE_KEY);
    return coerce(stored[CACHE_KEY]);
  } catch {
    return null;
  }
}

async function remember(settings: KellySettings): Promise<void> {
  try {
    await chrome.storage.local.set({ [CACHE_KEY]: settings });
  } catch {
    // A cache that cannot be written just means the next read goes to the server again.
  }
}

/**
 * Current settings, preferring the server and degrading quietly.
 *
 * Returns the cache immediately if the round trip fails, so this is safe to call on the injection
 * cadence -- the button's gate asks on every pass.
 */
export async function kellySettings(): Promise<KellySettings> {
  let response: KellySettingsResponse | undefined;
  try {
    response = await chrome.runtime.sendMessage({
      type: "clv:kelly-settings",
    } satisfies KellySettingsMessage);
  } catch {
    response = undefined;
  }

  const fresh = response?.ok ? coerce(response.kelly) : null;
  if (fresh) {
    void remember(fresh);
    return fresh;
  }
  return (await cached()) ?? DEFAULT_KELLY_SETTINGS;
}

/** Writes the three numbers back, for the modal's "Save as defaults". */
export async function saveKellySettings(
  settings: Pick<KellySettings, "bankroll" | "kellyMultiplier" | "unitSize">
): Promise<{ ok: boolean; error?: string }> {
  let response: KellySettingsResponse | undefined;
  try {
    response = await chrome.runtime.sendMessage({
      type: "clv:kelly-settings",
      save: settings,
    } satisfies KellySettingsMessage);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "the extension could not be reached" };
  }
  if (!response?.ok) return { ok: false, error: response?.error ?? "save failed" };
  const saved = coerce(response.kelly);
  if (saved) void remember(saved);
  return { ok: true };
}
