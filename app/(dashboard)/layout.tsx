import Link from "next/link";
import type { ReactNode } from "react";
import { auth, signOut } from "@/auth";

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await auth();

  return (
    <div className="min-h-screen">
      <header className="border-b border-black/10 dark:border-white/15">
        <nav className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-4">
          <span className="font-semibold">Cara Clinic</span>
          <Link href="/dashboard" className="text-sm hover:underline">
            Dashboard
          </Link>
          <Link href="/leads" className="text-sm hover:underline">
            Leads
          </Link>
          <Link href="/leads/walk-in" className="text-sm hover:underline">
            Walk-in
          </Link>
          <Link href="/calls" className="text-sm hover:underline">
            Calls
          </Link>
          <Link href="/cqs" className="text-sm hover:underline">
            CQS
          </Link>
          <Link href="/templates" className="text-sm hover:underline">
            Templates
          </Link>
          <Link href="/leads/deleted" className="text-sm hover:underline">
            Deleted
          </Link>
          <Link href="/settings" className="text-sm hover:underline">
            Settings
          </Link>
          <div className="ml-auto flex items-center gap-3 text-sm">
            {session?.user?.email && (
              <span className="text-black/60 dark:text-white/60">
                {session.user.email}
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
