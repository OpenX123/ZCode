/**
 * 页面内扫码：后置摄像头 + BarcodeDetector，不支持时按需加载 jsQR 逐帧识别。
 * 只负责把识别到的文本交给调用方；摄像头不可用或被拒绝时报告原因，由外壳回退到手输配对码。
 * PWA 与原生壳都走这一实现（原生壳需声明摄像头权限，见 spec「手机网页」）。
 */
import { useEffect, useRef } from "react";
import { Button } from "@zcode/ui";
import { mobileStrings as t } from "./strings.js";

export type QrScannerFailure = "denied" | "unavailable";

/** 识别间隔：兼顾识别速度与低端机发热。 */
const SCAN_INTERVAL_MS = 150;
/** jsQR 回退时把画面缩到该边长以内再识别。 */
const MAX_DECODE_EDGE = 640;

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}

async function createNativeDetector(): Promise<BarcodeDetectorLike | null> {
  const Detector = (
    globalThis as {
      BarcodeDetector?: {
        new (options: { formats: string[] }): BarcodeDetectorLike;
        getSupportedFormats?: () => Promise<string[]>;
      };
    }
  ).BarcodeDetector;
  if (!Detector) return null;
  try {
    const formats = (await Detector.getSupportedFormats?.()) ?? ["qr_code"];
    return formats.includes("qr_code") ? new Detector({ formats: ["qr_code"] }) : null;
  } catch {
    return null;
  }
}

type JsQrDecode = typeof import("jsqr").default;

/**
 * jsQR 是 UMD/CJS 包：运行时 module.exports 即解码函数（.default 上也挂同一函数），
 * 而 TypeScript nodenext 把默认导入推断为 CJS 命名空间，这里兼容两种形态取出函数。
 */
async function loadJsQr(): Promise<JsQrDecode> {
  const loaded: unknown = (await import("jsqr")).default;
  if (typeof loaded === "function") return loaded as JsQrDecode;
  return (loaded as { default: JsQrDecode }).default;
}

function failureOf(error: unknown): QrScannerFailure {
  const name = (error as { name?: string } | null)?.name;
  return name === "NotAllowedError" || name === "SecurityError" ? "denied" : "unavailable";
}

export function QrScanner(props: {
  onResult: (text: string) => void;
  onFailure: (failure: QrScannerFailure) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // 回调经 ref 读取最新值，扫码循环只随组件挂载启动一次。
  const handlers = useRef(props);
  handlers.current = props;

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const canvas = document.createElement("canvas");

    async function start(): Promise<void> {
      if (!navigator.mediaDevices?.getUserMedia) {
        handlers.current.onFailure("unavailable");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        const video = videoRef.current;
        if (stopped || !video) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        video.srcObject = stream;
        // 浏览器回归已复现：忽略播放失败会留下黑屏，解码器加载失败则产生未处理拒绝。
        // 初始化任一步失败都退出扫码并释放摄像头，保留手输配对码入口。
        await video.play();
        if (stopped) return;

        const native = await createNativeDetector();
        if (stopped) return;
        const decodeWithJsQr = native ? null : await loadJsQr();
        if (stopped) return;

        const tick = async () => {
          if (stopped) return;
          const current = videoRef.current;
          if (
            current &&
            current.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
            current.videoWidth > 0
          ) {
            let text: string | null = null;
            try {
              if (native) {
                text = (await native.detect(current))[0]?.rawValue ?? null;
              } else if (decodeWithJsQr) {
                const scale = Math.min(
                  1,
                  MAX_DECODE_EDGE / Math.max(current.videoWidth, current.videoHeight),
                );
                canvas.width = Math.round(current.videoWidth * scale);
                canvas.height = Math.round(current.videoHeight * scale);
                const context = canvas.getContext("2d", { willReadFrequently: true });
                if (context) {
                  context.drawImage(current, 0, 0, canvas.width, canvas.height);
                  const image = context.getImageData(0, 0, canvas.width, canvas.height);
                  text =
                    decodeWithJsQr(image.data, image.width, image.height, {
                      inversionAttempts: "dontInvert",
                    })?.data ?? null;
                }
              }
            } catch {
              // 单帧识别失败（画面未就绪等）不影响后续帧。
            }
            if (text && !stopped) {
              handlers.current.onResult(text);
              return;
            }
          }
          timer = setTimeout(() => void tick(), SCAN_INTERVAL_MS);
        };
        void tick();
      } catch (error) {
        stream?.getTracks().forEach((track) => track.stop());
        if (!stopped) handlers.current.onFailure(failureOf(error));
      }
    }

    void start();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  return (
    <div className="fixed inset-0 z-[1000] flex flex-col bg-black text-white">
      {/* iOS 需要 playsInline + muted 才能在页面内播放摄像头画面 */}
      <video ref={videoRef} playsInline muted autoPlay className="min-h-0 flex-1 object-cover" />
      <div
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-1/2 size-60 -translate-x-1/2 -translate-y-1/2 rounded-xl border-2 border-white/80"
      />
      <div className="flex flex-col items-center gap-3 px-5 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <p className="text-ui-base text-center text-white/80">{t.scanHint}</p>
        <Button variant="outline" onClick={() => props.onClose()}>
          {t.cancel}
        </Button>
      </div>
    </div>
  );
}
