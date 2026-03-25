import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

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
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}
    >
      <body className="min-h-full flex flex-col bg-zinc-950 text-zinc-100">
        <header className="border-b border-zinc-800 px-4 py-3">
          <div className="max-w-5xl mx-auto flex items-center justify-between">
            <Link href="/" className="text-lg font-bold text-white hover:text-zinc-300 transition-colors">
              SkinFast
            </Link>
            <nav className="text-sm text-zinc-400">
              CS2 Prices & Tradeups
            </nav>
          </div>
        </header>
        <main className="flex-1 flex flex-col">{children}</main>
        <footer className="border-t border-zinc-800 px-4 py-4 text-center text-xs text-zinc-600">
          Prices from Steam Community Market. Not affiliated with Valve.
        </footer>
      </body>
    </html>
  );
}
