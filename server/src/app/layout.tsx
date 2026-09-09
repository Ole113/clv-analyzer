import type { Metadata } from "next";
import "./globals.css";
import { Footer } from "@/components/footer";

export const metadata: Metadata = {
  title: "CLV Analyzer",
  description: "Closing line value tracking for OddsJam and PropProfessor fantasy picks",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="wrap">
          <header className="top">
            <h1>CLV Analyzer</h1>
            <nav>
              <a href="/">Overview</a>
              <a href="/bets">Picks</a>
              <a href="/analysis">Analysis</a>
              <a href="/settings">Settings</a>
            </nav>
          </header>
          {children}
          <Footer />
        </div>
      </body>
    </html>
  );
}
