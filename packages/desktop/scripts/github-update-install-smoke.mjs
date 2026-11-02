#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { installMacUpdate } from "../src/main/github-update/macInstaller.ts";

const exec = promisify(execFile);
const self = fileURLToPath(import.meta.url);
if (process.argv[2] === "worker") {
  const [root, mode] = process.argv.slice(3);
  const installed = await installMacUpdate({
    appPath: join(root, "YCode Fixture.app"),
    version: mode === "mismatch" ? "1.0.9" : "1.0.4",
    installerPath: join(root, "update.dmg"),
    logPath: join(root, "install.log"),
    signal: new AbortController().signal,
    confirmInstall: () => mode !== "cancel",
    quitForInstall: async () => {
      await writeFile(join(root, "quit-prepared"), "yes");
      setTimeout(() => process.exit(0), 100);
    },
  });
  console.log(JSON.stringify({ installed }));
} else {
  assert.equal(process.platform, "darwin", "该 smoke 需要 macOS hdiutil 与 LaunchServices");
  const root = await mkdtemp(join(tmpdir(), "ycode-install-smoke ' "));
  const target = join(root, "YCode Fixture.app");
  const source = join(root, "image", "YCode.app");
  const bundleId = `dev.ycode.install-smoke.${Date.now()}`;
  async function app(path, version) {
    await mkdir(join(path, "Contents", "MacOS"), { recursive: true });
    await writeFile(
      join(path, "Contents", "Info.plist"),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleName</key><string>YCode Install Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleExecutable</key><string>fixture</string></dict></plist>`,
    );
    await writeFile(
      join(path, "Contents", "MacOS", "fixture"),
      '#!/bin/sh\nprintf started > "$(dirname "$0")/../started"\n',
      { mode: 0o755 },
    );
  }
  await app(target, "1.0.3");
  await app(source, "1.0.4");
  await exec("/usr/bin/hdiutil", [
    "create",
    "-srcfolder",
    join(root, "image"),
    "-volname",
    "YCodeInstallFixture",
    "-format",
    "UDRO",
    join(root, "update.dmg"),
  ]);
  async function worker(mode) {
    const child = spawn(process.execPath, [self, "worker", root, mode], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    const code = await new Promise((resolve) => child.once("exit", resolve));
    return { code, output };
  }
  assert.notEqual((await worker("mismatch")).code, 0);
  await assert.rejects(readFile(join(root, "quit-prepared")));
  assert.equal((await worker("cancel")).code, 0);
  await assert.rejects(readFile(join(root, "quit-prepared")));
  const success = await worker("install");
  assert.equal(success.code, 0, success.output);
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await readFile(join(target, "Contents", "started"), "utf8").catch(() => "")) === "started")
      break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(await readFile(join(target, "Contents", "started"), "utf8"), "started");
  assert.equal(await readFile(join(root, "quit-prepared"), "utf8"), "yes");
  console.log(
    JSON.stringify({
      root,
      mismatchedVersionRejected: true,
      cancellationPreservesApp: true,
      preparedQuit: true,
      replacedAndLaunched: true,
    }),
  );
  await rm(root, { recursive: true, force: true });
}
