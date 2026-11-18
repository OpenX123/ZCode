import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  allocateReleaseIdentity,
  applyReleaseVersion,
  ensureReleaseTag,
  LOCAL_SOURCE_WORKFLOW_PATH,
  localReleaseIdentity,
  nextReleaseVersion,
  verifySourceRun,
} from "../github-release-version.mjs";

const sha = "a".repeat(40);
const otherSha = "b".repeat(40);

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("无正式标签从1.0.0起，忽略历史build和其他版本序列", () => {
  assert.equal(nextReleaseVersion([]), "1.0.0");
  assert.equal(
    nextReleaseVersion(["build-8-1", "v3.16.2", "v2.0.0", "v1.0.01", "v1.0.1-beta"]),
    "1.0.0",
  );
});

test("发版线取自package.json的1.<minor>，新线从patch 0起且只统计本线标签", () => {
  const tags = ["v1.0.0", "v1.0.6", "refs/tags/v1.0.12"];
  assert.equal(nextReleaseVersion(tags, "1.0.7"), "1.0.13");
  assert.equal(nextReleaseVersion(tags, "1.1.0"), "1.1.0");
  assert.equal(nextReleaseVersion([...tags, "v1.1.0", "v1.1.3"], "1.1.0"), "1.1.4");
});

test("已有更高发版线的正式标签时拒绝回退分配", () => {
  assert.throws(() => nextReleaseVersion(["v1.1.0"], "1.0.9"), /older than published 1\.1/);
  assert.throws(() => nextReleaseVersion([], "2.0.0"), /Expected release version/);
});

test("读取全部标签的最大patch，顺序和跨页不影响递增", () => {
  assert.equal(
    nextReleaseVersion(["refs/tags/v1.0.9", "v1.0.0", "refs/tags/v1.0.12", "v1.0.2"]),
    "1.0.13",
  );
  assert.throws(() => nextReleaseVersion(["v1.0.999999999999999999999"]), /integer range/);
});

test("失败发布留下的已占用标签不会被下一轮复用", () => {
  const published = ["v1.0.0"];
  const reservedByFailedPublish = "refs/tags/v1.0.1";
  assert.equal(nextReleaseVersion([...published, reservedByFailedPublish]), "1.0.2");
});

test("正式构建唯一读取标签并分配版本，PR不查询或占用正式版本", async () => {
  let reads = 0;
  const options = {
    currentVersion: "1.0.0",
    repository: "OpenX123/ZCode",
    runNumber: "9",
    runAttempt: "2",
    readTags: async () => {
      reads += 1;
      return ["v1.0.0"];
    },
  };
  assert.deepEqual(await allocateReleaseIdentity({ ...options, official: true }), {
    version: "1.0.1",
    tag: "v1.0.1",
  });
  assert.equal(reads, 1);
  assert.deepEqual(await allocateReleaseIdentity({ ...options, official: false }), {
    version: "1.0.0",
    tag: "build-9-2",
  });
  assert.equal(reads, 1);
});

test("维护者预建并指向当前提交、尚无公开Release的最高标签被复用，否则继续递增", async () => {
  const base = {
    official: true,
    currentVersion: "1.4.2",
    repository: "OpenX123/ZCode",
    runNumber: "9",
    runAttempt: "1",
    commitSha: sha,
    readTags: async () => ["v1.4.0", "v1.4.1", "refs/tags/v1.4.2"],
  };
  const resolved = [];
  const reuse = await allocateReleaseIdentity({
    ...base,
    resolveTagCommit: async (tag) => {
      resolved.push(tag);
      return sha;
    },
    releaseExists: async () => false,
  });
  assert.deepEqual(reuse, { version: "1.4.2", tag: "v1.4.2" });
  // 只检查本线最高标签，不逐个查询历史标签。
  assert.deepEqual(resolved, ["v1.4.2"]);
  for (const [label, resolveTagCommit, releaseExists] of [
    ["指向其他提交", async () => otherSha, async () => false],
    ["已公开Release", async () => sha, async () => true],
  ]) {
    assert.deepEqual(
      await allocateReleaseIdentity({
        ...base,
        resolveTagCommit,
        releaseExists,
      }),
      { version: "1.4.3", tag: "v1.4.3" },
      label,
    );
  }
  // 本线尚无标签时不查询，也不会误用其他发版线的标签。
  assert.deepEqual(
    await allocateReleaseIdentity({
      ...base,
      currentVersion: "1.5.0",
      resolveTagCommit: async () => {
        throw new Error("must not resolve");
      },
      releaseExists: async () => false,
    }),
    { version: "1.5.0", tag: "v1.5.0" },
  );
});

