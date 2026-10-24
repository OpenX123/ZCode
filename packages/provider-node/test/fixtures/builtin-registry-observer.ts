import { NodeProviderRegistryRuntime } from "../../src/provider-registry-runtime.js";

// 真实子进程只消费共享文件，模拟不拥有下载器的 Worker；只读取本地随包与 Personal 配置。

const runtime = new NodeProviderRegistryRuntime({
  zcodeBuiltinFilePath: process.argv[2]!,
  personalFilePath: process.argv[3]!,
  personalPollingIntervalMs: false,
});
function report() {
  const snapshot = runtime.registryService.getSnapshot()!;
  process.send?.({
    pid: process.pid,
    builtin: snapshot.config.zcodeBuiltinRevision,
  });
}
runtime.registryService.onDidChange(report);
await runtime.start();
report();
process.on("message", () => {
  runtime.dispose();
  process.disconnect();
});
process.on("disconnect", () => {
  runtime.dispose();
});
