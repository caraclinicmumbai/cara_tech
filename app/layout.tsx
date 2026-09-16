import type { Metadata } from "next";
import { Playfair_Display, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

// TWO families, and only two. Plus Jakarta Sans carries the entire interface;
// Playfair Display is reserved for the logotype and display headings, where its
// Didone heritage pairs with the mark. Inter and Cormorant Garamond were dropped
// — four families on one screen is three too many, and every extra face is
// another render-blocking request for no gain a reader could name.
const jakarta = Plus_Jakarta_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const playfair = Playfair_Display({
  variable: "--font-serif",
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
      className={`${jakarta.variable} ${playfair.variable} h-full antialiased`}
    >
      <head>
        {/* Apply the saved (or system) theme before paint, to avoid a flash. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('cara-theme');if(t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark');}}catch(e){}})();`,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
