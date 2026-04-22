import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SyncWave",
  description: "Forced alignment: scripts to audio in seconds",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
