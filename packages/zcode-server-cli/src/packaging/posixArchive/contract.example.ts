/** 由完整包 staging 或派生 B 调用并等待最终归档关闭。 */
import type { CreatePosixReleaseArchive } from "./contract.js";

export async function examplePosixReleaseArchive(
  createArchive: CreatePosixReleaseArchive,
): Promise<void> {
  await createArchive({
    releaseDir: "/staging/zcode-server-linux-x64",
    archivePath: "/output/zcode-server-linux-x64.tar.gz",
    layout: "release",
  });
}
