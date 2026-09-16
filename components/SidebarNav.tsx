"use client";

// The sidebar's navigation (§chrome).
//
// Nineteen links in one undifferentiated column is a list, not a structure —
// nobody reads to the bottom of it, and "Hierarchy" sitting next to "Win-Back"
// tells you nothing about either. They are grouped into four sections by what
// a person is doing when they need them: the daily desk, the read-outs, the
// automation, and the settings you touch once a month.
//
// Client-side only because the active item needs the current path. The server
// still decides WHICH links exist — capabilities are checked there and the
// permitted set is passed down, so nothing here can widen access.
import Link from "next/link";
import { usePathname } from "next/navigation";

export type NavItem = {
  href: string;
  label: string;
  /// Unread count, currently only the WhatsApp inbox.
  badge?: number;
};

export type NavSection = {
  label: string;
  items: NavItem[];
};

/// Longest-match wins, so /leads/walk-in highlights Walk-in rather than Leads.
function activeHref(pathname: string, sections: NavSection[]): string | null {
  const all = sections.flatMap((s) => s.items.map((i) => i.href));
  const matches = all.filter((href) => pathname === href || pathname.startsWith(`${href}/`));
  return matches.sort((a, b) => b.length - a.length)[0] ?? null;
}

export function SidebarNav({ sections }: { sections: NavSection[] }) {
  const pathname = usePathname() ?? "";
  const active = activeHref(pathname, sections);

  return (
    <nav className="flex flex-1 flex-col gap-4 overflow-y-auto px-3 py-4">
      {sections
        .filter((s) => s.items.length > 0)
        .map((section) => (
          <div key={section.label}>
            <div className="cara-nav-heading">{section.label}</div>
            <div className="mt-1 flex flex-col gap-px">
              {section.items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active === item.href ? "page" : undefined}
                  className={`cara-nav-link ${active === item.href ? "is-active" : ""}`}
                >
                  <span className="truncate">{item.label}</span>
                  {item.badge ? (
                    <span className="nav-count">{item.badge > 9 ? "9+" : item.badge}</span>
                  ) : null}
                </Link>
              ))}
            </div>
          </div>
        ))}
    </nav>
  );
}
