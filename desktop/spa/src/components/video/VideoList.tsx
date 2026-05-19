/**
 * Grid of every video the server knows about. Click a row to play it.
 *
 * No artwork yet (Stage 3) - cells show name, duration, and size.
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
      <section className="placeholder">
        <h2>Video</h2>
        <p className="error">cannot list videos: {error}</p>
      </section>
    );
  }

  if (videos === null) {
    return (
      <section className="placeholder">
        <h2>Video</h2>
        <p>loading...</p>
      </section>
    );
  }

  if (videos.length === 0) {
    return (
      <section className="placeholder">
        <h2>Video</h2>
        <p>No videos under &lt;root&gt;/videos/.</p>
      </section>
    );
  }

  return (
    <section className="video-list">
      <h2>Video</h2>
      <ul>
        {videos.map((v) => (
          <li key={v.id}>
            <button type="button" className="video-row" onClick={() => onSelect(v)}>
              <span className="title">{v.name}</span>
              <span className="meta">
                {formatDuration(v.duration_s)}  ·  {formatSize(v.size_bytes)}
                {v.subtitles.length > 0 && (
                  <span className="subtitle-badge"> · {v.subtitles.length} sub{v.subtitles.length === 1 ? "" : "s"}</span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
