/**
 * mobile-remote-web 对外契约：手机远控网页外壳。
 * 由中继在 /m/ 下托管（`vite --base /m/` 构建），bootstrapMobileRemote 接管 React 根节点。
 * 同时提供 Web 与手机共用的平台实现 createWebPlatform（platform/webPlatform.ts）。
 */
export interface PairedHost {
  hostId: string;
  hostName: string;
  relayUrl: string;
  pairedAt: number;
  lastWindowId?: number;
}
