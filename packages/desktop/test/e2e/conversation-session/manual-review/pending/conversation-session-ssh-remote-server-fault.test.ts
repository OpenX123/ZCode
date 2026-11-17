import { mkdir, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  listRemoteZCodeServerPids,
  listRemoteAgentProcesses,
  prepareSSHLifecycle,
  readRemoteCoreIdentity,
  readTaskRowInProject,
  sendSSHFollowTurn,
  stopOwnedSSHServer,
  waitForRemoteWorkspaceFaultSettled,
  type SSHLifecycleProvider,
  type SSHLifecycleTask,
} from "../../../helpers/ssh-remote-lifecycle.js";
import {
  readHostProcesses,
  readRemoteTabSnapshot,
  runSSHCommand,
  waitForRemoteTab,
} from "../../../helpers/ssh-remote-p0.js";
import {
  assertSSHReconnectOrder,
  installSSHReconnectObservation,
  readSSHReconnectObservation,
  restoreSSHReconnectObservation,
} from "../../../helpers/ssh-reconnect-observation.js";

const CASE_MARKER = "E2E_SSH_P0_SERVER_FAULT";

describe(`${CASE_MARKER}: SSH zcode-server fault and grouped reconnect`, () => {
  let provider: SSHLifecycleProvider | null = null;
  const facts: Record<string, unknown> = { manualReconnectActions: 0 };

  after(async () => {
    try {
      facts.events = await readSSHReconnectObservation();
      const artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR;
      if (!artifacts) throw new Error(`${CASE_MARKER}: 缺少本轮artifact根`);
      await mkdir(artifacts, { recursive: true });
      await writeFile(
        resolve(artifacts, "ssh-auto-reconnect.json"),
        JSON.stringify(facts, null, 2),
      );
    } finally {
      await restoreSSHReconnectObservation();
    }
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SSH-P0-LIFE-02 只终止本 case 新建的 zcode-server 后，无手动重连自动恢复 A/B", async function () {
    this.timeout(35 * 60_000);
    const prepared = await prepareSSHLifecycle(CASE_MARKER);
    provider = prepared.provider;
    const runtime = await installSSHReconnectObservation(prepared.initialHosts[0]!.pid);
    facts.runtime = runtime;
    const executable = process.env.ZCODE_E2E_PACKAGED_APP_PATH;
    if (!executable) throw new Error(`${CASE_MARKER}: 必须使用本轮冻结包`);
    expect((await realpath(runtime.mainExecutable)).toLowerCase()).toBe(
      (await realpath(executable)).toLowerCase(),
    );
    const [workspaceA, workspaceB] = prepared.config.workspacePaths;
    const serverPidsBefore = await listRemoteZCodeServerPids(prepared.config);
    facts.serverPidsBefore = serverPidsBefore;
    expect(serverPidsBefore).toHaveLength(0);
    const taskA = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "A",
      provider,
      workspacePath: workspaceA,
      captureProjectScope: true,
      completionStrategy: "origin-draft",
    });
    const taskB = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "B",
      provider,
      workspacePath: workspaceB,
      captureProjectScope: true,
    });
    if (!taskA.projectScope || !taskB.projectScope)
      throw new Error(`${CASE_MARKER}: A/B 缺少本次实际创建的项目身份`);
    const hostBeforeFault = await readHostProcesses();
    facts.hostBeforeFault = hostBeforeFault;
    facts.tasks = { A: taskA, B: taskB };
    facts.remoteCoreBeforeFault = await readRemoteCoreIdentity(prepared.config, CASE_MARKER);
    const remoteAgents = (await listRemoteAgentProcesses(prepared.config)).filter((agent) =>
      [workspaceA, workspaceB].includes(agent.cwd),
    );
    facts.remoteAgentsBeforeFault = remoteAgents;
    expect(remoteAgents.some((agent) => agent.cwd === workspaceA)).toBe(true);
    expect(remoteAgents.some((agent) => agent.cwd === workspaceB)).toBe(true);
    expect(await listRemoteZCodeServerPids(prepared.config)).toEqual(
      expect.arrayContaining(serverPidsBefore),
    );

    // 故障注入前先记下两个 tab 的 sessionId：只有和超时时的值对比，才能区分
    // "产品没检测到远端 server 挂了"和"产品已经自愈重连（换了新 session）"。
    const sessionsBeforeFault = {
      A: (await readRemoteTabSnapshot(taskA.identity).catch(() => null))?.remoteSessionId ?? null,
      B: (await readRemoteTabSnapshot(taskB.identity).catch(() => null))?.remoteSessionId ?? null,
    };
    expect(sessionsBeforeFault).toEqual({ A: taskA.remoteSessionId, B: taskB.remoteSessionId });
    facts.sessionsBeforeFault = sessionsBeforeFault;
    const beforeFaultEvents = await readSSHReconnectObservation();
    facts.eventsBeforeFault = beforeFaultEvents;
    for (const sessionId of [taskA.remoteSessionId, taskB.remoteSessionId]) {
      // 先证明被动观察已接上真实owner，不能在注入故障后才把空trace误报成产品缺陷。
      for (const kind of ["host-attach", "renderer-port", "renderer-ack", "main-promoted"])
        expect(
          beforeFaultEvents.some((event) => event.kind === kind && event.sessionId === sessionId),
        ).toBe(true);
    }
    const stoppedPid = await stopOwnedSSHServer(prepared.config, serverPidsBefore, CASE_MARKER);
    facts.fault = { stoppedPid, completedAt: new Date().toISOString() };
    const faultContext = async () => ({
      sessionsBeforeFault,
      remoteServerPids: await listRemoteZCodeServerPids(prepared.config).catch(
        () => "probe-failed",
      ),
      remoteServerStatus:
        (
          await runSSHCommand(
            prepared.config,
            'cat "$HOME/.zcode/server/run/status.json" 2>/dev/null | tr -d "\\n " | cut -c1-200',
          ).catch(() => null)
        )?.stdout.trim() ?? null,
    });
    const settledA = await waitForRemoteWorkspaceFaultSettled(
      taskA.identity,
      CASE_MARKER,
      sessionsBeforeFault.A,
      faultContext,
      { requireAutomatic: true },
    );
    const settledB = await waitForRemoteWorkspaceFaultSettled(
      taskB.identity,
      CASE_MARKER,
      sessionsBeforeFault.B,
      faultContext,
      { requireAutomatic: true },
    );

    // 原双路径case的manual fallback会掩盖自动attachment缺陷；本候选只认同轮自动换代。
    facts.settled = { A: settledA, B: settledB };
    expect(settledA).toBe("self-healed");
    expect(settledB).toBe("self-healed");
    const reconnectedA = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: taskA.identity,
      expectedPath: workspaceA,
      requireActive: false,
    });
    const reconnectedB = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: taskB.identity,
      expectedPath: workspaceB,
      requireActive: false,
    });
    expect(reconnectedA.remoteSessionId).not.toBe(taskA.remoteSessionId);
    expect(reconnectedB.remoteSessionId).not.toBe(taskB.remoteSessionId);
    expect(reconnectedA.remoteSessionId).not.toBe(reconnectedB.remoteSessionId);
    facts.sessionsAfterFault = { A: reconnectedA, B: reconnectedB };
    expect(await readHostProcesses()).toEqual(hostBeforeFault);
    const events = await readSSHReconnectObservation();
    facts.orderedReconnections = [
      assertSSHReconnectOrder(
        events,
        taskA.remoteSessionId,
        reconnectedA.remoteSessionId!,
        taskA.identity,
      ),
      assertSSHReconnectOrder(
        events,
        taskB.remoteSessionId,
        reconnectedB.remoteSessionId!,
        taskB.identity,
      ),
    ];
    // 恢复后仍停留远程项目；下方按 task identity 验证 A/B，不能等待从未切换的本地项目。

    const resumedA: SSHLifecycleTask = {
      ...taskA,
      remoteSessionId: reconnectedA.remoteSessionId!,
    };
    const resumedB: SSHLifecycleTask = {
      ...taskB,
      remoteSessionId: reconnectedB.remoteSessionId!,
    };
    await readTaskRowInProject(resumedA, CASE_MARKER);
    await readTaskRowInProject(resumedB, CASE_MARKER);
    await sendSSHFollowTurn(resumedB, CASE_MARKER, taskA.firstPrompt);
    await sendSSHFollowTurn(resumedA, CASE_MARKER, taskB.firstPrompt);
    await readTaskRowInProject(resumedA, CASE_MARKER);
    await readTaskRowInProject(resumedB, CASE_MARKER);
    facts.originalTasksAndFollowTurnsPassed = true;
  });
});
