import Link from "next/link";
import type { ReactNode } from "react";
import { auth, signOut } from "@/auth";
import { can, isRole, ROLE_LABELS } from "@/lib/rbac";

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await auth();
  const role = (session?.user as { role?: string })?.role;

  const navLink =
    "rounded px-3 py-2 text-sm text-black/70 hover:bg-black/5 dark:text-white/70 dark:hover:bg-white/10";

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-56 shrink-0 flex-col border-r border-black/10 dark:border-white/15">
        <div className="px-4 py-4 text-base font-semibold">Cara Clinic</div>

        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2">
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
          {can(role, "leads.restore") && (
            <Link href="/leads/deleted" className={navLink}>Deleted</Link>
          )}
          {can(role, "users.manage") && (
            <Link href="/users" className={navLink}>Users</Link>
          )}
          {can(role, "settings.manage") && (
            <Link href="/settings" className={navLink}>Settings</Link>
          )}
        </nav>

        <div className="space-y-2 border-t border-black/10 px-4 py-3 text-sm dark:border-white/15">
          {session?.user?.email && (
            <div className="text-black/60 dark:text-white/60">
              <div className="truncate">{session.user.email}</div>
              {isRole(role) && (
                <span className="mt-1 inline-block rounded-full bg-black/5 px-2 py-0.5 text-xs dark:bg-white/10">
                  {ROLE_LABELS[role]}
                </span>
              )}
            </div>
          )}
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/login" });
            }}
          >
            <button type="submit" className="text-black/70 hover:underline dark:text-white/70">
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </div>
    </div>
  );
}
