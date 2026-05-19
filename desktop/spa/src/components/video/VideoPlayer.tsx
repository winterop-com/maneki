/**
 * HTML5 <video> + hls.js + <track> for subtitles. hls.js is lazy-loaded
 * (`await import(...)`) so the initial bundle stays small - users pay the
 * ~500 KB hls.js cost only when they actually open the player.
 */

import { useEffect, useRef, useState } from "react";
import { useAuth } from "../../state/auth";
import { fetchSubtitles } from "../../state/videos";
import type { SubtitleSummary, Video } from "../../state/videos";

interface VideoPlayerProps {
  video: Video;
  onClose: () => void;
}

export function VideoPlayer({ video, onClose }: VideoPlayerProps): React.ReactElement {
  const { authedFetch } = useAuth();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [subtitles, setSubtitles] = useState<SubtitleSummary[]>(video.subtitles);
  const [status, setStatus] = useState<string>("loading playlist...");

  useEffect(() => {
    void fetchSubtitles(authedFetch, video.id).then(setSubtitles).catch(() => {});
  }, [authedFetch, video.id]);

  useEffect(() => {
    const el = videoRef.current;
    if (el === null) return;
    const url = `/video/api/videos/${encodeURIComponent(video.id)}/hls/index.m3u8`;
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    if (el.canPlayType("application/vnd.apple.mpegurl")) {
      el.src = url;
      el.play().catch((err: unknown) => {
        setStatus(`autoplay blocked: ${err instanceof Error ? err.message : String(err)}`);
      });
      cleanup = () => {
        el.removeAttribute("src");
        el.load();
      };
    } else {
      void (async () => {
        const { default: Hls } = await import("hls.js");
        if (cancelled) return;
        if (!Hls.isSupported()) {
          setStatus("HLS playback unsupported in this browser.");
          return;
        }
        const hls = new Hls({ enableWorker: true });
        hls.loadSource(url);
        hls.attachMedia(el);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          el.play().catch((err: unknown) => {
            setStatus(`autoplay blocked: ${err instanceof Error ? err.message : String(err)}`);
          });
        });
        hls.on(Hls.Events.ERROR, (_evt, data) => {
          if (data.fatal) {
            setStatus(`hls error: ${data.details ?? data.type}`);
          }
        });
        cleanup = () => {
          hls.destroy();
          el.removeAttribute("src");
          el.load();
        };
      })();
    }

    return () => {
      cancelled = true;
      if (cleanup !== null) cleanup();
    };
  }, [video.id]);

  return (
    <section className="mk-video-player">
      <header className="mk-video-player-header">
        <button type="button" className="mk-back-btn" onClick={onClose}>
          ← back
        </button>
        <h2>{video.name}</h2>
      </header>
      <video
        ref={videoRef}
        controls
        preload="metadata"
        onPlaying={() => setStatus("playing")}
        crossOrigin="anonymous"
      >
        {subtitles.map((sub) => (
          <track
            key={sub.lang}
            kind="subtitles"
            srcLang={sub.lang === "und" ? undefined : sub.lang}
            label={sub.lang === "und" ? "Subtitles" : sub.lang.toUpperCase()}
            src={`/video/api/videos/${encodeURIComponent(video.id)}/subtitles/${encodeURIComponent(sub.lang)}`}
            default={sub.lang === "en" || (subtitles.length === 1 && sub.lang === "und")}
          />
        ))}
      </video>
      <p className="mk-video-player-status">{status}</p>
    </section>
  );
}
