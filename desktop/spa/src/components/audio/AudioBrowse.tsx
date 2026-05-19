/**
 * Audio browse stack: Artists -> Artist detail -> Album detail.
 *
 * Uses an in-component history array to support a "back" button without
 * touching the URL. Selecting a track hands off to the parent so the
 * transport bar (commit 4c) can pick it up.
 */

import { useState } from "react";
import type { SubsonicSong } from "../../state/subsonic";
import { ArtistsList } from "./ArtistsList";
import { ArtistDetail } from "./ArtistDetail";
import { AlbumDetail } from "./AlbumDetail";

type View =
  | { kind: "artists" }
  | { kind: "artist"; artistId: string; artistName: string }
  | { kind: "album"; albumId: string };

interface AudioBrowseProps {
  onPlayTrack: (track: SubsonicSong, queue: SubsonicSong[]) => void;
}

export function AudioBrowse({ onPlayTrack }: AudioBrowseProps): React.ReactElement {
  const [stack, setStack] = useState<View[]>([{ kind: "artists" }]);
  const current = stack[stack.length - 1] ?? { kind: "artists" };

  const push = (v: View): void => setStack((prev) => [...prev, v]);
  const back = (): void => setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));

  return (
    <section className="audio-browse">
      {stack.length > 1 && (
        <button type="button" className="audio-back" onClick={back}>
          ← back
        </button>
      )}
      {current.kind === "artists" && (
        <ArtistsList
          onSelect={(a) => push({ kind: "artist", artistId: a.id, artistName: a.name })}
        />
      )}
      {current.kind === "artist" && (
        <ArtistDetail
          artistId={current.artistId}
          fallbackName={current.artistName}
          onSelectAlbum={(albumId) => push({ kind: "album", albumId })}
        />
      )}
      {current.kind === "album" && (
        <AlbumDetail albumId={current.albumId} onPlayTrack={onPlayTrack} />
      )}
    </section>
  );
}
