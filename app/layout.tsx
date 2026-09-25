import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: "גיבנק — בנק שאלות למבחנים",
  description: "חיפוש חכם במבחנים, רמזים והתקדמות אישית לסטודנטים באוניברסיטה העברית.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="he" dir="rtl" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Frank+Ruhl+Libre:wght@700;900&family=Heebo:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body suppressHydrationWarning>
        {children}
        <Script id="theme-initializer" strategy="beforeInteractive">
          {`try{const saved=localStorage.getItem("gbank-theme");const theme=saved==="dark"||saved!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme}catch{}`}
        </Script>
        <Script id="mathjax-config" strategy="beforeInteractive">
          {`window.MathJax={tex:{inlineMath:[[\"$\",\"$\"]],displayMath:[[\"$$\",\"$$\"]]},svg:{fontCache:\"global\"},startup:{typeset:false}};`}
        </Script>
        <Script
          src="https://cdnjs.cloudflare.com/ajax/libs/mathjax/3.2.2/es5/tex-svg.min.js"
          strategy="afterInteractive"
        />
      </body>
    </html>
  );
}
