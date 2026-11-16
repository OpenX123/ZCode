// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentProjectionState } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { SubagentActivityButton } from "@/subagent-display/SubagentActivityButton.js";

afterEach(cleanup);
const member = (childSessionId: string, status: "running" | "waiting" | "blocked") => ({
  childSessionId,
  status,
  subagentType: "Explore",
  title: childSessionId,
});
const manifest: SubagentProjectionState = {
  revision: 1,
  childSessionIds: ["a", "b"],
  endedTotal: 0,
  running: [member("a", "running"), member("b", "waiting")],
};
const button = (subagents: SubagentProjectionState, onOpen = vi.fn()) =>
  createElement(ZCodeIntlProvider, {
    initialLocale: "zh-CN",
    children: createElement(SubagentActivityButton, { subagents, onOpen }),
  });

describe("SubagentActivityButton 活动派生", () => {
  it("部分结束保留入口，waiting/blocked 仍活动；全部结束与重复终态退场且无额外命令", () => {
    const onOpen = vi.fn();
    const view = render(button(manifest, onOpen));
    expect(view.getByRole("button").textContent).toContain("运行中 1");
    expect(view.getByRole("button").textContent).toContain("等待确认 1");
    act(() => view.getByRole("button").click());
    expect(onOpen).toHaveBeenCalledOnce();
    for (const status of ["waiting", "blocked"] as const) {
      view.rerender(button({ ...manifest, running: [member("b", status)], endedTotal: 1 }, onOpen));
      expect(view.getByRole("button")).toBeTruthy();
      expect(view.container.querySelector(".animate-spin")).toBeNull();
    }
    for (let n = 0; n < 2; n += 1) {
      view.rerender(button({ ...manifest, revision: 2 + n, running: [], endedTotal: 2 }, onOpen));
      expect(view.queryByRole("button")).toBeNull();
    }
    expect(onOpen).toHaveBeenCalledOnce();
  });
  it("刷新恢复的已结束 manifest 不显示入口，空 manifest 也不显示", () => {
    const view = render(button({ ...manifest, running: [], endedTotal: 2 }));
    expect(view.queryByRole("button")).toBeNull();
    view.rerender(button({ revision: 0, running: [], endedTotal: 0, childSessionIds: [] }));
    expect(view.queryByRole("button")).toBeNull();
  });
});
