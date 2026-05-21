import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Doomsday Player",
  description:
    "Stream hotlink-protected videos straight in your browser. Built for iOS Safari and everything else.",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        {/* Avoid leaking our domain as Referer when the page navigates out. */}
        <meta name="referrer" content="no-referrer" />
        <meta name="theme-color" content="#0b0d12" />
      </head>
      <body className={`${inter.variable} antialiased`}>{children}</body>
    </html>
  );
}
