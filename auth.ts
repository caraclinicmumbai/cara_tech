// NextAuth.js / Auth.js v5 config. (Guide §2.5)
// Credentials login backed by the Prisma User model. `role` (sales | admin)
// is carried on the session for role-based access. Uses JWT sessions
// (required by the Credentials provider).
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/lib/password";
import { getClientIp } from "@/lib/rateLimit";
import { isLoginLocked, recordLoginFailure, clearLoginFailures } from "@/lib/loginThrottle";
import { logger } from "@/lib/logger";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  // JWT sessions, capped at 12h so a leaked/stale token can't live for the
  // default 30 days — staff re-auth roughly once a workday.
  session: { strategy: "jwt", maxAge: 60 * 60 * 12 },
  trustHost: true,
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, request) {
        const email = credentials?.email as string | undefined;
        const password = credentials?.password as string | undefined;
        if (!email || !password) return null;

        // Brute-force throttle, keyed by client IP. Locked-out attempts return
        // null (same "invalid" UX) so we don't reveal the lockout to attackers.
        const ip = getClientIp(request);
        const { locked } = await isLoginLocked(ip);
        if (locked) {
          logger.warn(`Login blocked by rate limit for ip=${ip}`);
          return null;
        }

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user?.passwordHash || !verifyPassword(password, user.passwordHash)) {
          await recordLoginFailure(ip);
          return null;
        }

        await clearLoginFailures(ip);
        return { id: user.id, name: user.name, email: user.email, role: user.role };
      },
    }),
  ],
  callbacks: {
    // Route gating for proxy.ts (Auth.js invokes this when `auth` runs as Proxy).
    // Returning false redirects unauthenticated users to `pages.signIn` (/login)
    // with a callbackUrl; returning a Response performs an explicit redirect.
    authorized({ auth: session, request: { nextUrl } }) {
      const isLoggedIn = !!session?.user;
      const isOnLogin = nextUrl.pathname === "/login";
      if (isOnLogin) {
        if (isLoggedIn) return Response.redirect(new URL("/dashboard", nextUrl));
        return true;
      }
      return isLoggedIn;
    },
    jwt({ token, user }) {
      if (user) token.role = (user as { role?: string }).role ?? "sales";
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        (session.user as { role?: string }).role = token.role as string;
      }
      return session;
    },
  },
});
