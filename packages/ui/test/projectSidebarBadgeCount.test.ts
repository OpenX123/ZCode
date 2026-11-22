import { describe, expect, it } from "vitest";
import type { ProjectTask, ProjectTree, VirtualProject } from "@/project-sidebar/contract.js";
import {
  badgeViewedTaskKey,
  countProjectTreeBadgeTasks,
  reconcileBadgeWaitingAcknowledgements,
  taskWaitingSignature,
} from "@/project-sidebar/view.js";
import { attachTaskListRowActivity } from "@/v4/taskListRowActivity.js";

const task = (id: string, overrides: Partial<ProjectTask> = {}): ProjectTask => ({
  taskId: id,
  projectId: "p1",
  hostId: "local",
  pinned: false,
  archived: false,
  workspacePath: "/repo",
  title: id,
  mode: "build",
  traceId: id,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const project = (id: string, deleted = false): VirtualProject => ({
  id,
  hostId: "local",
  name: id,
  nameOverridden: false,
  roots: [],
  position: 0,
  pinned: false,
  deleted,
  createdAt: 1,
  updatedAt: 1,
});

const tree = (tasks: ProjectTask[], projects = [project("p1")]): ProjectTree => ({
  projects,
  tasks,
});

const waiting = (id: string, interactionId: string, overrides: Partial<ProjectTask> = {}) =>
  task(id, {
    pendingInteraction: { interactionId, kind: "permission" },
    ...overrides,
  });

const viewed = (id: string, workspaceKey = "/repo") =>
  new Set([badgeViewedTaskKey(workspaceKey, id)]);

describe("角标计数：未读 ∪ 等待用户操作", () => {
  it("未读与等待分别计入，同一任务只计一次", () => {
    expect(
      countProjectTreeBadgeTasks(
        tree([
          task("done", { unreadAt: 1 }),
          waiting("ask", "i-1"),
          waiting("both", "i-2", { unreadAt: 2 }),
          task("idle"),
        ]),
      ),
    ).toBe(3);
  });

  it("sessions-index 活动摘要的审批/提问计数也视为等待", () => {
    const withActivity = attachTaskListRowActivity(task("live"), {
      phase: "running",
      lastActivityAt: 1,
      hasBackgroundWork: false,
      pendingInteractions: { permissionCount: 0, userInputCount: 1 },
    } as never);
    expect(taskWaitingSignature(withActivity)).toBe("attention:0:1");
    expect(countProjectTreeBadgeTasks(tree([withActivity]))).toBe(1);
  });

  it("归档、已删项目与孤儿任务不计入", () => {
    expect(
      countProjectTreeBadgeTasks(
        tree(
          [
            waiting("archived", "i-1", { archived: true }),
            waiting("deleted", "i-2", { projectId: "gone" }),
            waiting("orphan", "i-3", { projectId: "missing" }),
          ],
          [project("p1"), project("gone", true)],
        ),
      ),
    ).toBe(0);
  });

  it("打开（窗口查看中）后确认当前等待签名，不再计入", () => {
    const current = tree([waiting("ask", "i-1")]);
    const acknowledged = reconcileBadgeWaitingAcknowledgements({
      tree: current,
      previous: new Set(),
      viewed: viewed("ask"),
    });
    expect(countProjectTreeBadgeTasks(current, acknowledged)).toBe(0);
  });

  it("新的等待请求（签名变化）重新计入，旧确认被裁剪", () => {
    const first = tree([waiting("ask", "i-1")]);
    const acknowledged = reconcileBadgeWaitingAcknowledgements({
      tree: first,
      previous: new Set(),
      viewed: viewed("ask"),
    });
    const second = tree([waiting("ask", "i-2")]);
    const pruned = reconcileBadgeWaitingAcknowledgements({
      tree: second,
      previous: acknowledged,
      viewed: new Set(),
    });
    expect(pruned.size).toBe(0);
    expect(countProjectTreeBadgeTasks(second, pruned)).toBe(1);
  });

  it("未查看的窗口不产生确认；确认集合无变化时保持引用稳定", () => {
    const current = tree([waiting("ask", "i-1")]);
    const empty = new Set<string>();
    expect(
      reconcileBadgeWaitingAcknowledgements({ tree: current, previous: empty, viewed: new Set() }),
    ).toBe(empty);
  });

  it("确认不影响未读：未读任务仍计入直到 unreadAt 被清除", () => {
    const current = tree([waiting("ask", "i-1", { unreadAt: 5 })]);
    const acknowledged = reconcileBadgeWaitingAcknowledgements({
      tree: current,
      previous: new Set(),
      viewed: viewed("ask"),
    });
    expect(countProjectTreeBadgeTasks(current, acknowledged)).toBe(1);
  });

  it("远程任务按 workspace identity 匹配已查看 tab", () => {
    const remote = waiting("ask", "i-1", { workspaceIdentity: "remote://h/repo" });
    const current = tree([remote]);
    const acknowledged = reconcileBadgeWaitingAcknowledgements({
      tree: current,
      previous: new Set(),
      viewed: viewed("ask", "remote://h/repo"),
    });
    expect(countProjectTreeBadgeTasks(current, acknowledged)).toBe(0);
  });
});
