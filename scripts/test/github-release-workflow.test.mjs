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

async function readLocalWorkflow(platform) {
  return parse(
    await readFile(
      new URL(`../../.github/workflows/build-${platform}-local.yml`, import.meta.url),
      "utf8",
    ),
  );
}

function evaluateLocalGate(expression, github) {
  return runInNewContext(expression.slice(3, -2), {
    github,
    startsWith: (value, prefix) =>
      String(value).toLowerCase().startsWith(String(prefix).toLowerCase()),
  });
}

/** 两个本机 workflow 的共同合同：仅正式标签手动运行、只读权限、版本来自 package.json、无发布路径。 */
function verifyLocalJob(local, labels, command, artifactPaths) {
  assert.deepEqual(local.permissions, { contents: "read", actions: "read" });
  assert.deepEqual(Object.keys(local.jobs), ["build"]);
  const job = local.jobs.build;
  assert.equal(job.permissions, undefined);
  assert.deepEqual(job["runs-on"], labels);
  for (const [event, ref, expected] of [
    ["workflow_dispatch", "refs/tags/v1.4.2", true],
    ["workflow_dispatch", "refs/heads/main", false],
    ["workflow_dispatch", "refs/heads/feature", false],
    ["workflow_dispatch", "refs/tags/build-1-1", false],
    ["push", "refs/tags/v1.4.2", false],
    ["pull_request", "refs/pull/1/merge", false],
  ])
    assert.equal(
      evaluateLocalGate(job.if, { event_name: event, ref }),
      expected,
      `${event} ${ref}`,
    );
  // 不再写死版本、标签或会过期的 source run。
  for (const key of ["RELEASE_VERSION", "RELEASE_TAG"]) assert.equal(job.env[key], undefined);
  const steps = job.steps;
  assert.equal(steps[0].uses, "actions/checkout@v7");
  assert.equal(steps[0].with["persist-credentials"], false);
  assert.equal(steps.find((step) => step.uses === "pnpm/action-setup@v6").with.version, "10.33.2");
  assert.equal(
    steps.find((step) => step.uses === "actions/setup-node@v7").with["node-version"],
    "24.14.0",
  );
  const identityIndex = steps.findIndex(
    (step) => step.run === "node scripts/github-release-version.mjs local-identity",
  );
  const installIndex = steps.findIndex((step) => step.run === "pnpm install --frozen-lockfile");
  assert.ok(identityIndex > 0 && identityIndex < installIndex);
  assert.ok(steps.some((step) => step.run === command));
  const uploads = steps.filter((step) => step.uses === "actions/upload-artifact@v7");
  assert.deepEqual(
    uploads.map((step) => step.with.path),
    artifactPaths,
  );
  assert.ok(uploads.every((step) => step.with["if-no-files-found"] === "error"));
  assert.ok(
    steps.every(
      (step) =>
        !/\b(?:allocate|reserve-tag|publish|release create|tag create|git push)\b/.test(
          step.run ?? "",
        ),
    ),
  );
  assert.ok(steps.every((step) => !step.run?.includes("${{")));
  return { job, steps };
}

test("Mac ARM64本机构建自行生成远程资源与descriptor，再按轻量模式打包且无发布路径", async () => {
  const local = await readLocalWorkflow("macos");
  assert.deepEqual(Object.keys(local.on), ["workflow_dispatch"]);
  const { job, steps } = verifyLocalJob(
    local,
    ["self-hosted", "macOS", "ARM64", "zcode-macos"],
    "pnpm bundle:desktop -- --os mac --arch arm64",
    [
      "release-resources/*",
      "release-resources/source-server-release.json",
      "packages/desktop/dist/*.dmg\npackages/desktop/dist/*.zip\n",
      "packages/desktop/dist/*.size-report.json",
    ],
  );
  // 资源生成不能处于轻量模式；只有打包步骤启用 descriptor-only。
  assert.equal(job.env.ZCODE_REMOTE_ASSET_DESCRIPTOR_ONLY, undefined);
  assert.ok(steps.every((step) => step.uses !== "actions/download-artifact@v8"));
  const order = [
    "pnpm prepare:remote-assets",
    "node scripts/github-release-assets.mjs pin --output release-resources",
  ].map((run) => steps.findIndex((step) => step.run === run));
  const isolate = steps.findIndex(
    (step) => step.name === "Keep only the pinned descriptor for the lightweight build",
  );
  const bundle = steps.findIndex(
    (step) => step.run === "pnpm bundle:desktop -- --os mac --arch arm64",
  );
  assert.ok(order[0] > 0 && order[0] < order[1] && order[1] < isolate && isolate < bundle);
  assert.equal(steps[bundle].env.ZCODE_REMOTE_ASSET_DESCRIPTOR_ONLY, "1");
  assert.match(
    steps[isolate].run,
    /rm -rf "packages\/desktop\/mock-cdn\/releases\/\$RELEASE_VERSION"/u,
  );
  const names = steps
    .filter((step) => step.uses === "actions/upload-artifact@v7")
    .map((step) => step.with.name);
  assert.deepEqual(names, [
    "source-server-resources-${{ env.RELEASE_TAG }}",
    "source-server-descriptor-${{ env.RELEASE_TAG }}",
    "ycode-mac-arm64-${{ env.RELEASE_TAG }}",
    "package-size-report-mac-arm64-${{ env.RELEASE_TAG }}",
  ]);
});

