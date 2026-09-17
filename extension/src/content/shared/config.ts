export interface ExtensionSettings {
  backendUrl: string;
  apiKey: string;
  deviceLabel: string;
  /** Colour of the injected checkbox. Green by default so it reads as "tracked". */
  checkboxColor: string;
}

/**
 * The Kelly numbers are deliberately *not* here. They live on the server, in `AppSettings`, and are
 * edited on the dashboard's Settings page -- so the bankroll is one number rather than one per
 * browser profile. See `kellySettings()` in `kelly-settings.ts`.
 */

export const DEFAULT_CHECKBOX_COLOR = "#22c55e";

export const DEFAULT_SETTINGS: ExtensionSettings = {
  backendUrl: "",
  apiKey: "",
  deviceLabel: "",
  checkboxColor: DEFAULT_CHECKBOX_COLOR,
};

export async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored } as ExtensionSettings;
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await chrome.storage.sync.set(settings);
}

/** Trims a trailing slash so URL joining stays predictable. */
export function apiUrl(backendUrl: string, path: string): string {
  return `${backendUrl.replace(/\/+$/, "")}${path}`;
}
