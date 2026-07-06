import type { Action, Stagehand } from "@browserbasehq/stagehand";

/**
 * Stagehand v3's click handler passes `arguments[0]` straight into
 * `locator.click({ button })`, so an observe() that stuffs text into a click
 * action's arguments (which the LLM does regularly) crashes with CDP's
 * "Invalid mouse button". Keep arguments on click-like actions only when they
 * name a real mouse button.
 */
const CLICK_METHODS = new Set(["click", "doubleClick"]);
const MOUSE_BUTTONS = new Set(["left", "right", "middle"]);

function sanitize(action: Action): Action {
  if (
    CLICK_METHODS.has(action.method ?? "") &&
    action.arguments?.length &&
    !MOUSE_BUTTONS.has(action.arguments[0]!)
  ) {
    return { ...action, arguments: [] };
  }
  return action;
}

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
  const result = await stagehand.act(
    typeof action === "string" ? (action as unknown as Action) : sanitize(action),
  );
  if (!result.success) {
    const description =
      typeof action === "string" ? action : (action.description ?? "action");
    throw new Error(`act() failed for "${description}": ${result.message}`);
  }
}
