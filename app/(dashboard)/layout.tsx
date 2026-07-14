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

  return (
    <div className="min-h-screen">
      <header className="border-b border-black/10 dark:border-white/15">
        <nav className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-4">
          <span className="font-semibold">Cara Clinic</span>
          {can(role, "analytics.view") && (
            <Link href="/dashboard" className="text-sm hover:underline">
              Dashboard
            </Link>
          )}
          <Link href="/leads" className="text-sm hover:underline">
            Leads
          </Link>
          {can(role, "leads.walkin") && (
            <Link href="/leads/walk-in" className="text-sm hover:underline">
              Walk-in
            </Link>
          )}
          {can(role, "calls.view") && (
            <Link href="/calls" className="text-sm hover:underline">
              Calls
            </Link>
          )}
          {can(role, "analytics.view") && (
            <Link href="/cqs" className="text-sm hover:underline">
              CQS
            </Link>
          )}
          {can(role, "templates.manage") && (
            <Link href="/templates" className="text-sm hover:underline">
              Templates
            </Link>
          )}
          {can(role, "leads.restore") && (
            <Link href="/leads/deleted" className="text-sm hover:underline">
              Deleted
            </Link>
          )}
          {can(role, "users.manage") && (
            <Link href="/users" className="text-sm hover:underline">
              Users
            </Link>
          )}
          {can(role, "settings.manage") && (
            <Link href="/settings" className="text-sm hover:underline">
              Settings
            </Link>
          )}
          <div className="ml-auto flex items-center gap-3 text-sm">
            {session?.user?.email && (
              <span className="text-black/60 dark:text-white/60">
                {session.user.email}
                {isRole(role) && (
                  <span className="ml-2 rounded-full bg-black/5 px-2 py-0.5 text-xs dark:bg-white/10">
                    {ROLE_LABELS[role]}
                  </span>
                )}
              </span>
            )}
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/login" });
              }}
            >
              <button type="submit" className="hover:underline">
                Sign out
              </button>
            </form>
          </div>
        </nav>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
