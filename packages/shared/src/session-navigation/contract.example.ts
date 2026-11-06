/**
 * session-navigation 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import { buildSessionDeepLink, parseSessionDeepLink } from "./contract.js";

export function exampleSessionNavigation() {
  return parseSessionDeepLink(
    buildSessionDeepLink({
      taskId: "sess_example",
      workspacePath: "C:\\Projects\\示例",
    }),
  );
}
