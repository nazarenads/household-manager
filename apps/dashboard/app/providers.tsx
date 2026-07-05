"use client";

import { type ReactNode, useMemo } from "react";
import { ConvexProvider, ConvexReactClient } from "convex/react";

export function Providers({ children }: { children: ReactNode }) {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
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

  return <ConvexProvider client={client}>{children}</ConvexProvider>;
}
