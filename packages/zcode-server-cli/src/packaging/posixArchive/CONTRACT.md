# posix-release-archive

此 build-time adapter 是 POSIX Source Server 完整、组件和测试派生归档的权限唯一所有者。
公开入口 `@zcode/server-cli/packaging` 仅导出 `createPosixReleaseArchive` 与参数类型。

- 文件角色与精确 mode 由 R2 §7.1 约束：目录 0755、Node/launcher/search/spawn-helper 0755，其他普通文件 0644。
- 不读取宿主执行位决定权限，不修改源文件，不收集 xattr/AppleDouble 元数据，不更改内容 hash 合同。
- 输入是已准备且调用期间不变的发行根；归档输出必须在该根之外。release 布局校验 POSIX target 顶层名，component 布局保留既有相对路径。
- 调用完成表示 tar.gz 已关闭，失败原样传播；不处理下载、解压、installer、descriptor 或通用归档策略。
- 可选 signal 经原生 pipeline 中止读写流；B 保留原单次归档300000ms预算，不设新默认超时，不留下Promise.race后台写入。
- stage.ts/stageArchives.ts 与 Desktop B fixture 通过此公开 producer 交汇；Windows zip 仍归原宿主命令所有。
