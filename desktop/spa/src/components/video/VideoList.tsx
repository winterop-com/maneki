/**
 * List of every video the server knows about. Click a row to play it.
 * Styled with the legacy mk-* design tokens for consistency.
 */

import { useEffect, useState } from "react";
import { useAuth } from "../../state/auth";
import { fetchVideos, formatDuration, formatSize } from "../../state/videos";
import type { Video } from "../../state/videos";

interface VideoListProps {
  onSelect: (video: Video) => void;
}

export function VideoList({ onSelect }: VideoListProps): React.ReactElement {
  const { authedFetch } = useAuth();
  const [videos, setVideos] = useState<Video[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchVideos(authedFetch)
      .then((data) => setVideos(data))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [authedFetch]);

  if (error !== null) {
    return (
      <section className="mk-video-list">
        <h2>Video</h2>
        <p className="error">cannot list videos: {error}</p>
      </section>
    );
  }

  if (videos === null) {
    return (
      <section className="mk-video-list">
        <h2>Video</h2>
        <p>loading...</p>
      </section>
    );
  }

  if (videos.length === 0) {
    return (
      <section className="mk-video-list">
        <h2>Video</h2>
        <div className="mk-empty">
          <div className="mk-empty-title">No videos found</div>
          <div className="mk-empty-sub">Add files under &lt;root&gt;/videos/ and reload.</div>
        </div>
      </section>
    );
  }

  return (
    <section className="mk-video-list">
      <h2>Video</h2>
      <ul className="mk-video-rows">
        {videos.map((v) => (
          <li key={v.id}>
            <button type="button" className="mk-video-row" onClick={() => onSelect(v)}>
              <span className="mk-video-title">{v.name}</span>
              <span className="mk-video-meta">
                {formatDuration(v.duration_s)}  ·  {formatSize(v.size_bytes)}
                {v.subtitles.length > 0 && (
                  <span className="mk-sub-badge">
                    {" · "}
                    {v.subtitles.length} sub{v.subtitles.length === 1 ? "" : "s"}
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
