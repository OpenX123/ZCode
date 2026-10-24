// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UsageStatsErrorNotice } from "../src/settings/usage-stats/UsageStatsErrorNotice.js";

vi.mock("../src/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));

describe("本地 App Usage 读取错误", () => {
  it.each(["local-db-unavailable", "EACCES: permission denied", "invalid local token record"])(
    "展示本地错误，不将 %s 误认为模型凭据问题",
    (error) => {
      const html = renderToStaticMarkup(createElement(UsageStatsErrorNotice, { error }));
      expect(html).toContain("settings.usage.appUsageLoadFailed");
      expect(html).toContain(error);
      expect(html).not.toContain("<button");
      expect(html).not.toContain("checkApiKey");
    },
  );
});
