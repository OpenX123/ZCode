import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  ServiceChannels,
  parseSourceServerCacheRecovery,
  type SourceServerManagementSnapshot,
  type SourceServerOperationLog,
} from "@zcode/shared";
import { TID_SSH_ERROR } from "@zcode/shared/test-ids";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { callHandoffHost, installHandoffRpcProbe } from "#e2e/helpers/remote-project-handoff-probe";
import {
  createCacheRecoveryArchiveB,
  createSourceServerCacheLockRecoveryFixture,
} from "#e2e/helpers/source-server-cache-lock-recovery-fixture";
import {
  assertCacheRecoveryPackagedAgentProof,
  explorerShowsExactCacheRecoveryFolder,
  installCacheRecoveryNativeObservers,
  readCacheRecoveryNativeOpen,
  requestCacheRecoveryProductQuit,
  setSyntheticCacheRecoveryPassword,
} from "#e2e/helpers/cache-recovery-native-observers";
import {
  clickLastEnabledSSHDialogButton,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  prepareSSHConnectionPage,
  readSSHRuntimeConfig,
  runSSHCommand,
  waitForSSHDirectoryStep,
} from "#e2e/helpers/ssh-remote-p0";
import { uploadSSHFixtureFile } from "#e2e/helpers/ssh-version-policy-fixture";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const MARKER = "E2E_SOURCE_SERVER_CACHE_LOCK_RECOVERY";
const ERROR_CODE = "source-server-cache-lock-interrupted";
const scenario = process.env.ZCODE_TASK16_SCENARIO;
const artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR;
const facts: Record<string, unknown> = { scenario };

async function clickVisible(label: string, scope = "body") {
  await browser.waitUntil(
    () =>
      browser.execute(
        (text, root) => {
          const button = [
            ...(document.querySelector(root)?.querySelectorAll<HTMLButtonElement>("button") ?? []),
          ].find(
            (candidate) =>
              candidate.getClientRects().length > 0 &&
              !candidate.disabled &&
              candidate.textContent?.trim() === text,
          );
          if (!button) return false;
          button.click();
          return true;
        },
        label,
        scope,
      ),
    { timeout: 30_000, timeoutMsg: `${MARKER}: 真实按钮不可用（${label}）` },
  );
}

async function waitForLockFailure() {
  await browser.waitUntil(
    async () => {
      const confirmation = await browser.execute(() => {
        const button = document.querySelector<HTMLButtonElement>(
          '[data-testid="confirm-dialog-confirm"]',
        );
        if (!button?.getClientRects().length || button.disabled) return false;
        const intent = button.closest<HTMLElement>("[data-confirm-intent]")?.dataset.confirmIntent;
        if (!["source-server-install", "source-server-boundary"].includes(intent ?? ""))
          throw new Error("非预期确认");
        button.click();
        return true;
      });
      if (confirmation) return false;
      // 安装确认已移入当前连接步骤；沿既有 ssh helper 的精确文案执行真实
      // WebDriver 点击，不能只等待旧 ConfirmDialog 而一直停在 install-required。
      for (const button of await $$('[data-testid="ssh-dialog"] button')) {
        if (
          ["安装并继续", "Install and continue"].includes((await button.getText()).trim()) &&
          (await button.isDisplayed()) &&
          (await button.isEnabled())
        ) {
          await button.click();
          facts.inlineInstallAdmissionClicked = true;
          return false;
        }
      }
      return browser.execute(() =>
        [...document.querySelectorAll("button")].some(
          (button) =>
            button.getClientRects().length > 0 && button.textContent?.trim() === "定位本机锁文件夹",
        ),
      );
    },
    { timeout: 120_000, interval: 200, timeoutMsg: `${MARKER}: 真实 resolver 没有进入锁恢复错误` },
  );
}

async function openConnection(
  config: ReturnType<typeof readSSHRuntimeConfig>,
  entry: "settings" | "project",
) {
  await openSSHRemoteDialog(MARKER, { entry });
  await fillSSHPasswordSettings(config);
  await clickLastEnabledSSHDialogButton(MARKER);
}

async function readConfirmationResults(file: string) {
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { result: number; nativeDialogReturned: boolean });
}

