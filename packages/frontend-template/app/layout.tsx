import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

import { SiteHeader } from "./components/site-header";
import { SiteFooter } from "./components/site-footer";

export const metadata: Metadata = {
  title: "Two Roads Brewing Company",
  description: "Take the Road Less Traveled. Craft beer, food hall, and events in Stratford, CT.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-white text-neutral-900 antialiased">
        <SiteHeader />
        <main className="min-h-screen">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
