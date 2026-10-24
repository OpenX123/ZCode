import { describe, expect, it } from "vitest";
import {
  applyDynamicWorkflowUserMode,
  createDynamicWorkflowClientConfig,
  DEFAULT_DYNAMIC_WORKFLOW_MODE,
  readDynamicWorkflowOfferedMode,
  normalizeDynamicWorkflowMode,
  resolveDynamicWorkflowClientConfig,
  ZCODE_DYNAMIC_WORKFLOW_MODE_ENV,
} from "../src/dynamic-workflow-feature.js";

describe("本地动态工作流模式", () => {
  it.each([undefined, null, {}, { mode: "disabled" }, { mode: "alwaysOn" }, "alwaysOn"])(
    "忽略旧 remote 输入 %j，默认 onDemand",
    (remote) => {
      expect(resolveDynamicWorkflowClientConfig({ remote })).toEqual({
        mode: "onDemand",
        enabled: true,
        source: "default",
        offeredMode: "onDemand",
      });
    },
  );
  it("不读取 remote 对象内容", () => {
    const remote = {
      get mode() {
        throw new Error("不应读取远端模式");
      },
    };
    expect(resolveDynamicWorkflowClientConfig({ remote }).mode).toBe(DEFAULT_DYNAMIC_WORKFLOW_MODE);
  });
  it.each(["disabled", "onDemand", "alwaysOn"] as const)("本地环境覆盖为 %s", (mode) => {
    expect(
      resolveDynamicWorkflowClientConfig({
        env: { [ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]: ` ${mode} ` },
      }),
    ).toEqual({ mode, enabled: mode !== "disabled", source: "override", offeredMode: mode });
  });
  it.each(["", "yes"])("非法环境覆盖 %s 回到默认", (mode) => {
    expect(
      resolveDynamicWorkflowClientConfig({ env: { [ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]: mode } })
        .source,
    ).toBe("default");
  });
});

describe("normalizeDynamicWorkflowMode / isDynamicWorkflowModeEnabled", () => {
  it("只认三个取值，其余一律 undefined", () => {
    expect(normalizeDynamicWorkflowMode("disabled")).toBe("disabled");
    expect(normalizeDynamicWorkflowMode("onDemand")).toBe("onDemand");
    expect(normalizeDynamicWorkflowMode("alwaysOn")).toBe("alwaysOn");
    expect(normalizeDynamicWorkflowMode("AlwaysOn")).toBeUndefined();
    expect(normalizeDynamicWorkflowMode(undefined)).toBeUndefined();
    expect(normalizeDynamicWorkflowMode(true)).toBeUndefined();
  });
});

// 用户的明确选择永远取代默认模式。
describe("applyDynamicWorkflowUserMode（DWG-18）", () => {
  const offer = (mode: "disabled" | "onDemand" | "alwaysOn") =>
    createDynamicWorkflowClientConfig(mode, "default");

  it("功能已提供时，用户选择取代提供的模式，默认值仍记在 offeredMode", () => {
    expect(applyDynamicWorkflowUserMode(offer("onDemand"), "alwaysOn")).toEqual({
      mode: "alwaysOn",
      enabled: true,
      source: "default",
      offeredMode: "onDemand",
      userMode: "alwaysOn",
    });
    expect(applyDynamicWorkflowUserMode(offer("alwaysOn"), "disabled")).toEqual({
      mode: "disabled",
      enabled: false,
      source: "default",
      offeredMode: "alwaysOn",
      userMode: "disabled",
    });
  });

  it("提供的是 disabled 时用户选择照样生效：disabled 只是默认值", () => {
    expect(applyDynamicWorkflowUserMode(offer("disabled"), "alwaysOn")).toEqual({
      mode: "alwaysOn",
      enabled: true,
      source: "default",
      offeredMode: "disabled",
      userMode: "alwaysOn",
    });
    expect(
      applyDynamicWorkflowUserMode(
        createDynamicWorkflowClientConfig("disabled", "default"),
        "onDemand",
      ),
    ).toMatchObject({ mode: "onDemand", enabled: true, source: "default", userMode: "onDemand" });
  });

  it.each([[undefined], [null], [""], ["bogus"], [1]])(
    "没有选择或存了非法值（%s）时原样沿用提供的模式",
    (choice) => {
      expect(applyDynamicWorkflowUserMode(offer("onDemand"), choice)).toEqual(offer("onDemand"));
    },
  );

  it("只看 offeredMode 重新推导：对已应用过选择的快照再应用是幂等覆盖", () => {
    const applied = applyDynamicWorkflowUserMode(offer("alwaysOn"), "disabled");
    expect(applyDynamicWorkflowUserMode(applied, undefined)).toEqual(offer("alwaysOn"));
    expect(applyDynamicWorkflowUserMode(applied, "onDemand").mode).toBe("onDemand");
  });

  it("resolveDynamicWorkflowClientConfig 接收 userMode，覆盖值仍只决定提供的模式", () => {
    expect(
      resolveDynamicWorkflowClientConfig({
        remote: { mode: "alwaysOn" },
        env: { [ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]: "onDemand" },
        userMode: "disabled",
      }),
    ).toEqual({
      mode: "disabled",
      enabled: false,
      source: "override",
      offeredMode: "onDemand",
      userMode: "disabled",
    });
  });

  it("readDynamicWorkflowOfferedMode 读提供的默认值（disabled 也算），不看用户选择", () => {
    expect(
      readDynamicWorkflowOfferedMode(applyDynamicWorkflowUserMode(offer("alwaysOn"), "disabled")),
    ).toBe("alwaysOn");
    expect(readDynamicWorkflowOfferedMode(offer("disabled"))).toBe("disabled");
  });

  it("readDynamicWorkflowOfferedMode：没有 offeredMode 的快照（旧 Host）或读不懂的值返回 undefined", () => {
    // 旧 Host 快照只有生效的 mode / enabled，没有 offeredMode；
    // 旧 Host 不认用户选择，所以不能把设置行摆出来。
    const legacy = { mode: "alwaysOn", enabled: true, source: "default" } as unknown as Parameters<
      typeof readDynamicWorkflowOfferedMode
    >[0];
    expect(readDynamicWorkflowOfferedMode(legacy)).toBeUndefined();
    expect(
      readDynamicWorkflowOfferedMode({
        ...offer("alwaysOn"),
        offeredMode: "sometimes",
      } as unknown as Parameters<typeof readDynamicWorkflowOfferedMode>[0]),
    ).toBeUndefined();
  });
});