async function readArchiveDownloadCount(fileName: string): Promise<number> {
  const base = process.env.ZCODE_REMOTE_ASSET_CDN_BASE_URL;
  if (!base || new URL(base).hostname !== "127.0.0.1")
    throw new Error("缺少本轮loopback资源计数器");
  const response = await fetch(new URL("/__task16__/counts", base), {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("本轮资源计数器不可用");
  return Number(((await response.json()) as Record<string, number>)[fileName] ?? 0);
}

async function readSettingsRecoveryDiagnostics(snapshot: SourceServerManagementSnapshot) {
  const failed = snapshot.states.find((state) => state.errorCode === ERROR_CODE);
  const profile = snapshot.profiles.find((item) => item.profileId === failed?.profileId);
  const server = snapshot.servers.find((item) => item.sourceServerId === profile?.sourceServerId);
  const profiles = snapshot.profiles.filter(
    (item) => item.sourceServerId === profile?.sourceServerId && item.lifecycleState !== "retired",
  );
  const displayed =
    profiles.find((item) =>
      snapshot.states.some(
        (state) => state.profileId === item.profileId && state.state === "online",
      ),
    ) ??
    profiles.find((item) => item.profileId === server?.preferredProfileId) ??
    profiles[0];
  const metadata = failed?.cacheRecovery;
  const strict = parseSourceServerCacheRecovery(failed?.errorCode, metadata);
  return {
    failureOwnerPresent: Boolean(failed && profile),
    singleProfileDevice: profiles.length === 1,
    displayedProfileMatchesFailureOwner: Boolean(
      failed && displayed?.profileId === failed.profileId,
    ),
    strictMetadata: {
      valid: Boolean(strict),
      object: Boolean(metadata && typeof metadata === "object"),
      kindString: typeof metadata?.kind === "string",
      kindMatches: metadata?.kind === "source-server-cache-lock",
      versionString: typeof metadata?.version === "string",
      versionMatches: metadata?.version === "1.4.0",
      targetString: typeof metadata?.target === "string",
      targetMatches: metadata?.target === "linux-x64",
      sha256String: typeof metadata?.sha256 === "string",
      sha256Pattern:
        typeof metadata?.sha256 === "string" && /^[a-f0-9]{64}$/u.test(metadata.sha256),
    },
    page: await browser.execute((sourceServerId) => {
      const page = document.querySelector('[data-testid="settings-page"]');
      const card = [
        ...(page?.querySelectorAll<HTMLElement>("[data-source-server-card]") ?? []),
      ].find((item) => item.dataset.sourceServerCard === sourceServerId);
      const button = [...(page?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
        (item) => item.textContent?.trim() === "查看详情",
      );
      const rect = button?.getBoundingClientRect();
      const hit = rect
        ? document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        : null;
      return {
        settingsPageExists: Boolean(page),
        settingsPageVisible: Boolean(page?.getClientRects().length),
        failureOwnerCardExists: Boolean(card),
        failureOwnerCardVisible: Boolean(card?.getClientRects().length),
        expectedLabelExists: Boolean(button),
        expectedLabelVisible: Boolean(button?.getClientRects().length),
        expectedLabelEnabled: Boolean(button && !button.disabled),
        expectedLabelBelongsToFailureCard: Boolean(button && card?.contains(button)),
        expectedLabelCenterUnobscured: Boolean(button && hit && button.contains(hit)),
      };
    }, profile?.sourceServerId ?? null),
  };
}

describe(`${MARKER}: packaged 缓存锁真实恢复`, () => {
  after(async () => {
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      await writeFile(
        join(artifacts, "cache-lock-recovery-facts.json"),
        JSON.stringify(facts, null, 2),
      );
    }
  });
  it("CACHE-RECOVERY-01/02/03 当前错误精确打开，正常退出归零后清A并原入口重试", async function () {
    this.timeout(20 * 60_000);
    if (process.platform !== "win32" || !["install", "wizard", "settings"].includes(scenario ?? ""))
      throw new Error("必须显式选择Windows合成场景");
    const releaseRoot = process.env.ZCODE_TASK16_RELEASE_ROOT;
    const cacheRoot = process.env.ZCODE_REMOTE_ASSET_CACHE_DIR;
    if (!releaseRoot || !cacheRoot || !artifacts || !process.env.ZCODE_E2E_PACKAGED_APP_PATH)
      throw new Error("缺少隔离packaged fixture");
    // 生产 Windows fuse 会拒绝 WDIO 的 inspector 参数。before hook 的失败不阻止
    // WDIO 继续调度正文，因此必须先严格探测 Main，不能先创建锁或修改合成密码。
    const identity = await browser.electron.execute((electron) => ({
      packaged: electron.app.isPackaged,
      protocolGuard: (
        globalThis as typeof globalThis & {
          __task16ProtocolGuard?: { suppressed: number; restored: boolean };
        }
      ).__task16ProtocolGuard,
      userData: electron.app.getPath("userData"),
    }));
    expect(identity.packaged).toBe(true);
    expect(identity.protocolGuard).toEqual({ suppressed: 1, restored: true });
    facts.packaged = true;
    facts.protocolGuard = identity.protocolGuard;
    await browser.waitUntil(
      async () => {
        facts.bridges = await browser.execute(() => {
          const bridge = window as unknown as Record<string, { getState?: unknown }>;
          return {
            tabs: typeof bridge.__zcodeTabStoreE2E?.getState === "function",
            sessions: typeof bridge.__zcodeSessionStoreE2E?.getState === "function",
            actions: Boolean(bridge.__testActions),
          };
        });
        const bridges = facts.bridges as { tabs: boolean; sessions: boolean; actions: boolean };
        return bridges.tabs && bridges.sessions && bridges.actions;
      },
      { timeout: 30_000, timeoutMsg: `${MARKER}: fixture 写入前 Renderer bridge 未就绪` },
    );
    expect(facts.bridges).toEqual({ tabs: true, sessions: true, actions: true });
    await writeFile(join(artifacts, "bridge-ready.json"), JSON.stringify(facts, null, 2));
    await prepareV4ConversationE2E();
    // 草稿readiness并不创建stdio会话；真实本地回放完成后才能将协议证据与当前Agent绑定。
    await sendV4Prompt(`${MARKER}_AGENT_PROOF 请返回本轮随包Agent会话准入标记。`);
    await waitForV4TimelineContaining("CACHE_RECOVERY_AGENT_PROVEN");
    await waitForV4Pane((state) => !state.canStop, "Agent准入准备任务没有完成");
    facts.packagedAgentProof = await assertCacheRecoveryPackagedAgentProof(artifacts);
    const originalConfig = readSSHRuntimeConfig(MARKER);
    const probe = await runSSHCommand(originalConfig, "uname -s; uname -m");
    if (probe.code !== 0) throw new Error("真实SSH probe失败");
    const target =
      probe.stdout.includes("Linux") && probe.stdout.includes("x86_64") ? "linux-x64" : null;
    if (!target) throw new Error("本次合成环境target不匹配");
    const descriptor = JSON.parse(
      await readFile(join(releaseRoot, "source-server-release.json"), "utf8"),
    );
    const archive = descriptor.archives.find((item: { target: string }) => item.target === target);
    if (!archive) throw new Error("真实target缺少本轮archive");
    const archiveB = await createCacheRecoveryArchiveB({
      archiveA: join(releaseRoot, archive.fileName),
      artifactDir: artifacts,
      ...(scenario === "wizard" ? { oldVersion: "1.3.9" } : {}),
    });
    if (scenario === "wizard") {
      const remoteArchive = "/home/zcodee2e/cache-recovery-b.tar.gz";
      await uploadSSHFixtureFile(originalConfig, archiveB, remoteArchive);
      const result = await runSSHCommand(
        originalConfig,
        `"$HOME/.zcode/server/bin/zcode" update --from-archive '${remoteArchive}' --force --json`,
        { timeoutMs: 180_000 },
      );
      if (result.code !== 0) throw new Error("真实旧版本元数据runtime准备失败");
      facts.realOldRuntimePrepared = true;
    } else if (scenario === "install") {
      const absent = await runSSHCommand(
        originalConfig,
        '[ ! -x "$HOME/.zcode/server/bin/zcode" ]',
      );
      if (absent.code !== 0) throw new Error("首装场景需要干净的合成server目标");
    }
    const fixture = await createSourceServerCacheLockRecoveryFixture({
      cacheRoot,
      releaseRoot,
      archiveB,
      target,
      marker: scenario === "wizard" ? "aged-empty-reaper" : "exited-reaper",
    });
    const secret = scenario === "wizard" ? target : fixture.aSha;
    const config = { ...originalConfig, password: secret };
    const downloadsBefore = await readArchiveDownloadCount(archive.fileName);
    let clipboardSaved = false;
    try {
      await setSyntheticCacheRecoveryPassword(secret);
      const confirmations = join(artifacts, "native-confirmations.jsonl");
      await installCacheRecoveryNativeObservers(fixture.aParent, confirmations);
      if (scenario === "settings") {
        await sendV4Prompt(`${MARKER}_SLOW 保持运行，等待用户明确退出。`);
        await waitForV4TimelineContaining("CACHE_RECOVERY_STREAMING");
        await waitForV4Pane((state) => state.canStop, "退出确认准备任务没有运行");
      }
      await installHandoffRpcProbe();
      await openConnection(config, scenario === "settings" ? "settings" : "project");
      if (scenario === "settings") {
        await waitForSSHDirectoryStep(MARKER, 180_000, { allowBoundaryAcknowledgement: true });
        const online = await callHandoffHost<SourceServerManagementSnapshot>(
          ServiceChannels.SourceServerManagement,
          "getSnapshot",
        );
        const state = online.states.find((item) => item.state === "online");
        if (!state) throw new Error("Settings bootstrap前没有真实online状态");
        facts.settingsOnlineBeforeBootstrap = true;
        let bootstrapFailed = false;
        try {
          await callHandoffHost(ServiceChannels.SourceServerManagement, "updateSource", [
            { profileId: state.profileId, force: false },
          ]);
        } catch (error) {
          bootstrapFailed =
            (error as { code?: string }).code === ERROR_CODE || String(error).includes("缓存锁");
        }
        if (!bootstrapFailed) throw new Error("公开RPC故障准备没有返回真实锁失败");
        facts.settingsRpcBootstrapOnly = true;
        facts.settingsEntryDiagnostics = await readSettingsRecoveryDiagnostics(
          await callHandoffHost<SourceServerManagementSnapshot>(
            ServiceChannels.SourceServerManagement,
            "getSnapshot",
          ),
        );
        // 原候选精确匹配“详情”，但现有i18n动作是“查看详情”；保留scope与严格全文匹配。
        await clickVisible("查看详情", "[data-testid='settings-page']");
        await clickVisible("重试", "[role='dialog']");
        await browser.keys("Escape");
        await clickVisible("查看详情", "#zcode-toast-host");
        facts.settingsComponentRetryToastDetails = true;
      } else if (scenario === "wizard") {
        // 旧版连接自动尝试更新；可信锁错把主动作投影为“重试”，仍直达原update链。
        // 先记录真实首次失败，再核实点击后产生新的update日志，不能把旧错误当新动作完成。
        await waitForLockFailure();
        const initial = await callHandoffHost<SourceServerManagementSnapshot>(
          ServiceChannels.SourceServerManagement,
          "getSnapshot",
        );
        const profileId = initial.states.find((item) => item.errorCode === ERROR_CODE)?.profileId;
        if (!profileId) throw new Error("向导自动升级没有产生真实锁失败");
        const before = await callHandoffHost<SourceServerOperationLog[]>(
          ServiceChannels.SourceServerManagement,
          "getRecentOperationLogs",
          [profileId],
        );
        const latestTimestamp = before.at(-1)?.timestamp;
        if (latestTimestamp === undefined) throw new Error("向导首次更新没有真实操作日志");
        await clickVisible("重试", "[data-testid='ssh-dialog']");
        await browser.waitUntil(
          async () => {
            const logs = await callHandoffHost<SourceServerOperationLog[]>(
              ServiceChannels.SourceServerManagement,
              "getRecentOperationLogs",
              [profileId],
            );
            return logs.some(
              (entry) => entry.operation === "update" && entry.timestamp > latestTimestamp,
            );
          },
          { timeout: 30_000, timeoutMsg: "向导原重试没有执行新的真实update操作" },
        );
        facts.wizardOriginalRetryExecutedUpdate = true;
      }
      await waitForLockFailure();
      const failedSnapshot = await callHandoffHost<SourceServerManagementSnapshot>(
        ServiceChannels.SourceServerManagement,
        "getSnapshot",
      );
      const actualFailure = failedSnapshot.states.find((item) => item.errorCode === ERROR_CODE);
      const recovery = actualFailure?.cacheRecovery;
      if (
        !recovery ||
        recovery.kind !== "source-server-cache-lock" ||
        recovery.target !== fixture.target ||
        recovery.version !== fixture.version ||
        recovery.sha256 !== fixture.aSha
      ) {
        throw new Error("真实Host锁恢复locator与本轮A不一致");
      }
      facts.realHostLocatorMatchesA = true;
      const operationLogs = await callHandoffHost<unknown[]>(
        ServiceChannels.SourceServerManagement,
        "getRecentOperationLogs",
        [actualFailure.profileId],
      );
      if (
        !operationLogs.length ||
        JSON.stringify(operationLogs).includes(secret) ||
        actualFailure.error?.includes(secret)
      ) {
        throw new Error("真实Host操作日志为空或泄漏合成碰撞秘密");
      }
      facts.realHostOperationLogsRedacted = true;
      if (scenario === "settings") {
        expect(actualFailure?.state).toBe("online");
        facts.settingsFailedUpdateKeptRealOnlineConnection = true;
      }
      const visible = await browser.execute(() => document.body.innerText);
      if (visible.includes(secret)) throw new Error("当前错误正文泄漏了合成碰撞秘密");
      facts.secretCollisionRedacted = true;
      await fixture.assertOriginalLocks();
      expect(await readArchiveDownloadCount(archive.fileName)).toBe(downloadsBefore);
      facts.noArchiveFetchWhileLockFailed = true;
      await clickVisible("定位本机锁文件夹");
      await browser.waitUntil(async () => (await readCacheRecoveryNativeOpen()).openedExact, {
        timeout: 15_000,
        timeoutMsg: "Main未原生打开精确A目录",
      });
      facts.mainOpenedExactA = await readCacheRecoveryNativeOpen();
      await browser.waitUntil(() => explorerShowsExactCacheRecoveryFolder(fixture.aParent), {
        timeout: 15_000,
        timeoutMsg: "系统Explorer未实际打开精确A目录",
      });
      facts.systemExplorerExactA = true;
      // 旧clipboard只保留在Main内存，不经测试日志返回；退出前恢复。
      await browser.electron.execute((electron) => {
        (globalThis as typeof globalThis & { __task16Clipboard?: string }).__task16Clipboard =
          electron.clipboard.readText();
      });
      clipboardSaved = true;
      await clickVisible("复制操作步骤");
      const steps = await browser.electron.execute((electron) => electron.clipboard.readText());
      if (
        steps.includes(secret) ||
        !steps.includes("保存工作") ||
        !steps.includes("取消退出确认") ||
        !steps.includes(".tar.gz.lock") ||
        !steps.includes("原入口显式重试")
      )
        throw new Error("固定安全步骤不完整或泄漏秘密");
      facts.fixedStepsSafe = true;
      const savedWork = join(artifacts, "saved-fixture-work.txt");
      await writeFile(savedWork, `${MARKER}: 已保存本轮合成工作\n`);
      facts.savedWork = createHash("sha256")
        .update(await readFile(savedWork))
        .digest("hex");
      await fixture.assertOriginalLocks();
      await browser.electron.execute((electron) => {
        const target = globalThis as typeof globalThis & { __task16Clipboard?: string };
        electron.clipboard.writeText(target.__task16Clipboard ?? "");
        delete target.__task16Clipboard;
      });
      clipboardSaved = false;
      if (scenario === "settings") {
        await writeFile(join(artifacts, "ready-cancel.json"), JSON.stringify({ ready: true }));
        await requestCacheRecoveryProductQuit();
        await browser.waitUntil(
          async () => (await readConfirmationResults(confirmations)).length === 1,
          { timeout: 120_000, timeoutMsg: "等待真实Computer Use取消退出确认" },
        );
        expect((await readConfirmationResults(confirmations))[0]).toEqual({
          result: 1,
          nativeDialogReturned: true,
        });
        await fixture.assertOriginalLocks();
        facts.nativeQuitCancelledWithLockUnchanged = true;
      }
      let fallbackCount = 0;
      const restartedProfile = await reloadElectronSessionPreservingBrowserProfile(browser, {
        requestAppQuit: async () => {
          if (scenario === "settings")
            await writeFile(join(artifacts, "ready-confirm.json"), JSON.stringify({ ready: true }));
          await requestCacheRecoveryProductQuit();
          if (scenario === "settings") {
            const deadline = Date.now() + 120_000;
            while (
              (await readConfirmationResults(confirmations)).length < 2 &&
              Date.now() < deadline
            )
              await delay(100);
            expect((await readConfirmationResults(confirmations))[1]).toEqual({
              result: 0,
              nativeDialogReturned: true,
            });
          }
        },
        cleanupTimedOutProcessTreePids: () => {
          fallbackCount += 1;
          throw new Error("正常产品退出不允许helper强杀fallback");
        },
        afterElectronProcessExit: async () => {
          facts.oldCompleteProcessTreeZero = true;
          await fixture.removeExactALockAfterExit();
          facts.exactALockRemovedAfterExit = true;
        },
      });
      expect(fallbackCount).toBe(0);
      facts.helperFallbackCount = fallbackCount;
      expect(restartedProfile).toBe(identity.userData);
      facts.sameProfile = true;
      // 重启创建了新的 Renderer/MessagePort；重新安装只读 probe，避免后续失败丢失真实Host快照。
      await installHandoffRpcProbe();
      facts.restartedReadOnlyProbeReady = true;
      await prepareSSHConnectionPage(MARKER);
      await openConnection(config, scenario === "settings" ? "settings" : "project");
      const directoryDeadline = Date.now() + 180_000;
      if (scenario === "wizard") {
        // 自动升级时旧错误容器仍可显示“更新中”；通用目录helper会将其误判为终态失败。
        // 先等同profile真实Host在线，再消费原180秒期限的剩余预算，不增加等待或改产品状态。
        let terminalFailure: string | undefined;
        await browser.waitUntil(
          async () => {
            const snapshot = await callHandoffHost<SourceServerManagementSnapshot>(
              ServiceChannels.SourceServerManagement,
              "getSnapshot",
            );
            const state = snapshot.states.find(
              (entry) => entry.profileId === actualFailure.profileId,
            );
            if (!state) return false;
            if (
              !["bootstrapping", "updating", "retrying"].includes(state.state) &&
              (state.state === "failed" ||
                state.state === "identity-change-pending" ||
                state.state === "needs-install" ||
                state.upgradeTarget === "controller" ||
                (state.errorCode && state.errorCode !== "source-server-upgrade-required"))
            ) {
              terminalFailure = `${state.state}/${state.errorCode ?? "no-public-code"}`;
              return true;
            }
            if (state.state !== "online") return false;
            // Host在线可先于React最后一帧；同时等旧错误容器不可见，再交还原目录UI验证。
            return browser.execute((errorId) => {
              const error = document.querySelector(`[data-testid="${errorId}"]`);
              return !error?.getClientRects().length;
            }, TID_SSH_ERROR);
          },
          { timeout: 180_000, timeoutMsg: "向导原入口重连未完成真实Host升级并在线" },
        );
        if (terminalFailure) throw new Error(`向导原入口重连终态失败：${terminalFailure}`);
        facts.wizardReconnectedHostOnline = true;
        facts.wizardTransientErrorGone = true;
      }
      await waitForSSHDirectoryStep(MARKER, Math.max(1, directoryDeadline - Date.now()), {
        allowBoundaryAcknowledgement: true,
      });
      if (scenario !== "settings") {
        await fixture.assertRecoveredArchive();
        expect(await readArchiveDownloadCount(archive.fileName)).toBeGreaterThan(downloadsBefore);
        facts.recoveredArchiveA = true;
      } else {
        // 当前等版在线设备重启后无更新按钮；这里只计原连接成功与旧临时locator失效，
        // A真实下载/安装的退出后恢复由首装及向导场景证明，不拿等版重连冒充下载。
        await fixture.assertBAndSourceUnchanged();
        facts.settingsAfterRestart = "equal-version-reconnect-only-no-update-button";
      }
      expect(
        await browser.execute(() =>
          [...document.querySelectorAll("button")].some(
            (button) => button.textContent?.trim() === "定位本机锁文件夹",
          ),
        ),
      ).toBe(false);
      facts.bAndSourceUnchanged = true;
      facts.oldLocatorGone = true;
    } catch (error) {
      try {
        const snapshot = await callHandoffHost<SourceServerManagementSnapshot>(
          ServiceChannels.SourceServerManagement,
          "getSnapshot",
        );
        facts.lastFailureSnapshot = snapshot.states.map((state) => ({
          state: state.state,
          errorCode: state.errorCode,
          retryable: state.retryable,
          hasCacheRecovery: Boolean(state.cacheRecovery),
          hasInstallPreview: Boolean(state.installPreview),
        }));
        if (scenario === "settings")
          facts.settingsFailureDiagnostics = await readSettingsRecoveryDiagnostics(snapshot);
      } catch {
        facts.failureSnapshotUnavailable = true;
      }
      throw error;
    } finally {
      if (clipboardSaved)
        await browser.electron
          .execute((electron) => {
            const target = globalThis as typeof globalThis & { __task16Clipboard?: string };
            electron.clipboard.writeText(target.__task16Clipboard ?? "");
            delete target.__task16Clipboard;
          })
          .catch(() => {
            facts.clipboardRestoreFailed = true;
          });
      await setSyntheticCacheRecoveryPassword(originalConfig.password);
    }
  });
});
