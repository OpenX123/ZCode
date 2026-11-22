import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { UpdateCheckResultPayload, UpdateStatePayload } from "@zcode/shared";
import type {
  GithubDesktopInstallMode,
  GithubDesktopUpdateContract,
  GithubDesktopUpdateOptions,
  GithubDesktopUpdatePreferences,
} from "./contract.js";
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

/** 发布矩阵外的平台只记录版本与 releaseUrl，绝不选择其他架构的安装器。 */
interface ManualCandidate {
  manifest: GithubUpdateManifest;
  asset: null;
}

function manualResult(manifest: GithubUpdateManifest): UpdateCheckResultPayload {
  return { kind: "manual-download", version: manifest.version, releaseUrl: manifest.releaseUrl };
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
  let candidate: Candidate | ManualCandidate | null = null;
  let checkFlight: Promise<UpdateCheckResultPayload> | undefined;
  let downloadFlight: Promise<UpdateCheckResultPayload> | undefined;
  let lastCheckAt: number | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let started = false;
  // 1.5.0：自动检查 / 自动下载偏好由 Main 从本机设置注入，缺省均开启。
  let preferences: GithubDesktopUpdatePreferences = {
    autoCheck: true,
    autoDownload: true,
    ...options.preferences,
  };
  // 退出时安装只交接一次；“重启以更新”取消后仍允许退出时安装。
  let quitHandoffDone = false;

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
    if (candidate && !candidate.asset) return manualResult(candidate.manifest);
    return candidate
      ? { kind: "available", version: candidate.manifest.version }
      : { kind: "up-to-date", currentVersion: options.currentVersion };
  }

  async function performCheck(): Promise<UpdateCheckResultPayload> {
    const previousState = state;
    publish({ kind: "checking", enabled });
    try {
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)]);
      const response = await options.fetch(GITHUB_UPDATE_MANIFEST_URL, {
        signal,
        cache: "no-store",
      });
      const manifest = parseGithubUpdateManifest(await readManifest(response, signal));
      lifetime.signal.throwIfAborted();
      if (!isNewerVersion(manifest.version, options.currentVersion)) {
        candidate = null;
        publish({ kind: "idle", enabled });
        return { kind: "up-to-date", currentVersion: options.currentVersion };
      }
      const asset = manifest.assets.find(
        (item) => item.platform === options.platform && item.arch === options.arch,
      );
      if (!asset) {
        // 原因：发布矩阵收敛为 darwin-arm64 / win32-x64 后，mac-x64 与 win-arm64 客户端
        // 曾把合法的两目标清单当作错误（“更新清单没有当前系统和架构的安装器”）。
        // 修复：沿用“发现新版”状态并标记仅可手动下载，由 UI 打开 releaseUrl，不下载其他架构。
        candidate = { manifest, asset: null };
        publish({
          kind: "update-available",
          enabled,
          version: manifest.version,
          manualDownload: true,
        });
        return manualResult(manifest);
      }
      const selected = { manifest, asset };
      const cached = await verifyInstaller(installerPath(selected), asset);
      lifetime.signal.throwIfAborted();
      candidate = selected;
      if (cached) {
        publish({ kind: "update-downloaded", enabled, version: manifest.version });
        return { kind: "ready", version: manifest.version };
      }
      publish({ kind: "update-available", enabled, version: manifest.version });
      return { kind: "available", version: manifest.version };
    } catch (error) {
      // 清单尚未发布或网络暂不可达不等于安装失败；保留已确认状态，手动调用方单独提示。
      publish(previousState);
      return { kind: "error", message: error instanceof Error ? error.message : String(error) };
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
    // 关闭“自动检查更新”后，启动/定时/唤醒检查都不请求网络；手动检查不受影响。
    if (!manual && !preferences.autoCheck) return Promise.resolve(currentResult());
    if (!manual && lastCheckAt !== undefined && now() - lastCheckAt < UPDATE_INTERVAL_MS)
      return Promise.resolve(currentResult());
    lastCheckAt = now();
    checkFlight = performCheck()
      .then((result) => {
        if (result.kind === "available") scheduleBackgroundDownload();
        return result;
      })
      .finally(() => {
        checkFlight = undefined;
      });
    return checkFlight;
  }

  /** 自动下载开启且有可自动安装的候选时，在后台下载并校验；失败不发布持久错误。 */
  function scheduleBackgroundDownload(): void {
    if (
      !preferences.autoDownload ||
      downloadFlight ||
      lifetime.signal.aborted ||
      state.kind !== "update-available" ||
      !candidate?.asset
    )
      return;
    void runDownload("background");
  }

  function installerPath(selected: Candidate): string {
    return join(
      options.cacheDir,
      selected.manifest.version,
      selected.asset.sha256,
      selected.asset.fileName,
    );
  }
  async function openVerified(
    selected: Candidate,
    mode: GithubDesktopInstallMode,
  ): Promise<UpdateCheckResultPayload> {
    const path = installerPath(selected);
    if (!(await verifyInstaller(path, selected.asset)))
      throw new Error("更新安装器缺失或校验失败，请重新下载");
    lifetime.signal.throwIfAborted();
    const message = await options.openInstaller(
      path,
      selected.manifest.version,
      lifetime.signal,
      mode,
    );
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

  /** 下载与安装共用同一 flight：重复点击只执行一次，检查不会覆盖进度。 */
  function runExclusive(
    task: (selected: Candidate) => Promise<UpdateCheckResultPayload>,
    onError: (error: unknown) => UpdateCheckResultPayload,
  ): Promise<UpdateCheckResultPayload> {
    if (downloadFlight) return downloadFlight;
    if (!enabled || lifetime.signal.aborted)
      return Promise.resolve({ kind: "error", message: "当前环境不支持 GitHub 更新" });
    downloadFlight = (async (): Promise<UpdateCheckResultPayload> => {
      try {
        if (checkFlight) await checkFlight;
        if (!candidate) return { kind: "error", message: "请先检查并选择可用更新" };
        // 发布矩阵外的平台没有可校验的安装器，只返回手动下载结果，不改变状态。
        if (!candidate.asset) return manualResult(candidate.manifest);
        return await task(candidate);
      } catch (error) {
        return onError(error);
      }
    })().finally(() => {
      downloadFlight = undefined;
    });
    return downloadFlight;
  }

  /** 下载并校验，完成后为 update-downloaded（“重启以更新”）；不打开安装器。 */
  function runDownload(origin: "user" | "background"): Promise<UpdateCheckResultPayload> {
    return runExclusive(
      async (selected) => {
        publish({
          kind: "download-progress",
          enabled,
          version: selected.manifest.version,
          progress: "0%",
          transferredBytes: 0,
          totalBytes: selected.asset.size,
        });
        await downloadInstaller(selected);
        lifetime.signal.throwIfAborted();
        publish({ kind: "update-downloaded", enabled, version: selected.manifest.version });
        return { kind: "ready", version: selected.manifest.version };
      },
      (error) => {
        if (origin === "user" || lifetime.signal.aborted) return failure(error);
        // 后台下载失败不是用户操作失败：恢复“发现新版”，由用户手动下载或下一轮检查重试。
        const message = error instanceof Error ? error.message : String(error);
        if (candidate)
          publish({ kind: "update-available", enabled, version: candidate.manifest.version });
        return { kind: "error", message };
      },
    );
  }

  async function installOnQuit(): Promise<boolean> {
    if (!enabled || lifetime.signal.aborted || quitHandoffDone || downloadFlight) return false;
    if (state.kind !== "update-downloaded" || !candidate?.asset) return false;
    const selected: Candidate = candidate;
    try {
      const path = installerPath(selected);
      // 交接前重新校验；缓存缺失或损坏时照常退出，不启动安装器。
      if (!(await verifyInstaller(path, selected.asset))) return false;
      lifetime.signal.throwIfAborted();
      const message = await options.openInstaller(
        path,
        selected.manifest.version,
        lifetime.signal,
        "quit",
      );
      if (message) return false;
      quitHandoffDone = true;
      return true;
    } catch {
      return false;
    }
  }

  function startTimer(): void {
    if (timer) return;
    timer = setInterval(() => {
      void checkForUpdates(false);
    }, UPDATE_INTERVAL_MS);
    timer.unref();
  }

  return {
    getState: () => ({ ...state }),
    checkForUpdates,
    downloadUpdate: () => runDownload("user"),
    installUpdate: () => runExclusive((selected) => openVerified(selected, "restart"), failure),
    installOnQuit,
    setPreferences(patch) {
      const previous = preferences;
      preferences = { ...preferences, ...patch };
      if (!started || lifetime.signal.aborted || !enabled) return;
      if (preferences.autoCheck && !previous.autoCheck) {
        startTimer();
        void checkForUpdates(false);
      }
      if (!preferences.autoCheck && timer) {
        clearInterval(timer);
        timer = undefined;
      }
      if (preferences.autoDownload && !previous.autoDownload) scheduleBackgroundDownload();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      if (started || lifetime.signal.aborted || !enabled) return;
      started = true;
      if (!preferences.autoCheck) return;
      void checkForUpdates(false);
      startTimer();
    },
    dispose() {
      lifetime.abort(new Error("更新服务已关闭"));
      if (timer) clearInterval(timer);
      listeners.clear();
    },
  };
}
