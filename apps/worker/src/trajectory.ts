import type { Action, Stagehand } from "@browserbasehq/stagehand";
import type { Id } from "@household/backend/convex/_generated/dataModel";
import { actOrThrow } from "./act";
import type { TrajectoryStep, WorkerConvex } from "./convexClient";

export type StepTemplate = {
  /** Stable identity of the step within its flow (not the rendered text). */
  key: string;
  /** Natural-language instruction used to (re)resolve the action via observe(). */
  instruction: string;
  /**
   * Volatile per-run values (quantities, search terms). Cached actions are
   * replayed with these patched in so the cache stays run-independent.
   */
  arguments?: string[];
};

export type FlowRunResult = {
  exploredSteps: number;
  replayedSteps: number;
  healedSteps: number;
};

function stepKeyOf(step: TrajectoryStep) {
  const separator = step.instruction.indexOf("::");
  return separator === -1
    ? step.instruction
    : step.instruction.slice(0, separator);
}

function encodeInstruction(template: StepTemplate) {
  return `${template.key}::${template.instruction}`;
}

/**
 * D1: we own the trajectory cache. Persisted observe() action objects live in
 * Convex and are replayed via act(action) with zero LLM calls. On replay
 * failure the step is re-resolved with a fresh observe(instruction) and the
 * healed action is persisted back.
 */
export class TrajectoryRunner {
  private readonly convex: WorkerConvex;
  private readonly stagehand: Stagehand;
  private readonly storeId: Id<"stores">;

  constructor(args: {
    convex: WorkerConvex;
    stagehand: Stagehand;
    storeId: Id<"stores">;
  }) {
    this.convex = args.convex;
    this.stagehand = args.stagehand;
    this.storeId = args.storeId;
  }

  async runFlow(
    flow: string,
    templates: StepTemplate[],
  ): Promise<FlowRunResult> {
    const cached = await this.convex.getTrajectory(this.storeId, flow);
    // Cached steps are matched positionally by step key; if the template
    // shape changed since the cache was written, explore from scratch.
    const cacheUsable =
      cached !== null &&
      cached.steps.length === templates.length &&
      cached.steps.every(
        (step, index) => stepKeyOf(step) === templates[index]!.key,
      );

    const result: FlowRunResult = {
      exploredSteps: 0,
      replayedSteps: 0,
      healedSteps: 0,
    };
    const nextSteps: TrajectoryStep[] = [];
    let dirty = !cacheUsable;
    let failure: unknown = null;

    for (const [index, template] of templates.entries()) {
      const cachedStep = cacheUsable ? cached!.steps[index]! : undefined;
      try {
        const step = await this.runStep(template, cachedStep, result);
        nextSteps.push(step);
        if (!cachedStep || step.action !== cachedStep.action) dirty = true;
      } catch (error) {
        failure = error;
        break;
      }
    }

    if (dirty && nextSteps.length === templates.length) {
      await this.convex.saveTrajectory(this.storeId, flow, nextSteps);
    }
    if (cached) {
      await this.convex.recordTrajectoryOutcome(cached._id, failure === null);
    }
    if (failure !== null) throw failure;
    return result;
  }

  private async runStep(
    template: StepTemplate,
    cachedStep: TrajectoryStep | undefined,
    result: FlowRunResult,
  ): Promise<TrajectoryStep> {
    if (cachedStep) {
      try {
        await actOrThrow(
          this.stagehand,
          this.withArguments(cachedStep.action as Action, template),
        );
        result.replayedSteps += 1;
        return cachedStep;
      } catch {
        // Fall through to a fresh LLM resolution (manual self-heal).
      }
    }

    const action = await this.resolve(template);
    await actOrThrow(this.stagehand, action);
    if (cachedStep) {
      result.healedSteps += 1;
      return {
        instruction: encodeInstruction(template),
        action,
        last_healed_at: Date.now(),
      };
    }
    result.exploredSteps += 1;
    return { instruction: encodeInstruction(template), action };
  }

  private async resolve(template: StepTemplate): Promise<Action> {
    const candidates = await this.stagehand.observe(template.instruction);
    const action = candidates[0];
    if (!action) {
      throw new Error(`observe() found no action for: ${template.instruction}`);
    }
    return this.withArguments(action, template);
  }

  private withArguments(action: Action, template: StepTemplate): Action {
    if (!template.arguments) return action;
    return { ...action, arguments: template.arguments };
  }
}
