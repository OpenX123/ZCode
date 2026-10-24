import { logger } from "./logger.js";
import { initializeCrashCapture, type CrashCapturePaths } from "./desktopCrashCapture.js";

// 独立桌面只写本地崩溃文件，不启动原厂远端上报。
export const crashCapturePaths: CrashCapturePaths = initializeCrashCapture(logger, false);
