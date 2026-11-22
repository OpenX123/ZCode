# YCode 品牌显示规范

## 产品规则

- 产品对用户统一显示为 `YCode`；开发版和预览版分别显示为 `YCode Dev`、`YCode Preview`。
- 桌面与 Web 的启动画面、标题栏、欢迎页、关于页、菜单、输入提示及中英文文案使用同一品牌。
- Logo 使用用户提供的 `/Volumes/MacData/Downloads/icons/icon_512@2x.png`，保持原始颜色和比例，不重绘、不反色、不额外嵌套旧 Logo 底座。桌面构建的 `icon.png`、`icon_installer.png` 和两个 ICNS 文件使用带透明留白的派生图：1024×1024 画布中主体为 832×832，居中且四边各留 96px；ICNS 各分辨率保持相同比例。Windows ICO 和 Linux 图标继续使用原始素材及其现有尺寸。
- 模型供应商品牌独立于应用品牌，保留供应商原有图标。

## 所有者与兼容边界

- UI 的应用图片资源供现有 Logo 组件复用；桌面构建资源负责系统和安装图标。HTML 首屏在 React 加载前引用各入口 public 目录中的同源 PNG 副本，兼容 Vite 开发服务和打包后的静态路径。
- 沿用现有产品身份配置管理安装包显示名，运行时管理应用显示名，现有 i18n 字典管理界面文案。
- 本次为品牌显示变更。内部包名、类型名、RPC、appId、Linux 命令、环境变量、持久化 key 和既有用户数据目录保持兼容；显示名变更不得导致用户设置和会话丢失。
- URL scheme 自 1.5.1 起双注册：`ycode://` 为新生成链接使用的主 scheme，`zcode://` 继续注册并解析，旧链接、旧书签和第三方回调不失效（见下文“1.5.1 用户可见文案与深链”）。

## 验收

1. 中英文标题、欢迎文案、菜单、占位提示与关于窗口显示 YCode。
2. 桌面和 Web 的 HTML 首屏、React 启动阻塞态及标题栏均显示提供的 Y 形图片，图片无拉伸、无旧 Z 形路径残留。
3. 在桌面/手机尺寸及深浅主题下，图片清晰可见；减少动态效果偏好继续有效。
4. 正式/预览/开发版显示新名称，用户数据路径及系统集成标识保持兼容。
5. 原始 public 资源、界面 Logo、Windows ICO 保留用户素材；桌面构建 PNG 与 ICNS 的主体比例为 81.25%，透明留白不改变主体颜色和宽高比。macOS dev 和打包版沿用现有资源加载路径，不在运行时重复缩放。

## 2026-10-25 Dock 图标尺寸修正

- 原因：新素材的主体铺满画布，旧素材则在 1024×1024 画布四边各留 96px；直接设置 Dock 图标后，主体视觉宽度增加约 23%。
- 修正：在桌面构建资源中恢复透明留白，同时更新 PNG 和 ICNS，避免开发版启动前后的图标大小不一致。原始 public 素材和界面内 Logo 不受影响。
- 验收：1024px PNG 的主体边界为 `(96, 96, 928, 928)`；ICNS 各分辨率的主体宽度占画布约 81.25%（允许像素取整）；两个 PNG 一致，两个 ICNS 一致。

## 2026-10-24 本地验证

- 类型检查通过；Lint 为 0 错误（工作区仍有既有警告）；架构检查通过。
- 品牌及相关启动、数据路径、目录打开场景共 91 项测试通过。
- 扩展运行旧 Deep Link 全文件时，5 项 OAuth/分享场景失败：当前工作区已移除对应路由和 `registerOAuthState`，旧测试仍引用这些接口；本次只修改其中的品牌文案，未恢复这些功能。
- Web 生产构建通过。浏览器检查了 1200×800 与 390×844、深浅主题及中英文组件；HTML 首屏与关于窗口图片成功解码，手机尺寸无横向溢出。
- 11 个直接使用的品牌资源与用户原文件逐字节一致；DMG 两个分辨率背景的标题改为 YCode。
- 未生成安装包或执行原生桌面 E2E；系统安装图标需在重新打包后验证。

