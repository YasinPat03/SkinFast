import type { Metadata } from "next";
import { GeistPixelSquare } from "geist/font/pixel";
import Link from "next/link";
import LiquidChrome from "@/components/liquid-chrome";
import "./globals.css";

export const metadata: Metadata = {
  title: "SkinFast — CS2 Skin Prices & Tradeup Calculator",
  description: "Search CS2 skin prices and find the best tradeup contracts",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${GeistPixelSquare.className} h-full antialiased dark`}
    >
      <body className="min-h-full bg-zinc-950 text-zinc-100">
        <div className="fixed inset-0 -z-10">
          <LiquidChrome
            color="#C0C0C0"
            color2="#4A4A4A"
            speed={0.35}
            timeScale={0.225}
          />
        </div>
        <header className="fixed top-0 left-0 right-0 z-50 border-b border-zinc-800/50 bg-zinc-950/60 backdrop-blur-md px-4 py-3">
          <div className="max-w-5xl mx-auto flex items-center justify-between">
            <Link href="/" className="text-lg font-bold text-white hover:text-zinc-300 transition-colors">
              SkinFast
            </Link>
            <nav className="flex items-center gap-4 text-sm">
              <Link href="/tradeups" className="text-zinc-400 hover:text-white transition-colors">
                Best Tradeups
              </Link>
              <span className="hidden sm:inline text-zinc-600">
                CS2 Prices & Tradeups
              </span>
            </nav>
          </div>
        </header>
        <main className="flex-1 flex flex-col pt-12 pb-10">{children}</main>
        <footer className="fixed bottom-0 left-0 right-0 z-50 border-t border-zinc-800/50 bg-zinc-950/60 backdrop-blur-md px-4 py-4 text-center text-xs text-zinc-600">
          Prices from Steam Community Market. Not affiliated with Valve.
        </footer>
      </body>
    </html>
  );
}
