// 仅用于隔离 E2E：在启动 Electron 前生成官方状态命令替身，不读取真实账号。
// 调用方还须清除 runner 子进程的 ambient ANTHROPIC_/OPENAI_/CODEX_/CLAUDE_ 变量，
// 仅注入明确的 example 网关；HOME 由桌面 runner 隔离，不能用开发机的 CLI 配置目录。
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const directory = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("需要夹具 bin 目录参数");
await mkdir(directory, { recursive: true });
for (const engine of ["claude", "codex"]) {
  const source = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('fixture-cli 1.0.0');
else if (${JSON.stringify(engine)} === 'claude') console.log(JSON.stringify({loggedIn:true,authMethod:'claudeai',subscriptionType:'fixture'}));
else console.log('Logged in using ChatGPT');
`;
  await writeFile(join(directory, engine), source, { mode: 0o755 });
  if (process.platform === "win32") {
    // Windows 正式解析器只查 PATHEXT；Claude shim 必须可解出同目录 cjs，避免回落真实 CLI。
    await writeFile(join(directory, `${engine}.cjs`), source);
    await writeFile(
      join(directory, `${engine}.cmd`),
      `@echo off\r\n"${process.execPath}" "%~dp0\\${engine}.cjs" %*\r\n`,
    );
  }
}
