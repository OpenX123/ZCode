import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { UpdateCheckResultPayload, UpdateStatePayload } from "@zcode/shared";
import type { GithubDesktopUpdateContract, GithubDesktopUpdateOptions } from "./contract.js";
import {
  GITHUB_UPDATE_MANIFEST_URL,
  MAX_MANIFEST_BYTES,
  UPDATE_INTERVAL_MS,
  parseGithubUpdateManifest,
  isNewerVersion,
  type GithubUpdateAsset,
  type GithubUpdateManifest,
} from "./manifest.js";

interface Candidate {
  manifest: GithubUpdateManifest;
  asset: GithubUpdateAsset;
}

async function verifyInstaller(path: string, asset: GithubUpdateAsset): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size !== asset.size) return false;
  const hash = createHash("sha256");
  try {
    for await (const bytes of createReadStream(path)) hash.update(bytes);
    return hash.digest("hex") === asset.sha256;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readManifest(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error(`更新检查失败：HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_MANIFEST_BYTES)
    throw new Error("更新清单超过大小限制");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of Readable.fromWeb(response.body as never, { signal })) {
    size += chunk.length;
    if (size > MAX_MANIFEST_BYTES) throw new Error("更新清单超过大小限制");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Main 唯一更新 owner；下载和打开共用同一 flight，重复点击不会多开安装器。 */
export function createGithubDesktopUpdater(
  options: GithubDesktopUpdateOptions,
): GithubDesktopUpdateContract {
  const enabled =
    options.isPackaged &&
    ["darwin", "win32"].includes(options.platform) &&
    ["arm64", "x64"].includes(options.arch) &&
    options.currentVersion !== "3.16.2";
  const now = options.now ?? (() => Date.now());
  const lifetime = new AbortController();
  const listeners = new Set<(state: UpdateStatePayload) => void>();
  let state: UpdateStatePayload = { kind: "idle", enabled, currentVersion: options.currentVersion };
  let candidate: Candidate | null = null;
  let checkFlight: Promise<UpdateCheckResultPayload> | undefined;
  let downloadFlight: Promise<UpdateCheckResultPayload> | undefined;
  let lastCheckAt: number | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let started = false;

  function publish(next: UpdateStatePayload): void {
    if (lifetime.signal.aborted) return;
    state = {
      ...next,
      currentVersion: options.currentVersion,
      ...(candidate ? { releaseUrl: candidate.manifest.releaseUrl } : {}),
    };
    for (const listener of listeners) listener({ ...state });
  }
  function failure(error: unknown): UpdateCheckResultPayload {
    const message = error instanceof Error ? error.message : String(error);
    publish({
      kind: "error",
      enabled,
      message,
      ...(candidate ? { version: candidate.manifest.version } : {}),
    });
    return { kind: "error", message };
  }
  function currentResult(): UpdateCheckResultPayload {
    if (state.kind === "download-progress")
      return {
        kind: "already-downloading",
        version: candidate!.manifest.version,
        progress: state.progress,
      };
    if (state.kind === "update-downloaded") return { kind: "ready", version: state.version };
    return candidate
      ? { kind: "available", version: candidate.manifest.version }
      : { kind: "up-to-date", currentVersion: options.currentVersion };
  }

  async function performCheck(): Promise<UpdateCheckResultPayload> {
    publish({ kind: "checking", enabled });
    try {
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)]);
      const response = await options.fetch(GITHUB_UPDATE_MANIFEST_URL, {
        signal,
        cache: "no-store",
      });
      const manifest = parseGithubUpdateManifest(await readManifest(response, signal));
      lifetime.signal.throwIfAborted();
      const asset = manifest.assets.find(
        (item) => item.platform === options.platform && item.arch === options.arch,
      );
      if (!asset) throw new Error("更新清单没有当前系统和架构的安装器");
      if (!isNewerVersion(manifest.version, options.currentVersion)) {
        candidate = null;
        publish({ kind: "idle", enabled });
        return { kind: "up-to-date", currentVersion: options.currentVersion };
      }
      candidate = { manifest, asset };
      if (await verifyInstaller(installerPath(candidate), asset)) {
        lifetime.signal.throwIfAborted();
        publish({ kind: "update-downloaded", enabled, version: manifest.version });
        return { kind: "ready", version: manifest.version };
      }
      publish({ kind: "update-available", enabled, version: manifest.version });
      return { kind: "available", version: manifest.version };
    } catch (error) {
      return failure(error);
    }
  }

  function checkForUpdates(manual = true): Promise<UpdateCheckResultPayload> {
    if (lifetime.signal.aborted)
      return Promise.resolve({ kind: "error", message: "更新服务已关闭" });
    if (!enabled)
      return Promise.resolve(
        options.currentVersion === "3.16.2"
          ? { kind: "error", message: "此旧版本须先手工安装一次 YCode 1.0.0，再使用 GitHub 更新" }
          : { kind: "dev-skipped" },
      );
    if (downloadFlight) return Promise.resolve(currentResult());
    if (checkFlight) return checkFlight;
    if (!manual && lastCheckAt !== undefined && now() - lastCheckAt < UPDATE_INTERVAL_MS)
      return Promise.resolve(currentResult());
    lastCheckAt = now();
    checkFlight = performCheck().finally(() => {
      checkFlight = undefined;
    });
    return checkFlight;
  }

  function installerPath(selected: Candidate): string {
    return join(
      options.cacheDir,
      selected.manifest.version,
      selected.asset.sha256,
      selected.asset.fileName,
    );
  }
  async function openVerified(selected: Candidate): Promise<UpdateCheckResultPayload> {
    const path = installerPath(selected);
    if (!(await verifyInstaller(path, selected.asset)))
      throw new Error("更新安装器缺失或校验失败，请重新下载");
    lifetime.signal.throwIfAborted();
    const message = await options.openInstaller(path);
    if (message) throw new Error(`无法打开更新安装器：${message}`);
    publish({ kind: "update-downloaded", enabled, version: selected.manifest.version });
    return { kind: "ready", version: selected.manifest.version };
  }

  async function downloadInstaller(selected: Candidate): Promise<void> {
    const path = installerPath(selected);
    if (await verifyInstaller(path, selected.asset)) return;
    const directory = join(options.cacheDir, selected.manifest.version, selected.asset.sha256);
    await mkdir(directory, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(10 * 60_000)]);
    try {
      const response = await options.fetch(selected.asset.url, { signal });
      if (!response.ok || !response.body) throw new Error(`更新下载失败：HTTP ${response.status}`);
      const declared = response.headers.get("content-length");
      if (declared !== null && Number(declared) !== selected.asset.size)
        throw new Error("更新安装器大小不匹配");
      let transferred = 0;
      let lastPercent = -1;
      const hash = createHash("sha256");
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          transferred += chunk.length;
          if (transferred > selected.asset.size) {
            callback(new Error("更新安装器超过清单大小限制"));
            return;
          }
          hash.update(chunk);
          const percent = Math.floor((transferred / selected.asset.size) * 100);
          if (percent !== lastPercent) {
            lastPercent = percent;
            publish({
              kind: "download-progress",
              enabled,
              version: selected.manifest.version,
              progress: `${percent}%`,
              transferredBytes: transferred,
              totalBytes: selected.asset.size,
            });
          }
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as never),
        meter,
        createWriteStream(temporary, { mode: 0o600 }),
        { signal },
      );
      if (transferred !== selected.asset.size || hash.digest("hex") !== selected.asset.sha256)
        throw new Error("更新安装器 SHA-256 或大小校验失败");
      lifetime.signal.throwIfAborted();
      await rm(path, { force: true });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  function runInstall(download: boolean): Promise<UpdateCheckResultPayload> {
    if (downloadFlight) return downloadFlight;
    if (!enabled || lifetime.signal.aborted)
      return Promise.resolve({ kind: "error", message: "当前环境不支持 GitHub 更新" });
    downloadFlight = (async (): Promise<UpdateCheckResultPayload> => {
      try {
        if (checkFlight) await checkFlight;
        if (!candidate) return { kind: "error", message: "请先检查并选择可用更新" };
        const selected = candidate;
        if (download) {
          publish({
            kind: "download-progress",
            enabled,
            version: selected.manifest.version,
            progress: "0%",
            transferredBytes: 0,
            totalBytes: selected.asset.size,
          });
          await downloadInstaller(selected);
        }
        return await openVerified(selected);
      } catch (error) {
        return failure(error);
      }
    })().finally(() => {
      downloadFlight = undefined;
    });
    return downloadFlight;
  }

  return {
    getState: () => ({ ...state }),
    checkForUpdates,
    downloadUpdate: () => runInstall(true),
    installUpdate: () => runInstall(false),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      if (started || lifetime.signal.aborted || !enabled) return;
      started = true;
      void checkForUpdates(false);
      timer = setInterval(() => {
        void checkForUpdates(false);
      }, UPDATE_INTERVAL_MS);
      timer.unref();
    },
    dispose() {
      lifetime.abort(new Error("更新服务已关闭"));
      if (timer) clearInterval(timer);
      listeners.clear();
    },
  };
}
