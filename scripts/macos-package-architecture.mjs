import { execFile } from "node:child_process";
import { mkdir, mkdtemp, open, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const cpuNames = new Map([
  [0x0100000c, "arm64"],
  [0x01000007, "x64"],
]);
const thinMagics = new Map([
  [0xcffaedfe, { big: false, size: 32 }],
  [0xfeedfacf, { big: true, size: 32 }],
  [0xcefaedfe, { big: false, size: 28 }],
  [0xfeedface, { big: true, size: 28 }],
]);
const fatMagics = new Map([
  [0xcafebabe, { big: true, wide: false }],
  [0xbebafeca, { big: false, wide: false }],
  [0xcafebabf, { big: true, wide: true }],
  [0xbfbafeca, { big: false, wide: true }],
]);

function invalid(path, reason) {
  throw new Error(`Mach-O ${path}: ${reason}`);
}

// Bugfix：交叉打包不能执行目标程序，也不能信任 fat 表声称的 CPU；逐 slice 读取真实头部。
export async function readMachOArchitectures(path) {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    async function read(offset, length) {
      if (offset < 0 || offset + length > size) invalid(path, "truncated header or slice");
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, offset);
      if (bytesRead !== length) invalid(path, "truncated read");
      return buffer;
    }
    if (size < 4) return null;
    const magic = (await read(0, 4)).readUInt32BE(0);
    async function thinCpu(offset, length) {
      const format = thinMagics.get((await read(offset, 4)).readUInt32BE(0));
      if (!format || length < format.size) invalid(path, "slice is not a complete Mach-O");
      const header = await read(offset, format.size);
      const cpu = format.big ? header.readUInt32BE(4) : header.readUInt32LE(4);
      if (Boolean(cpu & 0x01000000) !== (format.size === 32))
        invalid(path, "CPU/header width conflict");
      return cpu;
    }
    if (thinMagics.has(magic)) {
      const cpu = await thinCpu(0, size);
      return [cpuNames.get(cpu) ?? `cpu:0x${cpu.toString(16)}`];
    }
    const format = fatMagics.get(magic);
    if (!format) return null;
    const read32 = (buffer, offset) =>
      format.big ? buffer.readUInt32BE(offset) : buffer.readUInt32LE(offset);
    const read64 = (buffer, offset) => {
      const value = format.big ? buffer.readBigUInt64BE(offset) : buffer.readBigUInt64LE(offset);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid(path, "unsafe slice range");
      return Number(value);
    };
    const count = read32(await read(0, 8), 4);
    if (count < 1 || count > 64) invalid(path, "invalid slice count");
    const stride = format.wide ? 32 : 20;
    const tableEnd = 8 + count * stride;
    const table = await read(8, count * stride);
    const ranges = [];
    const cpus = new Set();
    for (let index = 0; index < count; index++) {
      const row = index * stride;
      const cpu = read32(table, row);
      const offset = format.wide ? read64(table, row + 8) : read32(table, row + 8);
      const length = format.wide ? read64(table, row + 16) : read32(table, row + 12);
      if (cpus.has(cpu)) invalid(path, "duplicate CPU slice");
      if (
        offset < tableEnd ||
        length < 28 ||
        offset + length > size ||
        !Number.isSafeInteger(offset + length)
      )
        invalid(path, "invalid slice range");
      if (ranges.some(([start, end]) => offset < end && offset + length > start))
        invalid(path, "overlapping slices");
      if ((await thinCpu(offset, length)) !== cpu)
        invalid(path, "slice CPU disagrees with fat table");
      cpus.add(cpu);
      ranges.push([offset, offset + length]);
    }
    return [...cpus].map((cpu) => cpuNames.get(cpu) ?? `cpu:0x${cpu.toString(16)}`);
  } finally {
    await file.close();
  }
}

export function isOptionalForeignPrebuild(path, arch) {
  const normalized = path.replaceAll("\\", "/");
  if (/(?:^|\/)node_modules\/node-pty\//.test(normalized)) return false;
  const match =
    /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/prebuilds\/(darwin|linux|win32)-(arm64|x64|ia32|arm)(?:\/|$)/.exec(
      normalized,
    ) ??
    /(?:^|\/)node_modules\/koffi\/build\/koffi\/(darwin|linux|win32)_(arm64|x64|ia32|arm)(?:\/|$)/.exec(
      normalized,
    );
  return Boolean(match && (match[1] !== "darwin" || match[2] !== arch));
}

async function* files(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    // Framework symlinks point at the version directory, which is scanned once via its real entry.
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile() || (entry.isSymbolicLink() && (await stat(path)).isFile())) yield path;
  }
}

