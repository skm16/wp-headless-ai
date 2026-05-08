import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jab — WordPress to AI-iterable headless, fast",
  description:
    "Jab generates a typed Next.js project from any WordPress site exposing the MCP Adapter, page by page, with AI assistance.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full bg-slate-50 text-slate-900 antialiased">
        {children}
      </body>
    </html>
  );
}
