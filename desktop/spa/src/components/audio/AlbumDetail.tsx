/**
 * One album's track list via /rest/getAlbum?id=...
 *
 * Clicking a track sends it (with the rest of the album as the queue) to
 * the parent's onPlayTrack handler. The transport bar (commit 4c) drives
 * actual playback.
 */

import { useEffect, useState } from "react";
import { useSubsonicSession } from "../../state/auth";
import { getAlbum, coverArtUrl } from "../../state/subsonic";
import type { SubsonicAlbum, SubsonicSong } from "../../state/subsonic";

interface AlbumDetailProps {
  albumId: string;
  onPlayTrack: (track: SubsonicSong, queue: SubsonicSong[]) => void;
}

export function AlbumDetail({ albumId, onPlayTrack }: AlbumDetailProps): React.ReactElement {
  const session = useSubsonicSession();
  const [album, setAlbum] = useState<(SubsonicAlbum & { song?: SubsonicSong[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (session === null) {
      setError("no Subsonic session");
      return;
    }
    void getAlbum(session, albumId)
      .then((a) => setAlbum(a ?? null))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [session, albumId]);

  if (error !== null) return <p className="error">{error}</p>;
  if (album === null) return <p>loading album...</p>;

  const songs = album.song ?? [];
  const cover = session !== null ? coverArtUrl(session, album.coverArt, 400) : null;

  return (
    <div>
      <header className="mk-album-header-row">
        {cover !== null && <img src={cover} alt="" />}
        <div>
          <h2>{album.name}</h2>
          <p className="mk-album-line">
            {album.artist ?? "?"}
            {album.year !== undefined && `  ·  ${album.year}`}
            {`  ·  ${songs.length} tracks`}
          </p>
        </div>
      </header>
      <ol className="mk-track-list">
        {songs.map((s, i) => (
          <li key={s.id}>
            <button type="button" className="mk-track-row" onClick={() => onPlayTrack(s, songs)}>
              <span className="mk-track-num">{s.track ?? i + 1}</span>
              <span>{s.title}</span>
              <span className="mk-track-time">{formatTime(s.duration)}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

function formatTime(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return "--:--";
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
