import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { matchesGlob } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";

const workflow = parse(
  await readFile(new URL("../../.github/workflows/build.yml", import.meta.url), "utf8"),
);

function evaluate(expression, github) {
  return runInNewContext(expression.slice(3, -2), { github });
}

test("只有 main 手动运行允许分配正式版本并发布", () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ["pull_request", "push", "workflow_dispatch"]);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.deepEqual(workflow.on.pull_request.branches, ["main"]);
  assert.equal(workflow.on.push.tags, undefined);
  const allocation = workflow.jobs.resources.steps.find((step) => step.id === "identity");
  for (const [event, ref, expected] of [
    ["push", "refs/heads/main", false],
    ["push", "refs/tags/v1.0.7", false],
    ["pull_request", "refs/pull/1/merge", false],
    ["pull_request_target", "refs/heads/main", false],
    ["workflow_dispatch", "refs/heads/main", true],
    ["workflow_dispatch", "refs/heads/fix/ci", false],
    ["workflow_dispatch", "refs/tags/v1.0.7", false],
  ]) {
    const github = { event_name: event, ref };
    const label = `${event} ${ref}`;
    assert.equal(evaluate(allocation.env.YCODE_OFFICIAL_RELEASE, github), expected, label);
    assert.equal(evaluate(workflow.jobs.publish.if, github), expected, label);
  }
});

test("README 与截图独立或组合改动跳过构建，混入其他输入仍构建", () => {
  for (const event of ["push", "pull_request"]) {
    const trigger = workflow.on[event];
    assert.equal(trigger.paths, undefined);
    const ignored = trigger["paths-ignore"];
    assert.ok(Array.isArray(ignored), `${event} 必须配置路径过滤`);
    for (const [files, expected] of [
      [["README.md"], false],
      [["README.en.md"], false],
      [["docs/images/readme/workspace.png"], false],
      [["README.md", "README.en.md", "docs/images/readme/workspace.png"], false],
      [["README.md", "packages/ui/src/App.tsx"], true],
      [["README.md", ".github/workflows/build.yml"], true],
      [["docs/desktop/github-release-spec.md"], true],
      [["packages/desktop/resources/README.md"], true],
      [[".agents/skills/example/SKILL.md"], true],
      [["package.json", "pnpm-lock.yaml"], true],
    ]) {
      const builds = files.some((file) => !ignored.some((pattern) => matchesGlob(file, pattern)));
      assert.equal(builds, expected, `${event}: ${files.join(", ")}`);
    }
  }
  // 手动发版不受文件路径过滤影响，版本分配与发布仍由事件和 ref 决定。
  assert.equal(workflow.on.workflow_dispatch?.["paths-ignore"], undefined);
});

test("普通构建可取消旧运行，main 手动发版独立串行且不被普通 push 取消", () => {
  const group = (event) =>
    workflow.concurrency.group.replace(/\$\{\{\s*(.*?)\s*\}\}/gu, (_, expression) =>
      runInNewContext(expression, {
        github: { workflow: workflow.name, event_name: event, ref: "refs/heads/main" },
      }),
    );
  assert.notEqual(group("push"), group("workflow_dispatch"));
  for (const [event, ref, expected] of [
    ["push", "refs/heads/main", true],
    ["pull_request", "refs/pull/1/merge", true],
    ["workflow_dispatch", "refs/heads/fix/ci", true],
    ["workflow_dispatch", "refs/heads/main", false],
  ]) {
    assert.equal(
      evaluate(workflow.concurrency["cancel-in-progress"], { event_name: event, ref }),
      expected,
      `${event} ${ref}`,
    );
  }
});
