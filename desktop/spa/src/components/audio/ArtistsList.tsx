/**
 * Top-level artists list. Calls /rest/getArtists once per mount.
 */

import { useEffect, useState } from "react";
import { useSubsonicSession } from "../../state/auth";
import { getArtists, coverArtUrl } from "../../state/subsonic";
import type { SubsonicArtist } from "../../state/subsonic";

interface ArtistsListProps {
  onSelect: (artist: SubsonicArtist) => void;
}

export function ArtistsList({ onSelect }: ArtistsListProps): React.ReactElement {
  const session = useSubsonicSession();
  const [artists, setArtists] = useState<SubsonicArtist[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (session === null) {
      setError("no Subsonic session - log in to access audio");
      return;
    }
    void getArtists(session)
      .then(setArtists)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [session]);

  if (error !== null) return <p className="error">{error}</p>;
  if (artists === null) return <p>loading artists...</p>;
  if (artists.length === 0) {
    return (
      <div className="mk-empty">
        <div className="mk-empty-title">No artists yet</div>
        <div className="mk-empty-sub">The server's library index may still be building.</div>
      </div>
    );
  }

  return (
    <>
      <h2>Artists</h2>
      <ul className="mk-cover-grid">
        {artists.map((a) => {
          const cover = session !== null ? coverArtUrl(session, a.coverArt, 200) : null;
          return (
            <li key={a.id}>
              <button type="button" className="mk-cover-card" onClick={() => onSelect(a)}>
                {cover !== null ? (
                  <img className="mk-cover-img" src={cover} alt="" loading="lazy" />
                ) : (
                  <div className="mk-cover-img empty">{a.name.slice(0, 1)}</div>
                )}
                <span className="mk-cover-title">{a.name}</span>
                {a.albumCount !== undefined && (
                  <span className="mk-cover-meta">{a.albumCount} albums</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
