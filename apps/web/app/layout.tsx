import type { Metadata } from "next";
import { Syne, DM_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const syne = Syne({
  subsets: ["latin"],
  weight: ["400", "600", "700", "800"],
  variable: "--font-display",
  display: "swap",
});

const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-body",
  display: "swap",
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-mono",
  display: "swap",
});

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
    <html
      lang="en"
      className={`h-full dark ${syne.variable} ${dmSans.variable} ${jetBrainsMono.variable}`}
    >
      <body className="min-h-full bg-surf font-body text-wht antialiased">
        {children}
      </body>
    </html>
  );
}
