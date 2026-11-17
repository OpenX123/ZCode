import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import {
  readMachOArchitectures,
  verifyMacApplication,
  verifyMacPackages,
  isOptionalForeignPrebuild,
} from "../macos-package-architecture.mjs";

const cpu = { arm64: 0x0100000c, x64: 0x01000007 };
function thin(arch, bigEndian = false) {
  const buffer = Buffer.alloc(32);
  const write = (value, offset) =>
    bigEndian ? buffer.writeUInt32BE(value, offset) : buffer.writeUInt32LE(value, offset);
  write(0xfeedfacf, 0);
  write(cpu[arch], 4);
  write(2, 12);
  return buffer;
}

function fat(arches, { wide = false, littleEndian = false } = {}) {
  const stride = wide ? 32 : 20;
  const start = 8 + arches.length * stride;
  const buffer = Buffer.alloc(start + arches.length * 32);
  const write = (value, offset) =>
    littleEndian ? buffer.writeUInt32LE(value, offset) : buffer.writeUInt32BE(value, offset);
  write(wide ? 0xcafebabf : 0xcafebabe, 0);
  write(arches.length, 4);
  arches.forEach((arch, index) => {
    const row = 8 + index * stride;
    write(cpu[arch], row);
    if (wide) {
      const write64 = littleEndian
        ? buffer.writeBigUInt64LE.bind(buffer)
        : buffer.writeBigUInt64BE.bind(buffer);
      write64(BigInt(start + index * 32), row + 8);
      write64(32n, row + 16);
    } else {
      write(start + index * 32, row + 8);
      write(32, row + 12);
    }
    thin(arch).copy(buffer, start + index * 32);
  });
  return buffer;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "zcode-macho-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function put(root, path, contents) {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, contents);
  return file;
}

test("真实文件头解析 thin 两种字节序与 fat/fat64 两种字节序", async (t) => {
  const root = await fixture(t);
  for (const arch of ["arm64", "x64"]) {
    for (const bigEndian of [true, false]) {
      const file = await put(root, "thin", thin(arch, bigEndian));
      assert.deepEqual(await readMachOArchitectures(file), [arch]);
    }
  }
  for (const wide of [true, false]) {
    for (const littleEndian of [true, false]) {
      const file = await put(root, "fat", fat(["arm64", "x64"], { wide, littleEndian }));
      assert.deepEqual(await readMachOArchitectures(file), ["arm64", "x64"]);
    }
  }
  assert.equal(await readMachOArchitectures(await put(root, "text", "hello")), null);
});

test("拒绝 fat 伪报 CPU、越界、重复、重叠和截断头部", async (t) => {
  const root = await fixture(t);
  const mismatch = fat(["arm64", "x64"]);
  mismatch.writeUInt32LE(cpu.x64, 52);
  const outside = fat(["arm64"]);
  outside.writeUInt32BE(100000, 16);
  const overlap = fat(["arm64", "x64"]);
  overlap.writeUInt32BE(48, 36);
  const widthConflict = thin("arm64");
  widthConflict.writeUInt32LE(0xfeedface);
  const wideOutside = fat(["arm64"], { wide: true });
  wideOutside.writeBigUInt64BE(2n ** 60n, 16);
  for (const buffer of [
    mismatch,
    outside,
    wideOutside,
    widthConflict,
    fat(["arm64", "arm64"]),
    overlap,
    thin("arm64").subarray(0, 8),
  ]) {
    await assert.rejects(readMachOArchitectures(await put(root, "bad", buffer)), /Mach-O/);
  }
});

