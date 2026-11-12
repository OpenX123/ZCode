// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { installMobileViewport } from "../src/mobile/viewport.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose());
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function setup(withVisualViewport = true) {
  const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
  vi.stubGlobal("visualViewport", withVisualViewport ? viewport : undefined);
  vi.stubGlobal("innerHeight", 844);
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = installMobileViewport(root);
  cleanups.push(dispose);
  const flush = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(0));
  };
  return { viewport, root, frames, flush, dispose };
}

it("键盘只改变可见视口时更新根高度与平移，关闭后恢复", () => {
  const { viewport, root, frames, flush } = setup();
  expect(root.style.getPropertyValue("--mobile-viewport-height")).toBe("844px");
  Object.assign(viewport, { height: 430, offsetTop: 68 });
  viewport.dispatchEvent(new Event("resize"));
  viewport.dispatchEvent(new Event("scroll"));
  expect(frames.size).toBe(1);
  flush();
  expect(root.style.getPropertyValue("--mobile-viewport-height")).toBe("430px");
  expect(root.style.getPropertyValue("--mobile-viewport-top")).toBe("68px");
  Object.assign(viewport, { height: 844, offsetTop: 0 });
  viewport.dispatchEvent(new Event("resize"));
  flush();
  expect(root.style.getPropertyValue("--mobile-viewport-height")).toBe("844px");
  expect(root.style.getPropertyValue("--mobile-viewport-top")).toBe("0px");
});

it("双指缩放不重排根高度，返回原比例后恢复监听", () => {
  const { viewport, root, flush } = setup();
  Object.assign(viewport, { height: 422, offsetTop: 20, scale: 2 });
  viewport.dispatchEvent(new Event("resize"));
  flush();
  expect(root.style.getPropertyValue("--mobile-viewport-height")).toBe("844px");
  Object.assign(viewport, { height: 390, offsetTop: 0, scale: 1 });
  window.dispatchEvent(new Event("resize"));
  flush();
  expect(root.style.getPropertyValue("--mobile-viewport-height")).toBe("390px");
});

it("不支持 visualViewport 时按窗口高度回退，卸载后不再写入", () => {
  const { root, flush, dispose, frames } = setup(false);
  vi.stubGlobal("innerHeight", 400);
  window.dispatchEvent(new Event("resize"));
  flush();
  expect(root.style.getPropertyValue("--mobile-viewport-height")).toBe("400px");
  window.dispatchEvent(new Event("resize"));
  dispose();
  expect(frames.size).toBe(0);
  expect(root.style.getPropertyValue("--mobile-viewport-height")).toBe("");
  window.dispatchEvent(new Event("resize"));
  expect(frames.size).toBe(0);
});
