import Link from "next/link";
import type { ReactNode } from "react";
import { auth, signOut } from "@/auth";
import { can, isRole, ROLE_LABELS } from "@/lib/rbac";
import { ensurePermissions } from "@/lib/permissions";
import { ThemeToggle } from "@/components/ThemeToggle";

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await auth();
  await ensurePermissions(); // warm the effective matrix so nav reflects admin overrides
  const role = (session?.user as { role?: string })?.role;

  const navLink =
    "mx-1 rounded-xl px-3 py-2 text-[13px] text-cara-muted transition-colors hover:bg-cara-surface hover:text-cara-ink";

  return (
    <div className="flex min-h-screen bg-cara-page">
      <aside className="sticky top-0 flex h-screen w-56 shrink-0 flex-col border-r-[0.5px] border-cara-rule bg-cara-tint">
        <div className="border-b-[0.5px] border-cara-rule px-5 py-5">
          <div className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-xl bg-cara-accent text-sm font-bold text-white">
              C
            </span>
            <div>
              <div className="text-lg font-bold leading-none tracking-tight text-cara-ink">
                CARA
              </div>
              <div className="mt-0.5 text-[10px] uppercase tracking-[1.5px] text-cara-muted">
                Clinic CRM
              </div>
            </div>
          </div>
        </div>

        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-3">
          {can(role, "analytics.view") && (
            <Link href="/dashboard" className={navLink}>Dashboard</Link>
          )}
          <Link href="/leads" className={navLink}>Leads</Link>
          {can(role, "leads.walkin") && (
            <Link href="/leads/walk-in" className={navLink}>Walk-in</Link>
          )}
          {can(role, "calls.view") && (
            <Link href="/calls" className={navLink}>Calls</Link>
          )}
          {can(role, "analytics.view") && (
            <Link href="/cqs" className={navLink}>CQS</Link>
          )}
          {can(role, "templates.manage") && (
            <Link href="/templates" className={navLink}>Templates</Link>
          )}
          {can(role, "chatbot.manage") && (
            <Link href="/chatbot" className={navLink}>Chatbot</Link>
          )}
          {can(role, "leads.restore") && (
            <Link href="/leads/deleted" className={navLink}>Deleted</Link>
          )}
          {can(role, "users.manage") && (
            <Link href="/users" className={navLink}>Users</Link>
          )}
          {can(role, "audit.view") && (
            <Link href="/audit" className={navLink}>Audit Log</Link>
          )}
          {can(role, "branches.manage") && (
            <Link href="/branches" className={navLink}>Branches</Link>
          )}
          {can(role, "hierarchy.manage") && (
            <Link href="/hierarchy" className={navLink}>Hierarchy</Link>
          )}
          {can(role, "settings.manage") && (
            <Link href="/settings" className={navLink}>Settings</Link>
          )}
        </nav>

        <div className="space-y-2 border-t-[0.5px] border-cara-rule px-4 py-4 text-sm">
          {session?.user?.email && (
            <div className="text-cara-muted">
              <div className="truncate">{session.user.email}</div>
              {isRole(role) && (
                <span className="cara-badge mt-2">{ROLE_LABELS[role]}</span>
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
        <header className="sticky top-0 z-10 flex items-center justify-end gap-3 border-b-[0.5px] border-cara-rule bg-cara-page/90 px-8 py-3 backdrop-blur">
          <ThemeToggle />
        </header>
        <main className="mx-auto w-full max-w-6xl px-8 py-8">{children}</main>
      </div>
    </div>
  );
}
