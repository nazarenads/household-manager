"use client";

import { type ReactNode, useMemo } from "react";
import { useAuth } from "@clerk/nextjs";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";

export function Providers({ children }: { children: ReactNode }) {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const clerkEnabled = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  const client = useMemo(
    () => (convexUrl ? new ConvexReactClient(convexUrl) : null),
    [convexUrl],
  );

  if (!client) {
    return (
      <div className="config-missing">
        <h1>Convex is not configured</h1>
        <p>
          Set NEXT_PUBLIC_CONVEX_URL in apps/dashboard/.env.local, then restart
          the dashboard.
        </p>
      </div>
    );
  }

  if (clerkEnabled) {
    return (
      <ConvexProviderWithClerk client={client} useAuth={useAuth}>
        {children}
      </ConvexProviderWithClerk>
    );
  }

  return <ConvexProvider client={client}>{children}</ConvexProvider>;
}
