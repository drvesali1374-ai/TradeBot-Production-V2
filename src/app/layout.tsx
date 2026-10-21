import type { Metadata, Viewport } from "next";
import "./globals.css";
import "@phosphor-icons/web/regular";
import "@phosphor-icons/web/fill";
import "@phosphor-icons/web/bold";

export const metadata: Metadata = {
  title: "تریدبات | پلتفرم معاملات خودکار",
  description:
    "پلتفرم معاملات خودکار رمزارز با استراتژی Fake Breakout روی صرافی توبیت — نسخه جدید ماژولار",
  keywords: ["TradeBot", "Toobit", "معاملات خودکار", "ربات ترید", "Fake Breakout"],
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f6fb" },
    { media: "(prefers-color-scheme: dark)", color: "#060a12" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fa" dir="rtl" suppressHydrationWarning>
      <head>
        {/* Vazirmatn is self-hosted (public/fonts + @font-face in globals.css) —
            no CDN request, mission §5 (offline / Iran-safe). */}
        {/* theme applied before paint to avoid flash */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('tb-theme');if(!t){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','light');}})();`,
          }}
        />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
