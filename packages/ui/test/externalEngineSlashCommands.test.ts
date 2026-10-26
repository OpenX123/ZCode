// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SlashCommandsProvider, useSlashCommands } from "@/hooks/useSlashCommands.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

afterEach(cleanup);
it("外部引擎空目录不回退到 ZCode，更新目录原样保留命令和 hint", () => {
  const workspace = "/external-slash";
  useZCodeSessionStore
    .getState()
    .setSlashCommands(workspace, [{ name: "goal", description: "ZCode goal" }]);
  const engineCommands = [
    { name: "compact", description: "Engine compact", inputHint: "instructions" },
  ];
  const empty = renderHook(() => useSlashCommands(workspace), {
    wrapper: ({ children }) => createElement(SlashCommandsProvider, { commands: [], children }),
  });
  expect(empty.result.current).toEqual([]);
  empty.unmount();
  const engine = renderHook(() => useSlashCommands(workspace), {
    wrapper: ({ children }) =>
      createElement(SlashCommandsProvider, { commands: engineCommands, children }),
  });
  expect(engine.result.current).toEqual(engineCommands);
  engine.unmount();
  const builtin = renderHook(() => useSlashCommands(workspace));
  expect(builtin.result.current?.map((command) => command.name)).toEqual(["goal"]);
});
