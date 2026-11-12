/** 手机入口统一持有可见高度；子布局只继承根容器，不自行推测软键盘状态。 */
export function installMobileViewport(root: HTMLElement): () => void {
  const viewport = window.visualViewport;
  let frame: number | null = null;
  const update = () => {
    frame = null;
    // 修复依据：Safari 的键盘只缩小 visualViewport；双指缩放也会触发相同事件，
    // 此时必须保留原布局供用户平移，不能把缩放后的可见高度再次用来压缩内容。
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
    root.style.setProperty(
      "--mobile-viewport-height",
      `${viewport?.height ?? window.innerHeight}px`,
    );
    root.style.setProperty("--mobile-viewport-top", `${viewport?.offsetTop ?? 0}px`);
  };
  const scheduleUpdate = () => {
    if (frame === null) frame = window.requestAnimationFrame(update);
  };
  update();
  viewport?.addEventListener("resize", scheduleUpdate);
  viewport?.addEventListener("scroll", scheduleUpdate);
  window.addEventListener("resize", scheduleUpdate);
  return () => {
    if (frame !== null) window.cancelAnimationFrame(frame);
    viewport?.removeEventListener("resize", scheduleUpdate);
    viewport?.removeEventListener("scroll", scheduleUpdate);
    window.removeEventListener("resize", scheduleUpdate);
    root.style.removeProperty("--mobile-viewport-height");
    root.style.removeProperty("--mobile-viewport-top");
  };
}
