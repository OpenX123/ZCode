/** build-time POSIX Source Server 归档合同；权限分类由 producer 唯一持有。 */
export interface PosixReleaseArchiveOptions {
  /** 已组装的发行根或仅含指定组件 paths 的根；调用期间由调用方保持只读。 */
  releaseDir: string;
  /** 位于输入根之外的 tar.gz 输出文件；拒绝或 IO 失败原样向调用方传播。 */
  archivePath: string;
  /** release 保留 zcode-server-<POSIX target> 顶层；component 从 ./runtime 等路径开始。 */
  layout: "release" | "component";
  /** caller持有既有预算；producer等待归档/输出流销毁后拒绝，拒绝后不再写。不设默认超时。 */
  signal?: AbortSignal;
}

/** 唯一 POSIX 权限 producer；完成表示归档已关闭，不修改源文件或生成内容 hash。 */
export type CreatePosixReleaseArchive = (options: PosixReleaseArchiveOptions) => Promise<void>;
