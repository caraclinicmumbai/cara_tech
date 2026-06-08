import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { LoginForm } from "./login-form";

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
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm space-y-6 rounded-lg border border-black/10 p-8 dark:border-white/15">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Cara Clinic</h1>
          <p className="text-sm text-black/60 dark:text-white/60">
            Sign in to continue.
          </p>
        </div>
        <LoginForm callbackUrl={callbackUrl ?? "/dashboard"} />
      </div>
    </div>
  );
}