## 2026-11-11 桌面修复范围

桌面包的产品显示元数据统一为 YCode；内部包名、appId、协议、旧数据目录与源码目录不迁移。用户指定的本项目显示名通过现有项目服务保存，不能批量改名其它项目。

## 1.5.1 用户可见文案与深链

### 文案

- 所有用户可见 `ZCode` 改为 `YCode`：i18n 剩余项、本地用量统计面板标签、UI 错误兜底文案、Windows 安装器详情行前缀与标题、Finder workflow 包名、Linux `.desktop` Comment、Computer Use 权限错误、内置浏览器名称、Source Server 升级提示、Bot 渠道消息与帮助标题、默认引擎显示名 `YCode Agent`；打包元数据 author/maintainer 改为 YCode。
- 不改：内部日志、协议 ID/字段、类型名、包名、IPC channel、注册表 key 名、安装器日志文件名（`%TEMP%\ZCode-installer.log` 等，诊断文档与支持流程依赖）、`.desktop` 文件名 `zcode.desktop`、git checkpoint 作者名、CA 证书名、`.zcodeignore` 模板。数据目录与环境变量由工作包 G 负责。
- UI 通用错误识别同时接受旧 `ZCode session failed` 与新 `YCode session failed`，历史会话中的旧错误仍被识别为通用兜底。

### 系统集成兼容

- Windows Explorer 菜单：显示文字已为 YCode；注册表 key `ZCode.OpenInZCode` 保持不变，覆盖写入，不产生重复菜单。
- macOS Finder 服务：workflow 包名改为 `Open in YCode.workflow`，安装时删除旧 `Open in ZCode.workflow`（仅当其 `Info.plist` 带本应用 bundle id `dev.zcode.app.finder-open-workflow`，避免误删用户自建同名服务），保证 Services 菜单只有一项。
- Linux：用户级 `zcode.desktop` 的 Comment 改为 `YCode Desktop App`；所有权判定同时接受新旧 Comment，旧版本写入的条目仍能被识别、覆盖或清理。

### 深链

| 动作 | 所有者 | 规则 |
| --- | --- | --- |
| 注册 | desktop main `registerDeepLinkProtocol` | 依次对 `ycode`、`zcode` 调用 `setAsDefaultProtocolClient`；单个失败只记 warn，不影响另一个 |
| Linux 注册 | `registerLinuxDeepLinkProtocol` | `.desktop` `MimeType` 同时列出 `x-scheme-handler/ycode;x-scheme-handler/zcode;`，并对两个 MIME 执行 `xdg-mime default` |
| 打包声明 | electron-builder `protocols.schemes` | `["ycode", "zcode"]`（macOS Info.plist、Linux 包 desktop entry） |
| Dev macOS | `devElectronAppBundle.mjs` | `CFBundleURLSchemes` 同时含两者；副本布局版本递增，已有旧副本自动重建 |
| 解析 | `desktopDeepLinkUrl.ts`、`parseSessionDeepLink` | 两个 scheme 等价，路由规则（oauth/payment/workspace/share/session）不变 |
| 生成 | `buildSessionDeepLink`、Finder workflow | 一律 `ycode://` |

已安装 1.5.0 之前版本与 1.5.1 并存时，`ycode://` 只由 1.5.1 处理；`zcode://` 由最后注册者处理（与此前行为一致）。

### 验收

1. `ycode://session/open?...`、`ycode://workspace/open?path=...` 与对应 `zcode://` 链接解析结果一致；非两者的 scheme 被拒绝。
2. 复制会话链接得到 `ycode://session/open?...`。
3. 主进程对两个 scheme 都调用注册；Linux desktop entry 的 MimeType 含两个 handler，xdg-mime default 对两者执行。
4. 带旧 Comment 的用户级 `zcode.desktop` 仍被识别为本应用条目。
5. 安装 Finder 服务后只存在 `Open in YCode.workflow`；用户自建的、bundle id 不同的 `Open in ZCode.workflow` 保留。
6. 中英文界面、安装器详情、Bot 帮助与错误兜底不再出现 `ZCode`。
