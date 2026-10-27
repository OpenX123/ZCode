import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  allocateReleaseIdentity,
  applyReleaseVersion,
  nextReleaseVersion,
} from "../github-release-version.mjs";

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("无正式标签从1.0.0起，忽略历史build和其他版本序列", () => {
  assert.equal(nextReleaseVersion([]), "1.0.0");
  assert.equal(
    nextReleaseVersion(["build-8-1", "v3.16.2", "v1.1.0", "v1.0.01", "v1.0.1-beta"]),
    "1.0.0",
  );
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
