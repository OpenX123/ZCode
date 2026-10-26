// 仅用于隔离 E2E：在启动 Electron 前生成官方状态命令替身，不读取真实账号。
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
}
