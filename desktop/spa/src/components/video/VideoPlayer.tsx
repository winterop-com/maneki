/**
 * HTML5 <video> + hls.js + <track>. Plays the selected video via the HLS
 * endpoint; Safari plays HLS natively, other browsers attach hls.js.
 *
 * Subtitles come from /api/videos/{id}/subtitles - one <track> per language.
 * The browser surfaces them in the player's native track selector.
 *
 * When --auth is on, fetches go via authedFetch (Bearer header) for the
 * subtitle list. The <video> src is a plain URL - the server is expected
 * to gate HLS via the same middleware so unauthenticated requests 401.
 *
 * NOTE on auth + <video>: the browser can't easily attach Authorization
 * headers to <video src=...>. With --auth, HLS playback only works if the
 * SPA proxy / server allows the token via a cookie or query param, or
 * runs in same-origin where credentials are implicit. Server-side cookie
 * auth is a Stage 3 follow-up; for now --auth + HLS in the SPA needs
 * either localhost (no cross-origin) or no auth.
 */

import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
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

    if (el.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari natively plays HLS.
      el.src = url;
      el.play().catch((err: unknown) => {
        setStatus(`autoplay blocked: ${err instanceof Error ? err.message : String(err)}`);
      });
      return () => {
        el.removeAttribute("src");
        el.load();
      };
    }

    if (!Hls.isSupported()) {
      setStatus("HLS playback unsupported in this browser.");
      return undefined;
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

    return () => {
      hls.destroy();
      el.removeAttribute("src");
      el.load();
    };
  }, [video.id]);

  const onPlaying = (): void => setStatus("playing");

  return (
    <section className="video-player">
      <header className="player-header">
        <button type="button" className="player-back" onClick={onClose}>
          ← back
        </button>
        <h2>{video.name}</h2>
      </header>
      <video ref={videoRef} controls preload="metadata" onPlaying={onPlaying} crossOrigin="anonymous">
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
      <p className="player-status">{status}</p>
    </section>
  );
}
