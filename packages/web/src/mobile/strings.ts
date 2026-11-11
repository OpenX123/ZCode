/**
 * 连接建立前的外壳文案。此时还没有 SettingService，无法使用 ZCodeIntlProvider，
 * 按浏览器语言在中英文之间选择；连接后 Root 内部沿用应用 i18n。
 */
const zh = {
  title: "YCode 手机远控",
  noHosts: "还没有配对的电脑",
  noHostsHint: "在电脑上打开 设置 → 手机远控，点击「配对新手机」，然后在下方输入配对码或扫码。",
  addHost: "添加电脑",
  pairInputPlaceholder: "配对码，如 K7M2-9QXD",
  pairSubmit: "配对",
  scan: "扫码",
  scanHint: "将电脑上的配对二维码放入框内",
  cancel: "取消",
  unknownHostName: "电脑",
  inputUnrecognized: "无法识别。请输入电脑上显示的 8 位配对码，或粘贴配对链接。",
  qrOtherRelay: "这个二维码属于其他中继服务器，请在对应地址打开手机远控。",
  cameraDenied: "没有摄像头权限。请在系统设置中允许访问摄像头，或直接输入配对码。",
  cameraUnavailable: "当前环境无法使用摄像头，请直接输入配对码。",
  errorPairingNotFound: "配对码无效或已过期，请在电脑上重新生成。",
  errorPairingRejected: "配对码错误或已失效，请在电脑上重新生成。",
  errorRateLimited: "尝试次数过多，请一分钟后再试。",
  pairedHosts: "已配对的电脑",
  connect: "连接",
  remove: "移除",
  connecting: "正在连接…",
  pairing: "正在配对…",
  reconnecting: "连接已断开，正在重连…",
  retry: "重试",
  back: "返回",
  chooseWindow: "选择要接入的窗口",
  focusedWindow: "当前窗口",
  errorHostOffline: "电脑不在线。请确认电脑上的 YCode 已打开并开启了手机远控。",
  errorUnknownDevice: "这台手机未配对或已被电脑移除，请重新配对。",
  errorHostKeyMismatch: "电脑身份校验失败，已中止连接。请重新配对。",
  errorWindowUnavailable: "窗口已关闭或不可用。",
  errorNoWindow: "电脑上没有打开的项目窗口。",
  errorTimeout: "连接超时，请检查网络。",
  errorGeneric: "连接失败",
  trustNote: "通信端到端加密，中继服务器无法查看内容。",
} as const;

const en: Record<keyof typeof zh, string> = {
  title: "YCode Mobile Remote",
  noHosts: "No paired computer yet",
  noHostsHint:
    "On your computer open Settings → Mobile Remote and click “Pair new phone”, then enter the pairing code below or scan the QR code.",
  addHost: "Add a computer",
  pairInputPlaceholder: "Pairing code, e.g. K7M2-9QXD",
  pairSubmit: "Pair",
  scan: "Scan",
  scanHint: "Fit the pairing QR code shown on your computer inside the frame",
  cancel: "Cancel",
  unknownHostName: "Computer",
  inputUnrecognized:
    "Not recognized. Enter the 8-character code shown on your computer, or paste the pairing link.",
  qrOtherRelay:
    "This QR code belongs to a different relay server. Open Mobile Remote at that address instead.",
  cameraDenied:
    "Camera access was denied. Allow camera access in system settings, or enter the pairing code.",
  cameraUnavailable: "The camera is not available here. Enter the pairing code instead.",
  errorPairingNotFound:
    "The pairing code is invalid or expired. Generate a new one on your computer.",
  errorPairingRejected:
    "The pairing code is wrong or no longer valid. Generate a new one on your computer.",
  errorRateLimited: "Too many attempts. Try again in a minute.",
  pairedHosts: "Paired computers",
  connect: "Connect",
  remove: "Remove",
  connecting: "Connecting…",
  pairing: "Pairing…",
  reconnecting: "Connection lost, reconnecting…",
  retry: "Retry",
  back: "Back",
  chooseWindow: "Choose a window",
  focusedWindow: "Current window",
  errorHostOffline:
    "The computer is offline. Make sure YCode is running with Mobile Remote enabled.",
  errorUnknownDevice: "This phone is not paired or was removed. Pair it again.",
  errorHostKeyMismatch: "Computer identity check failed. Pair it again.",
  errorWindowUnavailable: "The window was closed or is unavailable.",
  errorNoWindow: "No project window is open on the computer.",
  errorTimeout: "Connection timed out. Check your network.",
  errorGeneric: "Connection failed",
  trustNote: "End-to-end encrypted. The relay server cannot read your data.",
};

export type MobileStringKey = keyof typeof zh;

export const mobileStrings: Record<MobileStringKey, string> = navigator.language
  .toLowerCase()
  .startsWith("zh")
  ? zh
  : en;