test("仅明确的非目标 optional prebuild 豁免；普通加载路径和目标目录不豁免", () => {
  assert.equal(
    isOptionalForeignPrebuild("node_modules/optional/prebuilds/darwin-x64/a.node", "arm64"),
    true,
  );
  assert.equal(
    isOptionalForeignPrebuild("node_modules/@scope/optional/prebuilds/linux-arm64/a.node", "arm64"),
    true,
  );
  assert.equal(
    isOptionalForeignPrebuild("node_modules/koffi/build/koffi/darwin_x64/a.node", "arm64"),
    true,
  );
  for (const path of [
    "node_modules/node-pty/prebuilds/darwin-x64/pty.node",
    "node_modules/optional/prebuilds/darwin-arm64/a.node",
    "node_modules/optional/build/Release/a.node",
    "node_modules/optional/prebuilds/mystery/a.node",
    "tools/prebuilds/darwin-x64/a.node",
  ]) {
    assert.equal(isOptionalForeignPrebuild(path, "arm64"), false, path);
  }
});

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const asarCliPath = join(dirname(require.resolve("@electron/asar/package.json")), "bin/asar.js");
async function application(t) {
  const root = await fixture(t);
  const appPath = join(root, "YCode.app");
  const resources = "Contents/Resources";
  for (const path of [
    "Contents/MacOS/YCode",
    "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
    `${resources}/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/pty.node`,
    `${resources}/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper`,
    `${resources}/tools/bfs/bfs`,
    `${resources}/tools/ugrep/ugrep`,
    `${resources}/tools/ripgrep/rg`,
  ]) {
    await put(appPath, path, thin("arm64"));
  }
  await put(appPath, `${resources}/macos-window-bounds/zcode-window-bounds`, fat(["arm64", "x64"]));
  const payload = join(root, "payload");
  await put(payload, "package.json", '{"name":"fixture"}');
  async function pack() {
    await rm(join(appPath, resources, "app.asar"), { force: true });
    await asar.createPackage(payload, join(appPath, resources, "app.asar"));
  }
  await pack();
  return { root, appPath, payload, pack, options: { appPath, arch: "arm64", asarCliPath } };
}

test("完整应用及真实 asar 展开检查，非目标 optional 不误拒，隐藏 native 不漏检", async (t) => {
  const app = await application(t);
  await put(app.payload, "node_modules/optional/prebuilds/darwin-x64/a.node", thin("x64"));
  await app.pack();
  const result = await verifyMacApplication(app.options);
  assert.equal(result.optionalForeignPrebuilds.length, 1);
  assert.ok(result.checkedMachOFiles >= 8);
  await put(app.payload, "node_modules/required/build/Release/a.node", thin("x64"));
  await app.pack();
  await assert.rejects(verifyMacApplication(app.options), /required.*arm64/);
});

test("必需文件缺失、非 Mach-O、错误 CPU 和单架构 Swift 均失败", async (t) => {
  const app = await application(t);
  const helper =
    "Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper";
  await rm(join(app.appPath, helper));
  await assert.rejects(verifyMacApplication(app.options), /spawn-helper/);
  await put(app.appPath, helper, "not a binary");
  await assert.rejects(verifyMacApplication(app.options), /Mach-O/);
  await put(app.appPath, helper, thin("x64"));
  await assert.rejects(verifyMacApplication(app.options), /arm64/);
  await put(app.appPath, helper, thin("arm64"));
  await put(
    app.appPath,
    "Contents/Resources/macos-window-bounds/zcode-window-bounds",
    thin("arm64"),
  );
  await assert.rejects(verifyMacApplication(app.options), /x64/);
});

test("完整扫描拒绝无扩展名32位Mach-O与损坏的普通native，不忽略宿主模块", async (t) => {
  const app = await application(t);
  const thin32 = Buffer.alloc(28);
  thin32.writeUInt32LE(0xfeedface);
  thin32.writeUInt32LE(7, 4);
  await put(app.payload, "hidden-tool", thin32);
  await app.pack();
  await assert.rejects(verifyMacApplication(app.options), /hidden-tool.*arm64/);
  await rm(join(app.payload, "hidden-tool"));
  await put(app.payload, "node_modules/required/invalid.node", "broken native");
  await app.pack();
  await assert.rejects(verifyMacApplication(app.options), /invalid.node.*not Mach-O/);
});

test("容器集合缺失或重复在实际容器处理前失败，不能仅凭解包app放行", async (t) => {
  const app = await application(t);
  for (const artifacts of [[], ["a.dmg"], ["a.dmg", "b.dmg"]]) {
    await assert.rejects(verifyMacPackages({ ...app.options, artifacts }), /one DMG and one ZIP/);
  }
});
