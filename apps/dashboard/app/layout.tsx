import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

export const metadata: Metadata = {
  title: "Household Manager",
  description:
    "Private household stock, cart, and purchase operations dashboard.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const body = (
    <html lang="en">
      <body>{children}</body>
    </html>
  );

  if (!publishableKey) return body;

  return <ClerkProvider publishableKey={publishableKey}>{body}</ClerkProvider>;
}
