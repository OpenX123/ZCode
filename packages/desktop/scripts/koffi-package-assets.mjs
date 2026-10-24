// Windows Agent 的 MCP Job Object 使用外部化 Koffi；依赖必须位于 glm 根的
// node_modules，才能被 zcode.cjs 解析。当前 CUA SDK 不拥有这份原生依赖。
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

function resolveKoffiRoot(koffiPackageRoot) {
  const candidates = [
    resolve(koffiPackageRoot),
    resolve(koffiPackageRoot, "node_modules", "koffi"),
  ];
  const virtualStore = resolve(koffiPackageRoot, "..", "..", "..", "..", "node_modules", ".pnpm");
  candidates.push(resolve(virtualStore, "..", "koffi"));
  if (existsSync(virtualStore)) {
    for (const entry of readdirSync(virtualStore)) {
      if (entry.startsWith("koffi@"))
        candidates.push(resolve(virtualStore, entry, "node_modules", "koffi"));
    }
  }
  for (const candidate of candidates) {
    const packageJson = resolve(candidate, "package.json");
    if (!existsSync(packageJson)) continue;
    try {
      if (JSON.parse(readFileSync(packageJson, "utf8")).name === "koffi") return candidate;
    } catch {
      // 继续检查其他安装位置。
    }
  }
  throw new Error(
    `[koffi-package-assets] cannot resolve installed koffi package from ${koffiPackageRoot}`,
  );
}

function koffiPlatformKey(targetPlatform) {
  return `${targetPlatform.os}_${targetPlatform.arch}`;
}

export function stageKoffiIntoBundledAgents({ koffiPackageRoot, glmDir, targetPlatform }) {
  if (!koffiPackageRoot || !glmDir || !targetPlatform?.os || !targetPlatform?.arch) {
    throw new Error(
      "[koffi-package-assets] koffiPackageRoot, glmDir and targetPlatform are required",
    );
  }
  if (targetPlatform.os !== "win32") return;
  const sourceRoot = resolveKoffiRoot(koffiPackageRoot);
  const platformKey = koffiPlatformKey(targetPlatform);
  const sourceNativeDir = resolve(sourceRoot, "build", "koffi", platformKey);
  if (!existsSync(resolve(sourceNativeDir, "koffi.node"))) {
    throw new Error(
      `[koffi-package-assets] missing target native addon: ${sourceNativeDir}/koffi.node`,
    );
  }

  const targetRoot = resolve(glmDir, "node_modules", "koffi");
  rmSync(targetRoot, { recursive: true, force: true });
  mkdirSync(resolve(targetRoot, "build", "koffi", platformKey), { recursive: true });
  for (const file of ["index.js", "package.json", "index.d.ts"]) {
    cpSync(resolve(sourceRoot, file), resolve(targetRoot, file));
  }
  cpSync(
    resolve(sourceNativeDir, "koffi.node"),
    resolve(targetRoot, "build", "koffi", platformKey, "koffi.node"),
  );
  return resolve(targetRoot, "build", "koffi", platformKey, "koffi.node");
}

export function verifyStagedKoffi({ resourcesDir, targetPlatform }) {
  if (targetPlatform.os !== "win32") return [];
  const platformKey = koffiPlatformKey(targetPlatform);
  const koffiRoot = resolve(resourcesDir, "glm", "node_modules", "koffi");
  const nativePath = resolve(koffiRoot, "build", "koffi", platformKey, "koffi.node");
  return existsSync(nativePath) && existsSync(resolve(koffiRoot, "index.js"))
    ? []
    : [`missing staged koffi runtime for ${platformKey}: ${nativePath}`];
}