test("Windows本机构建只复用同提交Mac本机run的descriptor且无发布路径", async () => {
  const local = await readLocalWorkflow("windows");
  assert.deepEqual(Object.keys(local.on), ["workflow_dispatch"]);
  assert.deepEqual(local.on.workflow_dispatch.inputs.source_run_id, {
    description: "Run id of build-macos-local.yml on the same tag (provides the descriptor)",
    type: "string",
    required: true,
  });
  const { job, steps } = verifyLocalJob(
    local,
    ["self-hosted", "Windows", "X64", "ycode-windows"],
    "pnpm bundle:desktop -- --os win --arch x64",
    ["packages/desktop/dist/*.exe", "packages/desktop/dist/*.size-report.json"],
  );
  assert.equal(job.env.ZCODE_REMOTE_ASSET_DESCRIPTOR_ONLY, "1");
  assert.equal(job.env.SOURCE_RUN_ID, "${{ inputs.source_run_id }}");
  const verify = steps.findIndex(
    (step) => step.run === "node scripts/github-release-version.mjs verify-source-run",
  );
  const download = steps.findIndex((step) => step.uses === "actions/download-artifact@v8");
  assert.ok(verify > 0 && verify < download);
  assert.deepEqual(steps[verify].env, { GITHUB_TOKEN: "${{ github.token }}" });
  assert.deepEqual(steps[download].with, {
    name: "source-server-descriptor-${{ env.RELEASE_TAG }}",
    path: "packages/desktop/mock-cdn/releases/${{ env.RELEASE_VERSION }}",
    "run-id": "${{ env.SOURCE_RUN_ID }}",
    "github-token": "${{ github.token }}",
  });
  assert.ok(steps.every((step) => step.run !== "pnpm prepare:remote-assets"));
});

test("正式发布复用维护者预建的标签，不再直接用令牌 POST 创建 ref", () => {
  const publish = workflow.jobs.publish.steps.find(
    (step) => step.name === "Publish complete immutable GitHub Release",
  );
  assert.match(publish.run, /node scripts\/github-release-version\.mjs reserve-tag/u);
  assert.doesNotMatch(publish.run, /git\/refs/u);
  const reserve = publish.run.indexOf("reserve-tag");
  assert.ok(publish.run.indexOf("gh release view") < reserve);
  assert.ok(reserve < publish.run.indexOf("gh release create"));
  assert.match(publish.run, /--verify-tag --draft/u);
  assert.match(publish.run, /--draft=false --latest/u);
});

test("本机Windows路由只允许main手动显式开启，默认和其他上下文仍托管", () => {
  const input = workflow.on.workflow_dispatch.inputs.local_windows;
  assert.equal(input.type, "boolean");
  assert.equal(input.default, false);
  const localLabels = ["self-hosted", "Windows", "X64", "ycode-windows"];
  for (const target of workflow.jobs.package.strategy.matrix.include) {
    for (const [event, ref, enabled, local] of [
      ["workflow_dispatch", "refs/heads/main", true, true],
      ["workflow_dispatch", "refs/heads/main", false, false],
      ["workflow_dispatch", "refs/heads/main", undefined, false],
      ["push", "refs/heads/main", true, false],
      ["pull_request", "refs/pull/1/merge", true, false],
      ["pull_request_target", "refs/heads/main", true, false],
      ["workflow_dispatch", "refs/heads/feature", true, false],
      ["workflow_dispatch", "refs/tags/v1.0.0", true, false],
    ]) {
      const actual = runInNewContext(workflow.jobs.package["runs-on"].slice(3, -2), {
        // event.inputs 是字符串；即使它被设为 true，也必须只按 typed inputs 路由。
        github: {
          event_name: event,
          ref,
          event: { inputs: { local_windows: "true" } },
        },
        matrix: target,
        inputs: { local_windows: enabled },
        fromJSON: JSON.parse,
      });
      assert.deepEqual(
        actual,
        target.os === "win" && local ? localLabels : target.runner,
        `${target.os}/${event}/${ref}/${enabled}`,
      );
    }
  }
  assert.equal(
    workflow.jobs.package.strategy.matrix.include.find((target) => target.os === "win").runner,
    "windows-2025",
  );
});

test("macARM64 使用 Intel 宿主但保留目标 ARM64 与原 bundle 命令", () => {
  const targets = workflow.jobs.package.strategy.matrix.include;
  assert.deepEqual(
    targets.filter((entry) => entry.os === "mac"),
    [{ os: "mac", arch: "arm64", runner: "macos-15-intel" }],
  );
  assert.equal(
    workflow.jobs.package.steps.find((step) => step.name === "Build installer").run,
    "pnpm bundle:desktop -- --os ${{ matrix.os }} --arch ${{ matrix.arch }}",
  );
});

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
        github: {
          workflow: workflow.name,
          event_name: event,
          ref: "refs/heads/main",
        },
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
      evaluate(workflow.concurrency["cancel-in-progress"], {
        event_name: event,
        ref,
      }),
      expected,
      `${event} ${ref}`,
    );
  }
});

test("桌面矩阵只发布 macOS ARM64 和 Windows x64", () => {
  assert.deepEqual(
    workflow.jobs.package.strategy.matrix.include.map(({ os, arch }) => `${os}-${arch}`),
    ["mac-arm64", "win-x64"],
  );
});
