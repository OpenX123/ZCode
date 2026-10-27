import type { GithubDesktopUpdateContract } from "./contract.js";

/** UI 只订阅并发命令；示例不创建第二份缓存或下载器。 */
export async function exampleGithubDesktopUpdate(
  updater: GithubDesktopUpdateContract,
): Promise<void> {
  const result = await updater.checkForUpdates(true);
  if (result.kind === "available") await updater.downloadUpdate();
}
