"use server";

import { AuthError } from "next-auth";
import { signIn } from "@/auth";

// Credentials sign-in via Server Action. On success `signIn` throws a redirect
// (NEXT_REDIRECT) which must propagate; only AuthError is surfaced to the form.
export async function authenticate(
  _prevState: string | undefined,
  formData: FormData,
): Promise<string | undefined> {
  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirectTo: (formData.get("callbackUrl") as string) || "/leads",
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return "Invalid email or password.";
    }
    throw error;
  }
}
