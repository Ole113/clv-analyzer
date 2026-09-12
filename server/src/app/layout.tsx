import type { Metadata } from "next";
import "./globals.css";
import { Footer } from "@/components/footer";
import { ToastProvider } from "@/components/toast";
import { getAppSettings } from "@/lib/app-settings";

export const metadata: Metadata = {
  title: "CLV Analyzer",
  description: "Closing line value tracking for OddsJam and PropProfessor fantasy picks",
};

// No icon package is installed (see the same hand-rolled pattern in components/footer.tsx), so a
// single gear glyph is inlined here rather than pulling in a dependency for one icon.
function SettingsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { themePreference } = await getAppSettings();

  return (
    <html lang="en" data-theme={themePreference === "system" ? undefined : themePreference}>
      <body>
        <ToastProvider>
          <header className="top">
            <div className="header-inner">
              <h1>
                <a href="/" className="brand">
                  <img src="/icon.svg" alt="" width={20} height={20} className="brand-icon" />
                  CLV Analyzer
                </a>
              </h1>
              <nav>
                <a href="/">Overview</a>
                <a href="/bets">Picks</a>
                <a href="/analysis">Analysis</a>
                <a href="/exclusions">Exclusions</a>
              </nav>
              <a href="/settings" className="settings-link" aria-label="Settings" title="Settings">
                <SettingsIcon />
              </a>
            </div>
          </header>
          <div className="header-spacer" aria-hidden="true" />
          <div className="wrap">
            {children}
            <Footer />
          </div>
        </ToastProvider>
      </body>
    </html>
  );
}
