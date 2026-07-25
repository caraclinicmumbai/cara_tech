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
import { can, routeCapability } from "@/lib/rbac";
import { ensurePermissions } from "@/lib/permissions";
import { writeAudit } from "@/lib/audit";
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
          await writeAudit({ action: "auth.login.failed", entityType: "auth", actorEmail: email, ip, reason: "rate-limited" });
          return null;
        }

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user?.passwordHash || !verifyPassword(password, user.passwordHash)) {
          await recordLoginFailure(ip);
          await writeAudit({ action: "auth.login.failed", entityType: "auth", actorEmail: email, ip, reason: "invalid credentials" });
          return null;
        }

        await clearLoginFailures(ip);
        await writeAudit({ action: "auth.login", entityType: "auth", actorId: user.id, actorEmail: user.email, ip });
        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          salesRepId: user.salesRepId,
        };
      },
    }),
  ],
  callbacks: {
    // Route gating for proxy.ts (Auth.js invokes this when `auth` runs as Proxy).
    // Returning false redirects unauthenticated users to `pages.signIn` (/login)
    // with a callbackUrl; returning a Response performs an explicit redirect.
    async authorized({ auth: session, request: { nextUrl } }) {
      const isLoggedIn = !!session?.user;
      const isOnLogin = nextUrl.pathname === "/login";
      if (isOnLogin) {
        if (isLoggedIn) return Response.redirect(new URL("/leads", nextUrl));
        return true;
      }
      if (!isLoggedIn) return false;
      // RBAC route guard: bounce users who lack the page's capability to /leads
      // (reachable by everyone). Defense-in-depth alongside per-action checks.
      const role = (session!.user as { role?: string }).role;
      const cap = routeCapability(nextUrl.pathname);
      if (cap) {
        await ensurePermissions(); // respect admin overrides on the route matrix
        if (!can(role, cap)) return Response.redirect(new URL("/leads", nextUrl));
      }
      return true;
    },
    jwt({ token, user }) {
      if (user) {
        const u = user as { role?: string; salesRepId?: string | null };
        token.role = u.role ?? "telecaller";
        token.salesRepId = u.salesRepId ?? null;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        const u = session.user as { id?: string; role?: string; salesRepId?: string | null };
        u.id = token.sub; // the User.id (JWT subject)
        u.role = token.role as string;
        u.salesRepId = (token.salesRepId as string | null) ?? null;
      }
      return session;
    },
  },
  events: {
    // Audit logout (§compliance). JWT strategy → the event carries the token.
    async signOut(message) {
      const token = "token" in message ? message.token : null;
      const email = (token as { email?: string | null } | null)?.email ?? null;
      await writeAudit({ action: "auth.logout", entityType: "auth", actorId: token?.sub ?? null, actorEmail: email });
    },
  },
});
