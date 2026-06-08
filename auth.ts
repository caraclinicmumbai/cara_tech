// NextAuth.js / Auth.js v5 config. (Guide §2.5)
// Credentials login backed by the Prisma User model. `role` (sales | admin)
// is carried on the session for role-based access. Uses JWT sessions
// (required by the Credentials provider).
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/lib/password";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: "jwt" },
  trustHost: true,
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = credentials?.email as string | undefined;
        const password = credentials?.password as string | undefined;
        if (!email || !password) return null;

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user?.passwordHash) return null;
        if (!verifyPassword(password, user.passwordHash)) return null;

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
        if (isLoggedIn) return Response.redirect(new URL("/leads", nextUrl));
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
