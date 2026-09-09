import {
  DEFAULT_CHECKBOX_COLOR,
  loadSettings,
  saveSettings,
  type ExtensionSettings,
} from "../content/shared/config";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const backendUrl = $<HTMLInputElement>("backendUrl");
const apiKey = $<HTMLInputElement>("apiKey");
const deviceLabel = $<HTMLInputElement>("deviceLabel");
const checkboxColor = $<HTMLInputElement>("checkboxColor");
const status = $<HTMLSpanElement>("status");

function setStatus(text: string, tone: "ok" | "bad" | "muted" = "muted"): void {
  status.textContent = text;
  status.className = tone;
}

function formValues(): ExtensionSettings {
  return {
    backendUrl: backendUrl.value.trim(),
    apiKey: apiKey.value.trim(),
    deviceLabel: deviceLabel.value.trim(),
    checkboxColor: checkboxColor.value || DEFAULT_CHECKBOX_COLOR,
  };
}

function paintPreview(color: string): void {
  document.documentElement.style.setProperty("--pv", color);
}

function originPattern(url: string): string | null {
  try {
    return new URL(url).origin + "/*";
  } catch {
    return null;
  }
}

void (async () => {
  const settings = await loadSettings();
  backendUrl.value = settings.backendUrl;
  apiKey.value = settings.apiKey;
  deviceLabel.value = settings.deviceLabel;
  checkboxColor.value = settings.checkboxColor || DEFAULT_CHECKBOX_COLOR;
  paintPreview(checkboxColor.value);
  if (settings.backendUrl) setStatus("Loaded saved settings");
})();

checkboxColor.addEventListener("input", () => paintPreview(checkboxColor.value));

$("resetColor").addEventListener("click", () => {
  checkboxColor.value = DEFAULT_CHECKBOX_COLOR;
  paintPreview(DEFAULT_CHECKBOX_COLOR);
});

$("save").addEventListener("click", async () => {
  const values = formValues();
  if (!values.backendUrl) {
    setStatus("Backend URL is required", "bad");
    return;
  }
  const origin = originPattern(values.backendUrl);
  if (!origin) {
    setStatus("That does not look like a valid URL", "bad");
    return;
  }

  // Ask for host access first, while the click gesture is still live. Whatever Chrome answers,
  // the settings are saved either way -- otherwise a dismissed prompt silently loses them and the
  // failure only shows up later as "no backend URL set".
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [origin] });
  } catch {
    granted = false;
  }

  await saveSettings(values);

  if (granted) {
    setStatus("Saved", "ok");
  } else {
    setStatus(
      `Saved, but Chrome has not granted access to ${origin} — captures will fail until it does. ` +
        `Click Save again to retry the prompt.`,
      "bad"
    );
  }
});

$("test").addEventListener("click", async () => {
  const values = formValues();
  if (!values.backendUrl) {
    setStatus("Enter a backend URL first", "bad");
    return;
  }
  setStatus("Testing...");
  // Tests exactly what is on screen, so it works before (and independently of) saving.
  const response = await chrome.runtime.sendMessage({
    type: "clv:test-connection",
    backendUrl: values.backendUrl,
    apiKey: values.apiKey,
  });

  if (response?.ok) {
    const origin = originPattern(values.backendUrl);
    const saved = await loadSettings();
    const persisted = saved.backendUrl === values.backendUrl && saved.apiKey === values.apiKey;
    // A reachable server is a success, so it always reads green -- including on a first connect
    // with 0 picks stored and nothing saved yet. The unsaved hint rides along as text rather than
    // recolouring the whole line red, which made a working connection look broken.
    setStatus(
      `Connected — ${response.body?.bets ?? 0} picks stored` +
        (persisted ? "" : " (press Save to keep these settings)"),
      "ok"
    );
    void origin;
  } else {
    setStatus(`Failed: ${response?.error ?? response?.status ?? "unreachable"}`, "bad");
  }
});
