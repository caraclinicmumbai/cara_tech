import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { LoginForm } from "./login-form";
import { ThemeToggle } from "@/components/ThemeToggle";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  // Already signed in → skip the form.
  const session = await auth();
  if (session?.user) redirect("/dashboard");

  const { callbackUrl } = await searchParams;

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-cara-page px-6">
      <div className="absolute right-6 top-6">
        <ThemeToggle />
      </div>
      <div className="cara-card w-full max-w-sm space-y-6 p-8">
        <div className="space-y-1">
          <div className="mb-3 flex items-center gap-2">
            <span className="grid h-9 w-9 place-items-center rounded-2xl bg-cara-accent text-base font-bold text-white">
              C
            </span>
            <span className="text-2xl font-bold tracking-tight text-cara-ink">CARA</span>
          </div>
          <p className="cara-eyebrow">Clinic CRM</p>
          <p className="pt-2 text-sm text-cara-muted">Sign in to continue.</p>
        </div>
        <LoginForm callbackUrl={callbackUrl ?? "/dashboard"} />
      </div>
    </div>
  );
}
