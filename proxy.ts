// Route gating (Next.js 16 renamed `middleware` → `proxy`; runs on the Node.js
// runtime). Auth.js `auth` acts as the Proxy and applies the `authorized`
// callback in auth.ts: unauthenticated users are redirected to /login, and
// logged-in users hitting /login bounce to /leads.
export { auth as proxy } from "@/auth";

export const config = {
  // Gate everything except API routes (self-gated via secrets), Next internals,
  // and static assets. Auth endpoints live under /api and stay open.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
