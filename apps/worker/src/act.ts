import type { Action, Stagehand } from "@browserbasehq/stagehand";

/**
 * Stagehand v3's act() reports failure via `ActResult.success: false` instead
 * of throwing (e.g. a cached selector that no longer matches). Every caller
 * here treats a non-throwing act as executed — replay heal paths and purchase
 * steps would silently skip — so normalize failures back into exceptions.
 */
export async function actOrThrow(
  stagehand: Stagehand,
  action: Action | string,
): Promise<void> {
  const result = await stagehand.act(action as Action);
  if (!result.success) {
    const description =
      typeof action === "string" ? action : (action.description ?? "action");
    throw new Error(`act() failed for "${description}": ${result.message}`);
  }
}
