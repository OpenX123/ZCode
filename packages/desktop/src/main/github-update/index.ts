export { createGithubDesktopUpdater } from "./updater.js";
export { installGithubDesktopUpdates, type GithubDesktopUpdatesHandle } from "./electronAdapter.js";
export type {
  GithubDesktopInstallMode,
  GithubDesktopUpdateContract,
  GithubDesktopUpdateOptions,
  GithubDesktopUpdatePreferences,
} from "./contract.js";
