// Vitest provides import.meta.glob at runtime for the *.test.ts files in this
// directory; tsc (run by `npx convex dev`) doesn't know about it. Vite's own
// client types aren't reachable under pnpm's isolated node_modules, so declare
// the one member the tests use.
interface ImportMeta {
  glob(
    patterns: string | string[],
  ): Record<string, () => Promise<unknown>>;
}
