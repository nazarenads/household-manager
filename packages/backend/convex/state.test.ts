import { describe, expect, test } from "vitest";
import { assertCartTransition, assertJobTransition } from "./lib/state";

describe("job state machine", () => {
  test("allows the happy purchase path", () => {
    expect(() => assertJobTransition("queued", "running")).not.toThrow();
    expect(() =>
      assertJobTransition("running", "awaiting_confirm"),
    ).not.toThrow();
    expect(() =>
      assertJobTransition("awaiting_confirm", "confirmed"),
    ).not.toThrow();
    expect(() => assertJobTransition("confirmed", "confirming")).not.toThrow();
    expect(() => assertJobTransition("confirming", "done")).not.toThrow();
  });

  test("confirming can only end done or needs_reconciliation (D13)", () => {
    expect(() =>
      assertJobTransition("confirming", "needs_reconciliation"),
    ).not.toThrow();
    expect(() => assertJobTransition("confirming", "queued")).toThrow();
    expect(() => assertJobTransition("confirming", "failed")).toThrow();
    expect(() => assertJobTransition("confirming", "running")).toThrow();
  });

  test("done is terminal", () => {
    expect(() => assertJobTransition("done", "queued")).toThrow();
    expect(() => assertJobTransition("done", "failed")).toThrow();
  });

  test("cannot skip the human confirmation gate", () => {
    expect(() => assertJobTransition("running", "confirmed")).toThrow();
    expect(() => assertJobTransition("running", "confirming")).toThrow();
    expect(() => assertJobTransition("queued", "confirming")).toThrow();
    expect(() =>
      assertJobTransition("awaiting_confirm", "confirming"),
    ).toThrow();
  });

  test("pauses resume into the right states", () => {
    expect(() =>
      assertJobTransition("paused_captcha", "running"),
    ).not.toThrow();
    expect(() => assertJobTransition("paused_limit", "queued")).not.toThrow();
    expect(() => assertJobTransition("paused_captcha", "queued")).toThrow();
  });
});

describe("cart state machine", () => {
  test("allows the happy path", () => {
    expect(() => assertCartTransition("proposed", "approved")).not.toThrow();
    expect(() => assertCartTransition("approved", "executing")).not.toThrow();
    expect(() =>
      assertCartTransition("executing", "awaiting_confirm"),
    ).not.toThrow();
    expect(() =>
      assertCartTransition("awaiting_confirm", "completed"),
    ).not.toThrow();
  });

  test("completed is terminal; expiry returns to approved", () => {
    expect(() => assertCartTransition("completed", "approved")).toThrow();
    expect(() =>
      assertCartTransition("awaiting_confirm", "approved"),
    ).not.toThrow();
  });
});
