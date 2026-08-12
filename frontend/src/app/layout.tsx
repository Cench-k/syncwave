import type { Metadata } from "next";
import "./globals.css";
import { ToastProvider } from "@/components/Toast";

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
    // Browser extensions commonly inject attributes onto <body> before React
    // hydrates (e.g. `ap-style=""`), which React reports as a hydration
    // mismatch we cannot fix from here. Suppressing on <body> covers that one
    // element's attributes only — mismatches inside the app still surface.
    <html lang="ko">
      <body suppressHydrationWarning>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
