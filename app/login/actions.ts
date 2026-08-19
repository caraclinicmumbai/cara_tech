"use server";

import { AuthError } from "next-auth";
import { signIn } from "@/auth";
import { prisma } from "@/lib/prisma";
import { landingPath } from "@/lib/rbac";
import { ensurePermissions } from "@/lib/permissions";

/// Where to send this login. Previously every sign-in went to /dashboard and the route
/// guard bounced whoever couldn't see it — which works, but leaves the browser's URL bar
/// showing /dashboard while the redirected page renders (the guard's redirect happens
/// inside the Server Action's soft navigation). Resolving the role's real landing page up
/// front removes the double-redirect entirely.
///
/// This runs BEFORE credentials are verified, so it must not reveal anything: it only
/// picks a redirect target, and an unknown email falls through to the default. A wrong
/// password still fails at `signIn` below and never redirects at all.
async function resolveLanding(email: unknown): Promise<string> {
  if (typeof email !== "string" || !email) return landingPath(undefined);
  const user = await prisma.user.findUnique({
    where: { email },
    select: { role: true },
  });
  await ensurePermissions(); // landingPath consults the effective (admin-overridden) matrix
  return landingPath(user?.role);
}

// Credentials sign-in via Server Action. On success `signIn` throws a redirect
// (NEXT_REDIRECT) which must propagate; only AuthError is surfaced to the form.
export async function authenticate(
  _prevState: string | undefined,
  formData: FormData,
): Promise<string | undefined> {
  const email = formData.get("email");
  // An explicit callbackUrl (they were bounced here from a deep link) wins; otherwise
  // send them to the landing page their role can actually reach.
  const requested = (formData.get("callbackUrl") as string) || "";
  const redirectTo = requested || (await resolveLanding(email));

  try {
    await signIn("credentials", {
      email,
      password: formData.get("password"),
      redirectTo,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return "Invalid email or password.";
    }
    throw error;
  }
}
