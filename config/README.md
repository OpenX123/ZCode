# 本地配置

`config/provider/zcode-builtin.json` 随应用提供普通 API Provider 模板和模型规则。模板中的 GLM / Z.ai 是可选 API 供应商，不代表官方账号、套餐权益或云配置服务。

个人 Provider、API Key 和默认模型由本地设置保存，用户通过“模型供应商”配置。`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 可指定本地 Provider 配置文件；不要把真实 API Key 写入本目录或提交到仓库。

内置模型目录仅使用随包的 `config/provider/zcode-builtin.json`。运行时不请求官方配置、营销或活动接口。SSH 分发只同步 Personal Provider 配置与默认选择，不同步历史官方账号和套餐凭据。

产品边界见 [独立 coding harness 规格](../docs/desktop/standalone-coding-harness-spec.md)。
