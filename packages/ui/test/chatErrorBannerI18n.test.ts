import { describe, expect, it } from "vitest";
import {
  MEDIA_BUDGET_CURRENT_IMAGE_TOO_LARGE_ERROR_CODE,
  MEDIA_BUDGET_CURRENT_VIDEO_TOO_LARGE_ERROR_CODE,
} from "@zcode/shared";
import { resolveChatErrorBannerDisplayMessage } from "@/ChatErrorBanner.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";

function createIntl(messages: Record<string, string>): IntlInstance {
  return {
    formatMessage({ id }, values = {}) {
      const template = messages[id] ?? id;
      return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
      );
    },
  };
}

describe("ChatErrorBanner i18n", () => {
  it.each([
    [zhCN, "当前没有可用模型。请先在模型设置中配置模型 API。"],
    [enUS, "No model available. Configure a model API in Model Settings."],
  ] as const)("无模型只引导配置普通模型 API", (messages, expected) => {
    expect(
      resolveChatErrorBannerDisplayMessage(
        { code: "model_config_missing", message: "Model config is missing" },
        createIntl(messages),
        "local",
      ),
    ).toBe(expected);
  });

  it("uses the remote wording for an empty remote workspace instead of local plan copy", () => {
    const zhIntl = createIntl(zhCN);
    const enIntl = createIntl(enUS);
    const error = {
      code: "model_config_missing",
      message: "Model config is missing",
    };

    const zhRemote = resolveChatErrorBannerDisplayMessage(error, zhIntl, "remote");
    const enRemote = resolveChatErrorBannerDisplayMessage(error, enIntl, "remote");

    expect(zhRemote).toBe(zhCN["chat.error.remoteNoAvailableModel"]);
    expect(zhRemote).not.toBe("chat.error.remoteNoAvailableModel");
    expect(zhRemote).not.toBe(zhCN["chat.error.noAvailableModel"]);
    expect(enRemote).toBe(enUS["chat.error.remoteNoAvailableModel"]);
    expect(enRemote).not.toBe("chat.error.remoteNoAvailableModel");
    expect(enRemote).not.toBe(enUS["chat.error.noAvailableModel"]);
    expect(resolveChatErrorBannerDisplayMessage(error, zhIntl, "local")).toBe(
      zhCN["chat.error.noAvailableModel"],
    );
  });

  it.each([
    [zhCN, "当前附件总量过大，请移除部分附件或压缩后重试。"],
    [
      enUS,
      "Current attachments are too large for one request. Remove or compress attachments and try again.",
    ],
  ] as const)("localizes the shared attachment budget error", (messages, expected) => {
    expect(
      resolveChatErrorBannerDisplayMessage(
        {
          code: "MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE",
          message: "Runtime fallback message",
        },
        createIntl(messages),
      ),
    ).toBe(expected);
  });

  it("localizes current media-budget attachment errors from stable runtime codes", () => {
    const zhIntl = createIntl(zhCN);
    const enIntl = createIntl(enUS);

    expect(
      resolveChatErrorBannerDisplayMessage(
        {
          code: MEDIA_BUDGET_CURRENT_VIDEO_TOO_LARGE_ERROR_CODE,
          message:
            "Current video attachments are too large to send. Remove or shrink videos and try again.",
        },
        zhIntl,
      ),
    ).toBe("当前视频附件过大，请移除部分视频或压缩后重试。");

    expect(
      resolveChatErrorBannerDisplayMessage(
        {
          code: MEDIA_BUDGET_CURRENT_IMAGE_TOO_LARGE_ERROR_CODE,
          message:
            "Current image attachments are too large to send. Remove or shrink images and try again.",
        },
        enIntl,
      ),
    ).toBe("Current image attachments are too large. Remove or compress images and try again.");
  });

  it("普通 API 业务错误保留原文，不套用旧套餐处理", () => {
    const message = "Provider quota exceeded";
    expect(resolveChatErrorBannerDisplayMessage({ code: "1308", message }, createIntl(enUS))).toBe(
      message,
    );
  });

  it("退役团队套餐错误不再驱动专属本地化", () => {
    const message = "Historical provider error";
    expect(
      resolveChatErrorBannerDisplayMessage(
        { code: "ZCODE_BIGMODEL_TEAM_PLAN_MEMBER_REQUIRED", message },
        createIntl(enUS),
      ),
    ).toBe(message);
  });
});