export async function verifyMacApplication({ appPath, arch, asarCliPath }) {
  if (!["arm64", "x64"].includes(arch)) throw new Error(`Unsupported macOS arch: ${arch}`);
  const resources = join(appPath, "Contents/Resources");
  const productName = basename(appPath, ".app");
  const required = [
    `Contents/MacOS/${productName}`,
    "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
    ...["pty.node", "spawn-helper"].map(
      (name) =>
        `Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-${arch}/${name}`,
    ),
    ...["bfs/bfs", "ugrep/ugrep", "ripgrep/rg"].map((name) => `Contents/Resources/tools/${name}`),
  ];
  for (const path of required) {
    const arches = await readMachOArchitectures(join(appPath, path));
    if (!arches?.includes(arch))
      invalid(path, `requires ${arch}; found ${arches?.join(",") ?? "non Mach-O"}`);
  }
  const helper = "Contents/Resources/macos-window-bounds/zcode-window-bounds";
  const helperArches = await readMachOArchitectures(join(appPath, helper));
  if (!["arm64", "x64"].every((cpu) => helperArches?.includes(cpu)))
    invalid(helper, "requires universal arm64,x64");

  const scratch = await mkdtemp(join(tmpdir(), "zcode-macos-asar-"));
  const report = { checkedMachOFiles: 0, optionalForeignPrebuilds: [] };
  try {
    await execute(process.execPath, [asarCliPath, "extract", join(resources, "app.asar"), scratch]);
    for (const root of [appPath, scratch]) {
      for await (const file of files(root)) {
        const path = relative(root, file).replaceAll("\\", "/");
        if (isOptionalForeignPrebuild(path, arch)) {
          report.optionalForeignPrebuilds.push(path);
          continue;
        }
        const arches = await readMachOArchitectures(file);
        if (!arches) {
          if (/\.(node|dylib)$/.test(path)) invalid(path, "native module is not Mach-O");
          continue;
        }
        if (!arches.includes(arch)) invalid(path, `requires ${arch}; found ${arches.join(",")}`);
        report.checkedMachOFiles++;
      }
    }
    console.log(`[macos-architecture] ${appPath}: ${JSON.stringify(report)}`);
    return report;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function findSingleApp(root) {
  const apps = (await readdir(root, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && entry.name.endsWith(".app"),
  );
  if (apps.length !== 1)
    throw new Error(`Expected exactly one .app in ${root}; found ${apps.length}`);
  return join(root, apps[0].name);
}

// 同一 owner 校验最终容器内容，不能把解包目录成功冒充 DMG/ZIP 内应用已通过。
export async function verifyMacPackages({ appPath, artifacts, arch, asarCliPath }) {
  await verifyMacApplication({ appPath, arch, asarCliPath });
  if (
    artifacts.length !== 2 ||
    ![".dmg", ".zip"].every((extension) => artifacts.some((file) => file.endsWith(extension)))
  )
    throw new Error("macOS requires exactly one DMG and one ZIP");
  for (const artifact of artifacts) {
    const scratch = await mkdtemp(join(tmpdir(), "zcode-macos-container-"));
    const extracted = join(scratch, "app");
    let mounted = false;
    try {
      if (artifact.endsWith(".dmg")) {
        await mkdir(extracted);
        await execute("hdiutil", [
          "attach",
          "-readonly",
          "-nobrowse",
          "-mountpoint",
          extracted,
          artifact,
        ]);
        mounted = true;
      } else {
        await execute("ditto", ["-x", "-k", artifact, extracted]);
      }
      const containedApp = await findSingleApp(extracted);
      if (basename(containedApp) !== basename(appPath))
        throw new Error(`Unexpected application in ${artifact}: ${containedApp}`);
      await verifyMacApplication({ appPath: containedApp, arch, asarCliPath });
    } finally {
      try {
        // attach 也可能部分成功后报错；设备号不同表示挂载仍在，必须先 detach，不能递归删除卷。
        const mountedVolume =
          artifact.endsWith(".dmg") &&
          (await stat(extracted).then(
            async (value) => value.dev !== (await stat(scratch)).dev,
            () => false,
          ));
        if (mounted || mountedVolume) {
          mounted = true;
          await execute("hdiutil", ["detach", extracted]);
          mounted = false;
        }
      } finally {
        // 挂载失败也清理自有空目录；detach 失败时不递归删除仍挂载的卷。
        if (!mounted) await rm(scratch, { recursive: true, force: true });
      }
    }
  }
}
