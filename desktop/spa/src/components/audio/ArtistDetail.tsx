/**
 * One artist's album list via /rest/getArtist?id=...
 */

import { useEffect, useState } from "react";
import { useSubsonicSession } from "../../state/auth";
import { getArtist, coverArtUrl } from "../../state/subsonic";
import type { SubsonicAlbum, SubsonicArtist } from "../../state/subsonic";

interface ArtistDetailProps {
  artistId: string;
  fallbackName: string;
  onSelectAlbum: (albumId: string) => void;
}

export function ArtistDetail({
  artistId,
  fallbackName,
  onSelectAlbum,
}: ArtistDetailProps): React.ReactElement {
  const session = useSubsonicSession();
  const [artist, setArtist] = useState<(SubsonicArtist & { album?: SubsonicAlbum[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (session === null) {
      setError("no Subsonic session");
      return;
    }
    void getArtist(session, artistId)
      .then((a) => setArtist(a ?? null))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [session, artistId]);

  if (error !== null) return <p className="error">{error}</p>;
  if (artist === null) return <p>loading {fallbackName}...</p>;

  const albums = artist.album ?? [];
  return (
    <>
      <h2>{artist.name}</h2>
      {albums.length === 0 ? (
        <div className="mk-empty"><div className="mk-empty-title">No albums for this artist.</div></div>
      ) : (
        <ul className="mk-cover-grid">
          {albums.map((al) => {
            const cover = session !== null ? coverArtUrl(session, al.coverArt, 200) : null;
            return (
              <li key={al.id}>
                <button type="button" className="mk-cover-card" onClick={() => onSelectAlbum(al.id)}>
                  {cover !== null ? (
                    <img className="mk-cover-img" src={cover} alt="" loading="lazy" />
                  ) : (
                    <div className="mk-cover-img empty">{al.name.slice(0, 1)}</div>
                  )}
                  <span className="mk-cover-title">{al.name}</span>
                  <span className="mk-cover-meta">
                    {al.year !== undefined && `${al.year}  ·  `}
                    {al.songCount ?? 0} tracks
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
