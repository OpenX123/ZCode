import type { MediaCodeViewerSource } from "@/lib/codeViewer.js";
import type { SyntheticEvent } from "react";
import { useEffect, useState } from "react";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { MarkdownImage } from "@/components/ai-elements/markdown-image.js";
import { resolveMarkdownFileLink } from "@/lib/markdownFileLink.js";
import type { MessageResponseProps } from "@/components/ai-elements/message.js";

/** 已收到媒体的展示；读取沿当前 workspace Provider / session reader，绝不重跑任务。 */
export function AssistantMediaContent({
  source,
  mediaType,
  mimeType,
  name,
  sessionId,
  readAttachment,
  workspacePath,
  workspaceHomePath,
  onOpenSource,
}: {
  source: string;
  mediaType: "image" | "audio" | "video";
  mimeType: string;
  name?: string;
  sessionId?: string;
  readAttachment?: MessageResponseProps["readAttachment"];
  workspacePath?: string;
  workspaceHomePath?: string;
  onOpenSource?: (source: string) => void;
}) {
  const services = useOptionalServices();
  const { intl } = useZCodeIntl();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; url?: string; failed?: boolean }>({
    key: "",
  });
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const artifact = source.startsWith("zcode-artifact://");
  const remote = /^https?:\/\//iu.test(source);
  const key = `${source}:${sessionId ?? ""}:${attempt}`;
  useEffect(() => {
    if (mediaType === "image") return;
    let disposed = false;
    let objectUrl: string | undefined;
    let previewId: string | undefined;
    setPlaybackFailed(false);
    setResult({ key });
    const prepare = async () => {
      if (remote) return { url: source };
      if (artifact) {
        if (!sessionId || !readAttachment) throw new Error("unavailable");
        const value = await readAttachment({ sessionId, ref: source });
        if ("url" in value) return value;
        return { bytes: value.bytes, mediaType: value.mediaType };
      }
      const link = resolveMarkdownFileLink(workspacePath, source, { homePath: workspaceHomePath });
      if (!link || !services?.mediaPreviewService) throw new Error("unavailable");
      const value = await services.mediaPreviewService.prepare({
        path: link.path,
        expectedKind: mediaType,
      });
      if ("previewId" in value) previewId = value.previewId;
      if ("url" in value) return value;
      return {
        bytes: Uint8Array.from(atob(value.dataBase64), (c) => c.charCodeAt(0)),
        mediaType: value.mediaType,
      };
    };
    void prepare()
      .then((value) => {
        if (disposed) {
          if (previewId)
            void services?.mediaPreviewService?.release?.({ previewId }).catch(() => undefined);
          return;
        }
        if ("url" in value) setResult({ key, url: value.url });
        else {
          objectUrl = URL.createObjectURL(
            new Blob([Uint8Array.from(value.bytes)], { type: mimeType }),
          );
          setResult({ key, url: objectUrl });
        }
      })
      .catch(() => {
        if (!disposed) setResult({ key, failed: true });
      });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (previewId)
        void services?.mediaPreviewService?.release?.({ previewId }).catch(() => undefined);
    };
  }, [
    artifact,
    key,
    mediaType,
    mimeType,
    readAttachment,
    remote,
    services,
    sessionId,
    source,
    workspaceHomePath,
    workspacePath,
  ]);
  if (mediaType === "image")
    return (
      <MarkdownImage
        src={source}
        alt={name}
        mimeType={mimeType}
        sessionId={sessionId}
        readAttachment={readAttachment}
        workspacePath={workspacePath}
        workspaceHomePath={workspaceHomePath}
        onOpenSource={onOpenSource}
      />
    );
  const settled = remote ? { key, url: source } : result.key === key ? result : undefined;
  const unavailable = intl.formatMessage({ id: "codeViewer.mediaUnavailable" });
  return (
    <div
      data-assistant-media={mediaType}
      className="my-3 min-w-0 rounded-xl border border-border bg-surface"
    >
      <PreviewPaneMediaContent
        source={{
          type: "media",
          kind: mediaType,
          mediaType: mimeType,
          title: name ?? source,
          path: source,
        }}
        loading={!settled?.url && !settled?.failed}
        url={settled?.url ?? null}
        error={settled?.failed || playbackFailed ? unavailable : null}
        labels={{
          loading: intl.formatMessage({ id: "common.loading" }),
          unavailable,
          unsupported: unavailable,
        }}
        onMediaError={() => setPlaybackFailed(true)}
      />
      <div className="flex min-w-0 flex-wrap items-center gap-2 px-3 pb-2 text-ui-sm">
        {onOpenSource && !artifact ? (
          <Button
            type="button"
            variant="link"
            size="xs"
            className="max-w-full truncate px-0"
            title={source}
            onClick={() => onOpenSource(source)}
          >
            {source}
          </Button>
        ) : (
          <span className="break-all">{source}</span>
        )}
        {settled?.failed || playbackFailed ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => {
              setPlaybackFailed(false);
              setAttempt((value) => value + 1);
            }}
          >
            {intl.formatMessage({ id: "common.retry" })}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

interface PreviewPaneMediaContentProps {
  source: MediaCodeViewerSource;
  loading: boolean;
  url: string | null;
  error: string | null;
  labels: {
    loading: string;
    unavailable: string;
    unsupported: string;
  };
  onMediaError?: (event: SyntheticEvent<HTMLMediaElement>) => void;
  onMediaLoadedMetadata?: (event: SyntheticEvent<HTMLMediaElement>) => void;
}

export function PreviewPaneMediaContent({
  source,
  loading,
  url,
  error,
  labels,
  onMediaError,
  onMediaLoadedMetadata,
}: PreviewPaneMediaContentProps) {
  if (loading || (!error && !url)) {
    return <div className="p-3 text-ui-base text-foreground-subtle">{labels.loading}</div>;
  }

  if (error || !url) {
    return (
      <div className="p-3 text-ui-base text-destructive" role="alert">
        {error ?? labels.unavailable}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-background p-6">
      {source.kind === "video" ? (
        <video
          controls
          playsInline
          className="max-h-full max-w-full rounded-lg"
          preload="metadata"
          src={url}
          onError={onMediaError}
          onLoadedMetadata={onMediaLoadedMetadata}
        >
          {labels.unsupported}
        </video>
      ) : (
        <audio
          controls
          className="w-full max-w-2xl"
          preload="metadata"
          src={url}
          onError={onMediaError}
          onLoadedMetadata={onMediaLoadedMetadata}
        >
          {labels.unsupported}
        </audio>
      )}
    </div>
  );
}
