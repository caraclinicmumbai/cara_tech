import type { Metadata } from "next";
import { Cormorant_Garamond, Inter, Playfair_Display, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

// CARA editorial type system: Cormorant Garamond (serif headings) + Inter (sans body).
const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const cormorant = Cormorant_Garamond({
  variable: "--font-serif",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

// enori type system (pilot): Plus Jakarta Sans for the interface, Playfair
// Display for display headings — the deck pairs it with the Didone heritage of
// the logotype. Loaded alongside the CARA faces rather than replacing them, so
// the brand toggle can switch between the two without a reload.
const jakarta = Plus_Jakarta_Sans({
  variable: "--font-enori-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const playfair = Playfair_Display({
  variable: "--font-enori-display",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

export const metadata: Metadata = {
  title: "CARA Clinic",
  description: "CARA Hair Transplant & Aesthetic Clinic — Sales CRM",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${cormorant.variable} ${jakarta.variable} ${playfair.variable} h-full antialiased`}
    >
      <head>
        {/* Apply the saved (or system) theme, and the saved brand, before paint
            to avoid a flash of the other design. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('cara-theme');if(t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark');}if(localStorage.getItem('cara-brand')==='enori'){document.documentElement.classList.add('enori');}}catch(e){}})();`,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
