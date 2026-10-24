export interface E2EBeforeSessionSetupOptions {
  cid: string;
  specs: string[];
  configureAgentServerEnv: () => void;
  recordBeforeSession: (cid: string, specs: string[]) => void;
  resetHome: (specs: string[]) => Promise<void>;
  startUpstreamHttpIfNeeded: (specs: string[]) => Promise<void>;
  startPluginCdnZipFixtureIfNeeded: (specs: string[]) => Promise<void>;
}

export async function runE2EBeforeSessionSetup(options: E2EBeforeSessionSetupOptions) {
  options.recordBeforeSession(options.cid, options.specs);
  // 日志目录先归属当前 worker，再配置模型回放与 Agent 环境。
  options.configureAgentServerEnv();
  await options.startUpstreamHttpIfNeeded(options.specs);
  await options.startPluginCdnZipFixtureIfNeeded(options.specs);
  // HOME 重建与 fixture seed 完成之后才允许启动 Electron。
  await options.resetHome(options.specs);
}
