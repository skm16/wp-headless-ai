import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "wp-headless-kit pilot",
  description: "Headless WordPress + Next.js, typed SDK driven by the MCP Adapter.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-neutral-50 text-neutral-900 antialiased">
        <main className="mx-auto max-w-5xl px-6 py-12">{children}</main>
      </body>
    </html>
  );
}
