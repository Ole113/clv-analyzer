import type { Metadata } from "next";
import "./globals.css";
import { Footer } from "@/components/footer";
import { ToastProvider } from "@/components/toast";

export const metadata: Metadata = {
  title: "CLV Analyzer",
  description: "Closing line value tracking for OddsJam and PropProfessor fantasy picks",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
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
                <a href="/settings">Settings</a>
              </nav>
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
