import { describe, expect, it, vi } from "vitest";

import { runE2EBeforeSessionSetup } from "./e2e/helpers/e2e-before-session.js";

describe("desktop e2e beforeSession setup", () => {
  it("waits for async HOME reset before resolving the hook setup", async () => {
    const events: string[] = [];
    let finishReset: (() => void) | null = null;
    const resetHome = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          events.push("reset-started");
          finishReset = () => {
            events.push("reset-finished");
            resolve();
          };
        }),
    );
    const setupPromise = runE2EBeforeSessionSetup({
      cid: "0-0",
      specs: ["./test/e2e/example.test.ts"],
      configureAgentServerEnv: () => events.push("configure-env"),
      recordBeforeSession: () => events.push("record-before-session"),
      resetHome,
      startUpstreamHttpIfNeeded: async () => {
        events.push("upstream-http");
      },
      startPluginCdnZipFixtureIfNeeded: async () => {
        events.push("plugin-cdn");
      },
    }).then(() => {
      events.push("setup-resolved");
    });

    await waitForResetStarted(resetHome);

    expect(events).toEqual([
      "record-before-session",
      "configure-env",
      "upstream-http",
      "plugin-cdn",
      "reset-started",
    ]);
    expect(resetHome).toHaveBeenCalledWith(["./test/e2e/example.test.ts"]);

    finishReset?.();
    await setupPromise;

    expect(events.at(-2)).toBe("reset-finished");
    expect(events.at(-1)).toBe("setup-resolved");
  });
});

async function waitForResetStarted(resetHome: ReturnType<typeof vi.fn>) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (resetHome.mock.calls.length > 0) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("resetHome was not called");
}
