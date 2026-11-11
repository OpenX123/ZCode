/**
 * mobile-remote-settings 对外契约：设置页「手机远控」分区。
 * 组件无 props，只通过 IPlatformService 的可选手机远控方法读状态、发命令；
 * 状态唯一所有者是 Main 网关，平台不提供这些方法（Web 端）时分区不渲染内容。
 */
export type MobileRemoteSectionProps = Record<string, never>;