test("发布标签：已指向当前提交直接复用，指向其他提交明确失败，不存在才创建", async () => {
  const options = {
    repository: "OpenX123/ZCode",
    tag: "v1.4.2",
    commitSha: sha,
  };
  let created = 0;
  const createTag = async () => {
    created += 1;
  };
  assert.equal(
    await ensureReleaseTag({
      ...options,
      resolveTagCommit: async () => sha,
      createTag,
    }),
    "existing",
  );
  assert.equal(created, 0);
  await assert.rejects(
    ensureReleaseTag({
      ...options,
      resolveTagCommit: async () => otherSha,
      createTag,
    }),
    /already points to b{40}, not this build a{40}/u,
  );
  assert.equal(created, 0);
  assert.equal(
    await ensureReleaseTag({
      ...options,
      resolveTagCommit: async () => null,
      createTag,
    }),
    "created",
  );
  assert.equal(created, 1);
});

test("令牌无法创建标签时给出本机预建命令；并发创建到同一提交视为成功", async () => {
  const options = {
    repository: "OpenX123/ZCode",
    tag: "v1.4.2",
    commitSha: sha,
  };
  await assert.rejects(
    ensureReleaseTag({
      ...options,
      resolveTagCommit: async () => null,
      createTag: async () => {
        throw new Error("HTTP 403: Resource not accessible by integration");
      },
    }),
    (error) =>
      /HTTP 403/u.test(error.message) &&
      error.message.includes(
        `gh api --method POST repos/OpenX123/ZCode/git/refs -f ref=refs/tags/v1.4.2 -f sha=${sha}`,
      ),
  );
  let reads = 0;
  assert.equal(
    await ensureReleaseTag({
      ...options,
      resolveTagCommit: async () => (reads++ === 0 ? null : sha),
      createTag: async () => {
        throw new Error("HTTP 422: Reference already exists");
      },
    }),
    "existing",
  );
  for (const bad of [{ tag: "build-1-1" }, { tag: "v1.4.2;rm" }, { commitSha: "abc" }]) {
    await assert.rejects(
      ensureReleaseTag({
        ...options,
        ...bad,
        resolveTagCommit: async () => null,
        createTag: async () => {},
      }),
      /Expected/u,
    );
  }
});

test("本机构建版本来自package.json且必须在对应正式标签ref上运行", () => {
  assert.deepEqual(localReleaseIdentity({ ref: "refs/tags/v1.4.2", version: "1.4.2" }), {
    version: "1.4.2",
    tag: "v1.4.2",
  });
  for (const ref of ["refs/heads/main", "refs/tags/v1.4.1", "refs/tags/v1.4.2-rc", undefined]) {
    assert.throws(() => localReleaseIdentity({ ref, version: "1.4.2" }), /refs\/tags\/v1\.4\.2/u);
  }
  for (const version of ["1.4.2\n", "../1", "2.0.0", undefined]) {
    assert.throws(
      () => localReleaseIdentity({ ref: "refs/tags/v1.4.2", version }),
      /Expected package.json version/u,
    );
  }
});

test("Windows本机构建只接受同一提交上Mac本机workflow的源run", async () => {
  const good = { id: 7, path: LOCAL_SOURCE_WORKFLOW_PATH, head_sha: sha };
  assert.equal(
    await verifySourceRun({
      runId: "7",
      commitSha: sha,
      fetchRun: async () => good,
    }),
    good,
  );
  for (const [label, run, pattern] of [
    ["其他workflow", { ...good, path: ".github/workflows/build.yml" }, /is not/u],
    ["其他提交", { ...good, head_sha: otherSha }, /not this commit/u],
  ]) {
    await assert.rejects(
      verifySourceRun({
        runId: "7",
        commitSha: sha,
        fetchRun: async () => run,
      }),
      pattern,
      label,
    );
  }
  for (const runId of ["", "0", "7;echo", " 7", undefined]) {
    await assert.rejects(
      verifySourceRun({ runId, commitSha: sha, fetchRun: async () => good }),
      /source run id/u,
    );
  }
});

test("远端版本查询失败必须失败，不能回退1.0.0覆盖旧版本", async () => {
  await assert.rejects(
    allocateReleaseIdentity({
      official: true,
      currentVersion: "1.0.0",
      repository: "OpenX123/ZCode",
      runNumber: "9",
      runAttempt: "1",
      readTags: async () => {
        throw new Error("API unavailable");
      },
    }),
    /API unavailable/,
  );
});

test("四平台与发布job应用相同已分配版本，保留其他根配置", async () => {
  for (const target of ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64", "publish"]) {
    const directory = await mkdtemp(join(tmpdir(), `ycode-version-${target}-`));
    roots.push(directory);
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name: "zcode", version: "1.0.0", private: true }),
    );
    await applyReleaseVersion({ directory, version: "1.0.3" });
    assert.deepEqual(JSON.parse(await readFile(join(directory, "package.json"), "utf8")), {
      name: "zcode",
      version: "1.0.3",
      private: true,
    });
    await assert.rejects(
      applyReleaseVersion({ directory, version: "1.0.3; rm -rf /" }),
      /Expected release version/,
    );
  }
});
