import type { ReactNode } from "react";
import { auth, signOut } from "@/auth";
import { can, isRole, ROLE_LABELS } from "@/lib/rbac";
import type { SessionUser } from "@/lib/authz";
import { unreadTotal } from "@/lib/whatsappInbox";
import { ensurePermissions } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BrandToggle } from "@/components/BrandToggle";
import { StatusSwitcher } from "@/components/StatusSwitcher";
import { NotificationBell } from "@/components/NotificationBell";
import { SidebarNav, type NavItem, type NavSection } from "@/components/SidebarNav";

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await auth();
  await ensurePermissions(); // warm the effective matrix so nav reflects admin overrides
  const role = (session?.user as { role?: string })?.role;

  // §presence: counsellors (a login linked to a sales-rep identity) get the one-tap
  // status switcher in the header. Pure admins with no rep have no availability.
  const salesRepId = (session?.user as { salesRepId?: string | null })?.salesRepId ?? null;
  const rep = salesRepId
    ? await prisma.salesRep.findUnique({ where: { id: salesRepId }, select: { availability: true } })
    : null;

  // Unread WhatsApp replies for the nav badge (§whatsapp inbox). Server-rendered so
  // the count is right on first paint; the inbox itself polls once open.
  const viewer = session?.user as SessionUser | undefined;
  const waUnread = viewer && can(role, "leads.whatsapp") ? await unreadTotal(viewer) : 0;

  // Capabilities are resolved HERE, on the server, and only the permitted links
  // are handed to the client component. The grouping is by what someone is
  // doing when they reach for it, not by how the features were built.
  const sections: NavSection[] = [
    {
      label: "Desk",
      items: [
        can(role, "analytics.view") && { href: "/dashboard", label: "Dashboard" },
        can(role, "leads.view") && { href: "/leads", label: "Leads" },
        can(role, "leads.walkin") && { href: "/leads/walk-in", label: "Walk-in" },
        can(role, "leads.whatsapp") && { href: "/whatsapp", label: "WhatsApp", badge: waUnread },
        can(role, "quotes.view") && { href: "/quotes", label: "Open Quotes" },
        can(role, "postsales.view") && { href: "/post-sales", label: "Post-Sales" },
      ].filter(Boolean) as NavItem[],
    },
    {
      label: "Analysis",
      items: [
        can(role, "calls.view") && { href: "/calls", label: "Calls" },
        can(role, "analytics.view") && { href: "/cqs", label: "Call quality" },
        can(role, "reports.view") && { href: "/reports", label: "Reports" },
      ].filter(Boolean) as NavItem[],
    },
    {
      label: "Automation",
      items: [
        can(role, "campaigns.manage") && { href: "/campaigns", label: "Campaigns" },
        can(role, "campaigns.winback") && { href: "/win-back", label: "Win-Back" },
        can(role, "templates.manage") && { href: "/templates", label: "Templates" },
        can(role, "chatbot.manage") && { href: "/chatbot", label: "Chatbot" },
      ].filter(Boolean) as NavItem[],
    },
    {
      label: "Administration",
      items: [
        can(role, "users.manage") && { href: "/users", label: "Users" },
        can(role, "branches.manage") && { href: "/branches", label: "Branches" },
        can(role, "hierarchy.manage") && { href: "/hierarchy", label: "Hierarchy" },
        can(role, "audit.view") && { href: "/audit", label: "Audit log" },
        can(role, "leads.restore") && { href: "/leads/deleted", label: "Deleted" },
        can(role, "settings.manage") && { href: "/settings", label: "Settings" },
      ].filter(Boolean) as NavItem[],
    },
  ];

  return (
    <div className="flex min-h-screen bg-cara-page">
      <aside className="cara-sidebar sticky top-0 flex h-screen w-46 shrink-0 flex-col border-r border-cara-rule">
        <div className="cara-sidebar-brand px-4 py-4">
          {/* Two wordmarks, swapped by CSS rather than by state, so the brand
              toggle can't produce a hydration mismatch.

              The product mark stands ALONE. The clinic's name used to sit under
              it, which read as a lockup — and this is sold to clinics that
              compete with each other, so another practice's name on the
              masthead is the one thing the separate brand exists to prevent.
              Tenant context now lives in the account block at the foot, beside
              the person it belongs to. */}
          <div className="brand-cara flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-cara-accent text-xs font-bold text-white">
              C
            </span>
            <div className="text-[15px] font-bold leading-none tracking-tight text-cara-ink">
              CARA
            </div>
          </div>
          <div className="brand-enori items-center gap-2">
            <span className="enori-squircle" aria-hidden>
              e
            </span>
            <div className="enori-wordmark">
              <span className="enori-wordmark-en">en</span>ori
            </div>
          </div>
        </div>

        <SidebarNav sections={sections} />

        <div className="space-y-1.5 border-t border-cara-rule px-4 py-3 text-[12px]">
          {/* Which clinic this account belongs to — tenant context, not
              branding. On a single-clinic install it is constant; it is here so
              that on a multi-clinic one it answers "whose data am I looking
              at?" without anybody mistaking it for the product's name. */}
          <div className="cara-nav-heading">Clinic</div>
          <div className="truncate font-medium text-cara-ink">Cara Clinic</div>
          {session?.user?.email && (
            <div className="text-cara-muted">
              <div className="truncate">{session.user.email}</div>
              {isRole(role) && (
                <span className="cara-badge mt-1.5">{ROLE_LABELS[role]}</span>
              )}
            </div>
          )}
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/login" });
            }}
          >
            <button
              type="submit"
              className="text-cara-muted hover:text-cara-ink hover:underline"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex items-center justify-end gap-2 border-b border-cara-rule bg-cara-page/90 px-6 py-2.5 backdrop-blur">
          {rep && <StatusSwitcher initial={rep.availability} />}
          {/* §handover — a handover reaches its telecaller here, in the software. */}
          <NotificationBell />
          {/* Pilot: lets the business A/B the enori brand on a live screen. */}
          <BrandToggle />
          <ThemeToggle />
        </header>
        <main className="mx-auto w-full max-w-6xl px-6 py-6">{children}</main>
      </div>
    </div>
  );
}
