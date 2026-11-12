# mobile-remote-settings

设置页「手机远控」分区：开关、中继地址与令牌、扫码配对、已配对设备列表。规则见 [手机远控](../../../../docs/desktop/mobile-remote-spec.md)「桌面设置」一节。

不变量：

- 不持有事实：状态来自 `platform.getMobileRemoteStatus` 与 `onMobileRemoteStatusChanged` 广播，所有修改经平台命令交给 Main 网关。
- 令牌输入框只写不读：已保存时显示占位提示，留空提交表示保留原值。
- 二维码只在内存，倒计时到期或设备数增加（配对成功）后自动收起。
- 只在桌面端出现（`createSettingsPageConfig` 按桌面平台过滤）。
