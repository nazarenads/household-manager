import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

// Local anonymous development runs without Clerk keys; the dashboard then
// talks to Convex unauthenticated (see app/providers.tsx). With keys set,
// Clerk's middleware handles the session handshake for every request.
const handler = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
  ? clerkMiddleware()
  : () => NextResponse.next();

export default handler;

export const config = {
  matcher: [
    // Everything except Next.js internals and static assets
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
};
