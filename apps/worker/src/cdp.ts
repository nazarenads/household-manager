import WebSocket from "ws";

/**
 * Minimal raw-CDP access to the worker-owned Chrome, independent of
 * Stagehand. Exists for one reason: cross-origin iframes (the payment
 * gateway) are separate CDP targets that page.evaluate() can never reach,
 * but attaching to the iframe's own debugger endpoint can.
 */

export type CdpTarget = {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
};

export async function listCdpTargets(
  cdpEndpoint: string,
): Promise<CdpTarget[]> {
  const response = await fetch(`${cdpEndpoint}/json`);
  if (!response.ok) {
    throw new Error(`CDP target listing failed: HTTP ${response.status}`);
  }
  return (await response.json()) as CdpTarget[];
}

/**
 * Evaluate a self-contained expression inside a target (page or iframe) and
 * return its JSON value. The expression must not reference outer variables —
 * serialize inputs into it.
 */
export function evaluateInCdpTarget(
  webSocketDebuggerUrl: string,
  expression: string,
  timeoutMs = 15000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(webSocketDebuggerUrl, {
      perMessageDeflate: false,
    });
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("CDP evaluate timed out"));
    }, timeoutMs);
    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true },
        }),
      );
    });
    ws.on("message", (data) => {
      const message = JSON.parse(String(data)) as {
        id?: number;
        error?: { message: string };
        result?: { result?: { value?: unknown } };
      };
      if (message.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result?.result?.value);
    });
  });
}
