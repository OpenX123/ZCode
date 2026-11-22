/**
 * skills-hub-sync 标准调用示例：Host 装配时注入主目录与冲突选择存储。
 */
import type { SkillsHubOptions } from "./contract.js";
import { createSkillsHub } from "./skillsHub.js";

export function exampleCreateSkillsHub(homeDir: string) {
  let choices: Record<string, string> = {};
  const options: SkillsHubOptions = {
    homeDir: () => homeDir,
    isAvailable: () => true,
    choices: {
      read: async () => choices,
      write: async (next) => {
        choices = next;
      },
    },
  };
  return createSkillsHub(options);
}
