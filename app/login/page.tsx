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
          <div className="font-serif text-3xl font-medium leading-none text-cara-ink">
            CARA
          </div>
          <p className="cara-eyebrow">Clinic CRM</p>
          <p className="pt-2 text-sm text-cara-muted">Sign in to continue.</p>
        </div>
        <LoginForm callbackUrl={callbackUrl ?? "/dashboard"} />
      </div>
    </div>
  );
}
