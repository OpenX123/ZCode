import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function cleanDist(packageDirectory = process.cwd()) {
  await rm(resolve(packageDirectory, "dist"), {
    force: true,
    recursive: true,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await cleanDist();
}
