import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Inquisition",
  description: "A tiny tribunal for judging AI claims and roasting hallucinations.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
