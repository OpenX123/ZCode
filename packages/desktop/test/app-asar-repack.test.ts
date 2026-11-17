import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { getRawHeader } from "@electron/asar";
import { describe, expect, it } from "vitest";
import { ASAR_UNPACK_NATIVE_GLOB, replaceAppAsarFromStaging } from "../scripts/app-asar-repack.mjs";
import { collectRuntimeModuleClosureEntries } from "../scripts/runtime-dependency-closure.mjs";

const require = createRequire(import.meta.url);
const asarCliPath = resolve(
  dirname(require.resolve("@electron/asar/package.json")),
  "bin",
  "asar.js",
);

describe("app asar repack", () => {
  it("同宿主mac目标保留SSH可选native，不把cross裁剪扩散到正常构建", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "zcode-ssh-same-host-"));
    try {
      const sourceDir = resolve(root, "source");
      const appAsarPath = resolve(root, "app.asar");
      const files = [
        "ssh2/lib/protocol/crypto/build/Release/sshcrypto.node",
        "cpu-features/build/Release/cpufeatures.node",
        "node-pty/prebuilds/darwin-x64/spawn-helper",
      ];
      for (const file of files) {
        const path = resolve(sourceDir, "node_modules", file);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file);
      }
      await replaceAppAsarFromStaging({
        sourceDir,
        appAsarPath,
        targetPlatformKey: "darwin-x64",
        hostPlatformKey: "darwin-x64",
        runAsarCommand: (args: string[]) => execFileSync(process.execPath, [asarCliPath, ...args]),
      });
      const extracted = resolve(root, "extracted");
      await promisify(execFile)(process.execPath, [asarCliPath, "extract", appAsarPath, extracted]);
      for (const file of files)
        expect(existsSync(resolve(extracted, "node_modules", file))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("真实SSH包清理重打包后fresh Node使用fallback完成三密码族认证与exec", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "zcode-ssh-fallback-"));
    try {
      const sourceDir = resolve(root, "source");
      const appAsarPath = resolve(root, "app.asar");
      for (const entry of collectRuntimeModuleClosureEntries(["ssh2"], [process.cwd()])) {
        if (!entry.sourceModulePath)
          throw new Error(`missing actual dependency ${entry.moduleName}`);
        await cp(entry.sourceModulePath, resolve(sourceDir, "node_modules", entry.moduleName), {
          recursive: true,
        });
      }
      const ptyDir = resolve(sourceDir, "node_modules/node-pty/prebuilds/darwin-arm64");
      await mkdir(ptyDir, { recursive: true });
      await writeFile(resolve(ptyDir, "spawn-helper"), "fixture-only-never-executed");
      await replaceAppAsarFromStaging({
        sourceDir,
        appAsarPath,
        targetPlatformKey: "darwin-arm64",
        hostPlatformKey: "darwin-x64",
        runAsarCommand: (args: string[]) => execFileSync(process.execPath, [asarCliPath, ...args]),
      });
      const extracted = resolve(root, "extracted");
      await promisify(execFile)(process.execPath, [asarCliPath, "extract", appAsarPath, extracted]);
      const childPath = resolve(extracted, "fallback.cjs");
      await writeFile(
        childPath,
        `
        const assert = require('node:assert/strict');
        const { generateKeyPairSync } = require('node:crypto');
        const { once } = require('node:events');
        const { Client, Server } = require('ssh2');
        const crypto = require('ssh2/lib/protocol/crypto.js');
        const constants = require('ssh2/lib/protocol/constants.js');
        const hostKey = generateKeyPairSync('rsa', {modulusLength:2048}).privateKey.export({format:'pem',type:'pkcs1'});
        (async () => {
          assert.equal(crypto.bindingAvailable, false);
          assert.throws(() => require('cpu-features'), /cpufeatures.node/);
          await crypto.init;
          for (const cipher of ['aes128-gcm@openssh.com','aes128-ctr','chacha20-poly1305@openssh.com']) {
            assert.ok(constants.DEFAULT_CIPHER.includes(cipher), cipher);
            const connections = new Set();
            const server = new Server({hostKeys:[hostKey], algorithms:{cipher:[cipher]}}, connection => {
              connections.add(connection);
              connection.on('close', () => connections.delete(connection));
              connection.on('error', () => {});
              connection.on('authentication', context => context.username === 'fixture' && context.method === 'password' && context.password === 'fixture-only' ? context.accept() : context.reject());
              connection.on('ready', () => connection.on('session', accept => accept().on('exec', (accept, reject, info) => {
                assert.equal(info.command, 'probe');
                const stream = accept();
                stream.write('fallback:' + cipher); stream.exit(0); stream.end();
              })));
            });
            const client = new Client();
            let negotiated;
            client.on('handshake', value => { negotiated = value; });
            try {
              server.listen(0, '127.0.0.1'); await once(server, 'listening');
              const ready = once(client, 'ready');
              client.connect({host:'127.0.0.1', port:server.address().port, username:'fixture', password:'fixture-only', algorithms:{cipher:[cipher]}, readyTimeout:5000});
              await ready;
              const result = await new Promise((resolve, reject) => client.exec('probe', (error, stream) => {
                if (error) return reject(error);
                let out = ''; stream.on('data', chunk => out += chunk); stream.on('error', reject);
                stream.on('close', code => resolve({out, code}));
              }));
              assert.deepEqual(result, {out:'fallback:' + cipher, code:0});
              assert.equal(negotiated.cs.cipher, cipher);
              assert.equal(negotiated.sc.cipher, cipher);
              console.log('fallback roundtrip PASS', cipher);
            } finally {
              client.destroy();
              for (const connection of connections) connection.end();
              await new Promise(resolve => server.close(resolve));
            }
          }
        })().catch(error => { console.error(error); process.exitCode = 1; });
      `,
      );
      const env = { ...process.env };
      delete env.NODE_OPTIONS;
      const result = await promisify(execFile)(process.execPath, [childPath], {
        cwd: extracted,
        env,
        timeout: 20000,
      });
      expect(result.stdout).toContain("fallback roundtrip PASS aes128-gcm@openssh.com");
      expect(result.stdout).toContain("fallback roundtrip PASS aes128-ctr");
      expect(result.stdout).toContain("fallback roundtrip PASS chacha20-poly1305@openssh.com");
      expect(result.stderr).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("交叉重打包移除注入的可选宿主加速，保留JS、WASM与目标PTY并清除旧sidecar", async () => {
    const rootDir = mkdtempSync(resolve(tmpdir(), ".zcode-ssh-prune-test-"));
    try {
      const sourceDir = resolve(rootDir, "source");
      const appAsarPath = resolve(rootDir, "app.asar");
      const optional = [
        "ssh2/lib/protocol/crypto/build/Release/sshcrypto.node",
        "cpu-features/build/Release/cpufeatures.node",
      ];
      const retained = [
        "ssh2/lib/protocol/crypto.js",
        "ssh2/lib/protocol/crypto/poly1305.js",
        "ssh2/LICENSE",
        "node-pty/prebuilds/darwin-arm64/pty.node",
        "node-pty/prebuilds/darwin-arm64/spawn-helper",
        "other/build/Release/required.node",
      ];
      for (const file of [...optional, ...retained]) {
        const target = resolve(sourceDir, "node_modules", file);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file);
      }
      const oldNative = resolve(`${appAsarPath}.unpacked`, "node_modules", optional[0]);
      mkdirSync(dirname(oldNative), { recursive: true });
      writeFileSync(oldNative, "stale-host");
      await replaceAppAsarFromStaging({
        sourceDir,
        appAsarPath,
        targetPlatformKey: "darwin-arm64",
        hostPlatformKey: "darwin-x64",
        runAsarCommand: (args: string[]) => execFileSync(process.execPath, [asarCliPath, ...args]),
      });
      const extracted = resolve(rootDir, "extracted");
      execFileSync(process.execPath, [asarCliPath, "extract", appAsarPath, extracted]);
      for (const file of optional) {
        expect(existsSync(resolve(extracted, "node_modules", file))).toBe(false);
        expect(existsSync(resolve(`${appAsarPath}.unpacked`, "node_modules", file))).toBe(false);
      }
      for (const file of retained)
        expect(readFileSync(resolve(extracted, "node_modules", file), "utf8")).toBe(file);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
  it("TMPDIR 含隐藏目录时仍应 unpack native，并删除旧 sidecar 残留", async () => {
    const rootDir = mkdtempSync(resolve(tmpdir(), ".zcode-asar-repack-test-"));
    try {
      const sourceDir = resolve(rootDir, "source");
      const targetPrebuildDir = resolve(sourceDir, "node_modules/node-pty/prebuilds/darwin-arm64");
      const appAsarPath = resolve(rootDir, "app.asar");
      const oldUnpackedPath = `${appAsarPath}.unpacked`;
      mkdirSync(targetPrebuildDir, { recursive: true });
      mkdirSync(oldUnpackedPath, { recursive: true });
      writeFileSync(resolve(targetPrebuildDir, "pty.node"), "native-binary");
      writeFileSync(resolve(targetPrebuildDir, "spawn-helper"), "helper-binary");
      writeFileSync(resolve(oldUnpackedPath, "stale-native.node"), "stale");

      await replaceAppAsarFromStaging({
        sourceDir,
        appAsarPath,
        targetPlatformKey: "darwin-arm64",
        runAsarCommand: (args: string[]) => {
          execFileSync(process.execPath, [asarCliPath, ...args]);
        },
      });

      const header = getRawHeader(appAsarPath).header as {
        files: Record<string, unknown>;
      };
      const nativeHeader = (
        header.files as {
          node_modules: {
            files: {
              "node-pty": {
                files: {
                  prebuilds: {
                    files: {
                      "darwin-arm64": { files: Record<string, { unpacked?: boolean }> };
                    };
                  };
                };
              };
            };
          };
        }
      ).node_modules.files["node-pty"].files.prebuilds.files["darwin-arm64"].files;

      expect(ASAR_UNPACK_NATIVE_GLOB).toBe("*.{node,dll,dylib,exe}");
      expect(nativeHeader["pty.node"].unpacked).toBe(true);
      expect(nativeHeader["spawn-helper"].unpacked).toBe(true);
      expect(
        readFileSync(
          resolve(oldUnpackedPath, "node_modules/node-pty/prebuilds/darwin-arm64/pty.node"),
          "utf8",
        ),
      ).toBe("native-binary");
      expect(existsSync(resolve(oldUnpackedPath, "stale-native.node"))).toBe(false);
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
    }
  });
});
