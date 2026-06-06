// Maneki chrome: top bar, main area panes (sidebar / albums / tracks /
// stations / starred), now-playing bar, fullscreen visualizer, tweaks UI.

import React from "react";

import { MK_AUDIO } from "./_audio.js";
import { fmtDur } from "./format.js";
import { TweaksPanel, TweakSection, TweakRadio, TweakSelect, TweakToggle, TweakSlider, TweakColor, TweakButton } from "./tweaks-panel.jsx";
import { VideosPane, VideoSearchPane, VideoPlayerPane } from "./video-views.jsx";
import { Visualizer } from "./visualizer.jsx";
import { StarBtn } from "./views.jsx";
import { wiredMakeCover as makeCover } from "./_wiring.jsx";

const fmtDur_ch = (s) => fmtDur(s);
// makeCover is declared globally by covers.jsx (function declaration)

function TopBar({ user, q, setQ, onFocusSearch, onSignOut, searchInputRef, showStats, onToggleStats }) {
  return (
    <div className="mk-topbar">
      <div className="mk-topbar-left">
        <div className="mk-search-wrap">
          <svg className="mk-search-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
          <input
            ref={searchInputRef}
            className="mk-search"
            placeholder="search…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onFocus={onFocusSearch}
            spellCheck={false}
          />
          <span className="mk-search-kbd">/</span>
          {q && <button className="mk-search-clear" onClick={() => setQ("")} aria-label="Clear search" data-tooltip="Clear (esc)" data-tooltip-placement="bottom">×</button>}
        </div>
      </div>
      <div className="mk-topbar-center">
        <span className="mk-brand">maneki</span>
        <span className="mk-version">v{__MK_VERSION__}</span>
      </div>
      <div className="mk-topbar-right">
        <button
          className={"mk-signout mk-stats-btn" + (showStats ? " mk-stats-toggle-on" : "")}
          onClick={onToggleStats}
          aria-label="Stream stats"
          data-tooltip="Stream stats"
          data-tooltip-placement="bottom"
          data-tooltip-align="right"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
        </button>
        <span className="mk-user">{user}</span>
        <button className="mk-signout" onClick={onSignOut} data-tooltip="Clear session and sign out" data-tooltip-placement="bottom" data-tooltip-align="right">Sign out</button>
      </div>
    </div>
  );
}

// Vertical kind-rail: the leftmost column. The parent gates rendering on
// hasAudio && hasVideo, so this component just renders the two tabs.
// Labels are typeset vertically (writing-mode rotation) - no icon, just
// the kind name large and clear.
function KindRail({ kind, setKind, hasAudio = true, hasVideo = true }) {
  // Hide the rail entirely when only one kind is mounted - there's
  // nothing to switch between, and the empty rail just steals
  // horizontal space and gives a confusing visual hint that a
  // disabled tab exists.
  if (!hasAudio || !hasVideo) return null;
  return (
    <div className="mk-kind-rail">
      <button
        type="button"
        className={"mk-kind-tab" + (kind === "audio" ? " active" : "")}
        onClick={() => setKind("audio")}
        title="Audio"
      >
        <span className="mk-kind-label">AUDIO</span>
      </button>
      <button
        type="button"
        className={"mk-kind-tab" + (kind === "video" ? " active" : "")}
        onClick={() => setKind("video")}
        title="Video"
      >
        <span className="mk-kind-label">VIDEO</span>
      </button>
    </div>
  );
}

// Sidebar - per-kind. Audio mode shows Radio / Starred / Artists.
// Video mode renders nothing here - the video list IS the primary view, so
// there's no need for a sidebar nav with a single "Videos" item. When
// movies / shows / continue-watching land later, a video sidebar with
// real nav items can come back.
// Draggable column divider between the video list and the player pane.
// Lives inside the .mk-browse-video grid (column 2 of 3). On mousedown
// it captures the initial pointer X and the current list-column width,
// then on mousemove updates the --mk-video-list-w CSS variable on the
// parent grid. Width is intentionally NOT persisted — starts fresh at
// the CSS default (480px) on every page load.
function VideoSplitter() {
  const { useCallback } = React;
  const onMouseDown = useCallback((e) => {
    e.preventDefault();
    const grid = e.currentTarget.parentElement;
    if (!grid) return;
    const startX = e.clientX;
    const computed = getComputedStyle(grid).getPropertyValue("--mk-video-list-w").trim();
    const startW = parseFloat(computed) || grid.querySelector(".mk-albums-pane")?.getBoundingClientRect().width || 480;
    const gridW = grid.getBoundingClientRect().width;
    // Hard floor so the list stays usable; hard ceiling that always
    // leaves at least 360px for the player and never exceeds 70% of
    // the grid width (whichever is stricter).
    const minW = 280;
    const maxW = Math.max(minW + 80, Math.min(Math.floor(gridW - 360), Math.floor(gridW * 0.7)));
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev) => {
      const next = Math.min(maxW, Math.max(minW, startW + (ev.clientX - startX)));
      grid.style.setProperty("--mk-video-list-w", next + "px");
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);
  return (
    <div
      className="mk-vsplit"
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize"
    />
  );
}

// Drag handle that resizes the topband spectrum canvas. Height is stored
// as a CSS variable (--mk-spectrum-h) on the document root and persisted
// to localStorage so it survives reloads. Lives as the last grid item of
// .mk-now (spans both columns) so the grip sits along the bottom edge of
// the now-playing band -- drag down to grow the spectrum, up to shrink.
const MK_SPECTRUM_H_KEY = "mk.spectrumH";
const MK_SPECTRUM_H_MIN = 80;
const MK_SPECTRUM_H_MAX = 600;
const MK_SPECTRUM_H_DEFAULT = 132;

function applyStoredSpectrumHeight() {
  let h = parseInt(window.localStorage.getItem(MK_SPECTRUM_H_KEY), 10);
  if (!Number.isFinite(h)) h = MK_SPECTRUM_H_DEFAULT;
  h = Math.min(MK_SPECTRUM_H_MAX, Math.max(MK_SPECTRUM_H_MIN, h));
  document.documentElement.style.setProperty("--mk-spectrum-h", h + "px");
}

function SpectrumResizer() {
  const { useCallback, useEffect } = React;
  // Apply the persisted height once on mount so the canvas opens at the
  // last-used size instead of the CSS default.
  useEffect(() => { applyStoredSpectrumHeight(); }, []);
  const onMouseDown = useCallback((e) => {
    e.preventDefault();
    const root = document.documentElement;
    const startY = e.clientY;
    const startH = parseInt(getComputedStyle(root).getPropertyValue("--mk-spectrum-h"), 10) || MK_SPECTRUM_H_DEFAULT;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev) => {
      const next = Math.min(MK_SPECTRUM_H_MAX, Math.max(MK_SPECTRUM_H_MIN, startH + (ev.clientY - startY)));
      root.style.setProperty("--mk-spectrum-h", next + "px");
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      const h = parseInt(getComputedStyle(root).getPropertyValue("--mk-spectrum-h"), 10);
      if (Number.isFinite(h)) window.localStorage.setItem(MK_SPECTRUM_H_KEY, String(h));
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);
  return (
    <div
      className="mk-spectrum-resize"
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation="horizontal"
      title="Drag to resize spectrum"
    />
  );
}

function Sidebar({ kind, section, setSection, ARTISTS, artistId, setArtistId, loaded }) {
  if (kind === "video") return null;
  return (
    <div className="mk-sidebar mk-pane">
      <div className="mk-pane-section">
        <div className="mk-pane-label">Radio</div>
        <div
          className={"mk-nav-item" + (section === "stations" ? " active" : "")}
          onClick={() => setSection("stations")}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4.93 19.07a10 10 0 010-14.14"/><path d="M19.07 4.93a10 10 0 010 14.14"/>
            <path d="M7.76 16.24a6 6 0 010-8.48"/><path d="M16.24 7.76a6 6 0 010 8.48"/>
            <circle cx="12" cy="12" r="2"/>
          </svg>
          Stations
        </div>
      </div>
      <div className="mk-pane-section">
        <div className="mk-pane-label">Starred</div>
        <div
          className={"mk-nav-item" + (section === "starred" ? " active" : "")}
          onClick={() => setSection("starred")}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 21s-7.5-4.5-9.5-9.5C1 7 4.5 4 8 4c2 0 3.5 1 4 2 .5-1 2-2 4-2 3.5 0 7 3 5.5 7.5C19.5 16.5 12 21 12 21z"/></svg>
          Tracks
        </div>
      </div>
      <div className="mk-pane-section mk-artists">
        <div className="mk-pane-label" style={{ display: "flex", justifyContent: "space-between" }}>
          <span>Artists</span>
          <span className="mk-count">({ARTISTS.length})</span>
        </div>
        <div className="mk-artist-list">
          {!loaded && [0,1,2,3].map((i) => <div key={i} className="mk-skel" style={{height: 14, margin: "6px 0"}}/>)}
          {loaded && ARTISTS.map((a) => (
            <div
              key={a.id}
              className={"mk-artist-row" + (section === "library" && artistId === a.id ? " active" : "")}
              onClick={() => { setArtistId(a.id); }}
            >
              {a.name}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Albums column (middle pane).
function AlbumsPane({ artist, albumId, setAlbumId, loaded }) {
  if (!artist) {
    return (
      <div className="mk-pane mk-albums-pane">
        <div className="mk-pane-label">Albums</div>
        <div className="mk-empty">
          <div className="mk-empty-icon"><svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/></svg></div>
          <div className="mk-empty-title">Pick an artist</div>
          <div className="mk-empty-sub">to see their albums here.</div>
        </div>
      </div>
    );
  }
  return (
    <div className="mk-pane mk-albums-pane">
      <div className="mk-pane-label">{artist.name.toUpperCase()}</div>
      <div className="mk-album-list">
        {!loaded && [0,1].map((i) => <div key={i} className="mk-album-row"><div className="mk-skel" style={{width: 56, height: 56}}/><div style={{flex:1}}><div className="mk-skel" style={{width:"60%", height:14, marginBottom:6}}/><div className="mk-skel" style={{width:"30%", height:10}}/></div></div>)}
          {loaded && artist.albums.map((al) => (
            <div
              key={al.id}
              className={"mk-album-row" + (albumId === al.id ? " active" : "")}
              onClick={() => setAlbumId(al.id)}
            >
              <img src={makeCover(al.cover, al.color)} alt="" className="mk-album-cover-sm"/>
              <div className="mk-album-meta">
                <div className="mk-album-name">{al.name}</div>
                <div className="mk-album-sub"><span className="mono">{al.year}</span> <span className="mk-album-count">{al.trackCount} tracks</span></div>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

// Derive the "Up Next" list from the currently-playing album. Mirrors the
// album-order next/prev navigation in app.jsx (index-based, so duplicate
// track numbers on compilations stay correct) and honours repeat mode:
//   - "track": the same track repeats, so Up Next is empty
//   - "album": wrap past the end back to the album start
//   - "off":   just the tail after the current track
// Returns [] when nothing is playing, the playing album isn't the one in
// view, or a radio station is playing (no album queue).
function deriveUpNext(nowAlbum, now, repeat, max = 30) {
  if (!nowAlbum || !now || now.stationId) return [];
  const tracks = nowAlbum.tracks || [];
  const idx = tracks.findIndex((tr) => tr.trackId === now.trackId);
  if (idx < 0) return [];
  if (repeat === "track") return [];
  const tail = tracks.slice(idx + 1);
  const rest = repeat === "album" ? tail.concat(tracks.slice(0, idx)) : tail;
  return rest.slice(0, max);
}

// Tracks column (right pane). When a track from THIS album is playing, an
// "Up Next" queue is rendered below the track table to fill the lower
// area; it's derived (no queue state) and follows repeat mode.
function TracksPane({ artist, album, playTrack, now, nowAlbum, repeat, isStarred, toggleStar, loaded }) {
  const upNext = (album && nowAlbum && album.id === nowAlbum.id)
    ? deriveUpNext(nowAlbum, now, repeat)
    : [];
  if (!album) {
    return (
      <div className="mk-pane mk-tracks-pane">
        <div className="mk-pane-label">Tracks</div>
        <div className="mk-empty">
          <div className="mk-empty-icon"><svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>
          <div className="mk-empty-title">Pick an album</div>
          <div className="mk-empty-sub">to see its tracks here.</div>
        </div>
      </div>
    );
  }
  return (
    <div className="mk-pane mk-tracks-pane">
      <div className="mk-album-header">
        <div className="mk-album-header-title">{album.name}</div>
        <div className="mk-album-header-sub">{artist.name} · <span className="mono">{album.year}</span> · {album.trackCount} tracks</div>
      </div>
      <div className="mk-track-scroll">
        <table className="mk-track-table">
          <thead>
            <tr><th className="t-n">#</th><th className="t-title">TITLE</th><th className="t-artist">ARTIST</th><th className="t-time">TIME</th><th className="t-star"></th></tr>
          </thead>
          <tbody>
            {!loaded && [0,1,2,3,4].map((i) => <tr key={i}><td colSpan="5"><div className="mk-skel" style={{height: 16, margin: "4px 0"}}/></td></tr>)}
            {loaded && album.tracks.map((tr) => {
              const key = `${artist.id}/${album.id}/${tr.n}`;
              // Match on trackId, not trackN: compilations restart their
              // numbering per disc (e.g. 1-16 then 1-14), so tr.n is not
              // unique within an album. Comparing on it lights up every
              // row that shares the number.
              const isNow = now?.albumId === album.id && now?.trackId === tr.trackId;
              return (
                <tr
                  key={tr.trackId}
                  className={"mk-track-row" + (isNow ? " now" : "")}
                  onDoubleClick={() => playTrack(artist.id, album.id, tr.n, tr.trackId)}
                  onClick={() => playTrack(artist.id, album.id, tr.n, tr.trackId)}
                >
                  <td className="t-n mono">{tr.n}</td>
                  <td className="t-title">{tr.title}</td>
                  <td className="t-artist">{artist.name}</td>
                  <td className="t-time mono">{tr.time}</td>
                  <td className="t-star">
                    <StarBtn on={isStarred(key)} onToggle={() => toggleStar(key)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {upNext.length > 0 && (
          <div className="mk-upnext">
            <div className="mk-pane-label mk-upnext-label">Up Next</div>
            <table className="mk-track-table">
              <tbody>
                {upNext.map((tr, i) => (
                  <tr
                    key={tr.trackId}
                    className="mk-track-row mk-upnext-row"
                    onClick={() => playTrack(artist.id, album.id, tr.n, tr.trackId)}
                  >
                    <td className="t-n mono">{i + 1}</td>
                    <td className="t-title">{tr.title}</td>
                    <td className="t-artist">{artist.name}</td>
                    <td className="t-time mono">{tr.time}</td>
                    <td className="t-star"></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// Stations pane (when section === "stations").
function StationsPane({ STATIONS, playStation, now, loaded }) {
  return (
    <div className="mk-pane mk-stations-pane mk-pane-wide">
      <div className="mk-pane-label">Stations</div>
      {!loaded && <div style={{padding:"12px"}}><div className="mk-skel" style={{height:36, marginBottom:12}}/><div className="mk-skel" style={{height:36, marginBottom:12}}/></div>}
      {loaded && (
        <div className="mk-station-list">
          {STATIONS.map((s) => {
            const isNow = now?.stationId === s.id;
            return (
              <div key={s.id} className={"mk-station-row" + (isNow ? " active" : "")} onClick={() => playStation(s.id)}>
                <div className="mk-station-icon">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M4.93 19.07a10 10 0 010-14.14"/><path d="M19.07 4.93a10 10 0 010 14.14"/>
                    <path d="M7.76 16.24a6 6 0 010-8.48"/><path d="M16.24 7.76a6 6 0 010 8.48"/>
                    <circle cx="12" cy="12" r="2"/>
                  </svg>
                </div>
                <div className="mk-station-meta">
                  <div className="mk-station-name">{s.name}</div>
                  <div className="mk-station-url mono">{s.url}</div>
                </div>
                <div className="mk-station-country mono">{s.country}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StarredPane({ starredTracks, playTrack, toggleStar }) {
  return (
    <div className="mk-pane mk-starred-pane mk-pane-wide">
      <div className="mk-album-header">
        <div className="mk-album-header-title">Starred</div>
        <div className="mk-album-header-sub">{starredTracks.length} {starredTracks.length === 1 ? "track" : "tracks"}</div>
      </div>
      {starredTracks.length === 0 ? (
        <div className="mk-empty">
          <div className="mk-empty-icon"><svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 21s-7.5-4.5-9.5-9.5C1 7 4.5 4 8 4c2 0 3.5 1 4 2 .5-1 2-2 4-2 3.5 0 7 3 5.5 7.5C19.5 16.5 12 21 12 21z"/></svg></div>
          <div className="mk-empty-title">Nothing starred yet</div>
          <div className="mk-empty-sub">Tap the heart on any track, album, or artist — it syncs everywhere Maneki is signed in.</div>
        </div>
      ) : (
        <div className="mk-track-scroll">
          <table className="mk-track-table">
            <thead><tr><th className="t-n">#</th><th className="t-title">TITLE</th><th className="t-artist">ARTIST</th><th className="t-time">TIME</th><th className="t-star"></th></tr></thead>
            <tbody>
              {starredTracks.map((tr, i) => (
                <tr key={tr.key} className="mk-track-row" onClick={() => playTrack(tr.artistId, tr.albumId, tr.n, tr.trackId)}>
                  <td className="t-n mono">{i+1}</td>
                  <td className="t-title">{tr.title}</td>
                  <td className="t-artist">{tr.artistName}</td>
                  <td className="t-time mono">{tr.time}</td>
                  <td className="t-star"><StarBtn on={true} onToggle={() => toggleStar(tr.key)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Now Playing panel — three layouts share its internal pieces.
// 14-segment LCD glyph — minimal, recognizable as segmented digital
function LCDChar({ ch }) {
  // Use overlay technique: render real char in a digital-style font and overlay
  // dim "ghost" 8s underneath to evoke segmented display feel.
  return (
    <span className="mk-lcd-ch">
      <span className="mk-lcd-ghost" aria-hidden="true">8</span>
      <span className="mk-lcd-fg">{ch === " " ? "\u00A0" : ch}</span>
    </span>
  );
}
function LCDText({ text, len }) {
  const padded = (text || "").padEnd(len, " ").slice(0, len);
  return (
    <span className="mk-lcd-text">
      {[...padded].map((c, i) => <LCDChar key={i} ch={c.toUpperCase()}/>)}
    </span>
  );
}
function LCDTime({ value }) {
  const m = Math.floor(value / 60);
  const s = Math.floor(value % 60);
  const str = `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  return <LCDText text={str} len={5}/>;
}
function LCDDisplay({ has, title, sub1, sub2, year, format, pos, dur, playing, muted, vol, nowStation, cover }) {
  // Marquee long titles
  const fullLine = has ? `${title}${sub1 ? "  -  " + sub1 : ""}${sub2 ? "  -  " + sub2 : ""}` : "NO DISC";
  const W = 22;
  const [scroll, setScroll] = React.useState(0);
  React.useEffect(() => { setScroll(0); }, [fullLine]);
  React.useEffect(() => {
    if (!playing || fullLine.length <= W) return;
    const id = setInterval(() => setScroll((s) => (s + 1) % (fullLine.length + 4)), 320);
    return () => clearInterval(id);
  }, [playing, fullLine, W]);
  const padded = fullLine.length > W
    ? (fullLine + "    " + fullLine).slice(scroll, scroll + W)
    : fullLine;

  // Fake VU meter levels — driven by playing state
  const [vu, setVu] = React.useState([0, 0]);
  React.useEffect(() => {
    if (!playing || muted) { setVu([0, 0]); return; }
    const id = setInterval(() => {
      setVu([0.45 + Math.random() * 0.5, 0.45 + Math.random() * 0.5]);
    }, 120);
    return () => clearInterval(id);
  }, [playing, muted]);

  const total = dur || 0;
  const remaining = Math.max(0, total - pos);
  const trackNo = nowStation ? "FM" : (has ? "01" : "--");

  return (
    <div className="mk-lcd" role="group" aria-label="LCD display">
      <div className="mk-lcd-bezel">
        <div className="mk-lcd-glass">
          {/* Top status row: mode indicators */}
          <div className="mk-lcd-status">
            <span className={"mk-lcd-pill" + (playing ? " on" : "")}>{playing ? "\u25B6 PLAY" : "\u2759\u2759 PAUSE"}</span>
            <span className={"mk-lcd-pill" + (nowStation ? " on" : "")}>RADIO</span>
            <span className={"mk-lcd-pill on"}>STEREO</span>
            <span className={"mk-lcd-pill" + (muted ? " on" : "")}>MUTE</span>
            <span className="mk-lcd-pill on">DOLBY</span>
          </div>

          {/* Big marquee line */}
          <div className="mk-lcd-marquee">
            <LCDText text={padded} len={W}/>
          </div>

          {/* Secondary row: track # · time · remaining */}
          <div className="mk-lcd-row2">
            <div className="mk-lcd-track">
              <span className="mk-lcd-mini">TR</span>
              <LCDText text={trackNo} len={2}/>
            </div>
            <div className="mk-lcd-clock">
              <span className="mk-lcd-mini">ELAPSED</span>
              <LCDTime value={pos}/>
            </div>
            <div className="mk-lcd-clock">
              <span className="mk-lcd-mini">REMAIN</span>
              {total ? <LCDTime value={remaining}/> : <LCDText text="--:--" len={5}/>}
            </div>
          </div>

          {/* VU bar */}
          <div className="mk-lcd-vu">
            <div className="mk-lcd-vu-row">
              <span className="mk-lcd-mini">L</span>
              <div className="mk-lcd-vu-bar">
                {Array.from({ length: 18 }).map((_, i) => (
                  <span key={i} className={"mk-lcd-vu-seg" + (i / 18 < vu[0] ? " on" : "") + (i >= 14 ? " peak" : i >= 11 ? " hi" : "")}/>
                ))}
              </div>
            </div>
            <div className="mk-lcd-vu-row">
              <span className="mk-lcd-mini">R</span>
              <div className="mk-lcd-vu-bar">
                {Array.from({ length: 18 }).map((_, i) => (
                  <span key={i} className={"mk-lcd-vu-seg" + (i / 18 < vu[1] ? " on" : "") + (i >= 14 ? " peak" : i >= 11 ? " hi" : "")}/>
                ))}
              </div>
            </div>
          </div>

          {/* Footer: meta */}
          <div className="mk-lcd-footer">
            <span className="mk-lcd-mini">YR</span><LCDText text={String(year || "----")} len={4}/>
            <span className="mk-lcd-mini">FMT</span><LCDText text={format || "---"} len={4}/>
            <span className="mk-lcd-mini">VOL</span><LCDText text={String(Math.round((muted ? 0 : vol) * 100)).padStart(3,"0")} len={3}/>
          </div>
        </div>
        {/* Scanline + glass sheen overlays */}
        <div className="mk-lcd-scanlines" aria-hidden="true"></div>
        <div className="mk-lcd-sheen" aria-hidden="true"></div>
      </div>
    </div>
  );
}

// Click-through order for the spectrum panel. Matches the Style dropdown
// in TweaksControls so clicking the panel walks the same list.
const VIZ_ORDER = ["bars", "mirror", "ridge", "scope"];

// Verdict for the audio stats overlay. The <audio> element is the single
// source of truth: a deep buffer (or readyState HAVE_ENOUGH_DATA) is
// healthy; a thin buffer while still loading is buffering; no usable data
// is a stall. This is the audio analogue of diagnosePlayback() for video,
// minus the encoder dimension (audio is served as a plain ranged file, so
// there's no transcode wall to hit).
function audioVerdict(s) {
  if (!s) return { level: "idle", text: "connecting…" };
  if (s.paused) return { level: "idle", text: "paused" };
  const buf = s.bufferAhead;
  if (s.readyState >= 4 || buf >= 10) return { level: "ok", text: `healthy — ${buf.toFixed(0)}s buffered ahead` };
  if (s.readyState <= 1) return { level: "warn", text: "stalled — waiting for data" };
  if (s.networkState === 2) return { level: "warn", text: `buffering — ${buf.toFixed(0)}s ahead` };
  return { level: "warn", text: `thin buffer — ${buf.toFixed(0)}s ahead` };
}

// Live audio diagnostics overlay. Unlike the video panel there's no SSE:
// audio has no per-segment transcode pipeline to report on, so everything
// is sampled off MK_AUDIO's <audio> element once a second. Draggable by its
// header (pointer capture keeps a drag from leaking to the UI underneath),
// reusing the same .mk-stats-* chrome as the video overlay.
function AudioStatsOverlay({ format, onClose }) {
  const { useState, useEffect, useRef } = React;
  const rootRef = useRef(null);
  const [pos, setPos] = useState({ x: 14, y: 14 });
  const [s, setS] = useState(null);

  useEffect(() => {
    const parent = rootRef.current && rootRef.current.parentElement;
    if (parent) {
      const r = parent.getBoundingClientRect();
      setPos({ x: Math.round(r.left + 14), y: Math.round(r.top + 14) });
    }
  }, []);

  useEffect(() => {
    const sample = () => { if (MK_AUDIO?.getStats) setS(MK_AUDIO.getStats()); };
    sample();
    const id = setInterval(sample, 1000);
    return () => clearInterval(id);
  }, []);

  const startDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    try { handle.setPointerCapture(e.pointerId); } catch (_x) { /* unsupported */ }
    const box = handle.parentElement.getBoundingClientRect();
    const offX = e.clientX - box.left, offY = e.clientY - box.top, w = box.width, h = box.height;
    const move = (ev) => setPos({
      x: Math.min(Math.max(0, ev.clientX - offX), Math.max(0, window.innerWidth - w)),
      y: Math.min(Math.max(0, ev.clientY - offY), Math.max(0, window.innerHeight - h)),
    });
    const up = (ev) => {
      try { handle.releasePointerCapture(ev.pointerId); } catch (_x) { /* already released */ }
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };

  const READY = ["nothing", "metadata", "current", "future", "enough"];
  const NET = ["empty", "idle", "loading", "no-source"];
  const diag = audioVerdict(s);
  const Row = ({ k, v }) => (<><span>{k}</span><span>{v}</span></>);
  return (
    <div ref={rootRef} className="mk-stats-overlay mono" style={{ left: pos.x + "px", top: pos.y + "px" }}>
      <div className={"mk-stats-verdict mk-stats-" + diag.level} onPointerDown={startDrag} title="Drag to move">
        <span className="mk-stats-verdict-text">{diag.text}</span>
        {onClose && (
          <button
            className="mk-stats-close"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onClose}
            aria-label="Close stats"
            title="Close"
          >×</button>
        )}
      </div>
      <div className="mk-stats-grid">
        <Row k="buffer ahead" v={s ? `${s.bufferAhead.toFixed(1)}s` : "—"} />
        <Row k="ready" v={s ? (READY[s.readyState] ?? s.readyState) : "—"} />
        <Row k="network" v={s ? (NET[s.networkState] ?? s.networkState) : "—"} />
        <Row k="stalls" v={s ? s.stalls : "—"} />
        <Row k="format" v={format || "—"} />
        <Row k="position" v={s && s.duration ? `${s.currentTime.toFixed(0)} / ${s.duration.toFixed(0)}s` : "—"} />
      </div>
    </div>
  );
}

function NowPlaying({ nowTrack, nowArtist, nowAlbum, nowStation, radioTitle, playing, muted, vol, setVol, pos, setPos, dur, handlePlayPause, handleNext, handlePrev, setMuted, palette, vizStyle, tweak, fullscreenViz, setFullscreenViz, showSpectrum, layout, lcd, lcdColor, showStats, onCloseStats }) {
  const cycleViz = () => {
    const i = VIZ_ORDER.indexOf(vizStyle);
    tweak("viz", VIZ_ORDER[(i + 1) % VIZ_ORDER.length]);
  };
  const has = !!(nowTrack || nowStation);
  const title = nowStation?.name || nowTrack?.title || "Nothing playing";
  // For a station the subtitle carries the live ICY StreamTitle (current
  // song / programme) when the server has parsed one, else the "Radio" label.
  const sub1 = nowStation ? (radioTitle || "Radio") : nowArtist?.name;
  const sub2 = nowStation ? null : nowAlbum?.name;
  const year = nowStation ? "—" : nowAlbum?.year;
  const format = nowStation ? "Stream" : "M4A";
  const cover = nowStation ? null : (nowAlbum ? makeCover(nowAlbum.cover, nowAlbum.color) : null);

  return (
    <div className={"mk-now" + (has ? " has-track" : " no-track") + " layout-" + layout + (lcd ? " mk-now-lcd" : "")} data-lcd-color={lcdColor || "green"}>
      <div className="mk-now-pane">
        <div className="mk-pane-label">Now Playing</div>
        {showStats && has && <AudioStatsOverlay format={format} onClose={onCloseStats} />}
        <div className="mk-now-body">
          {lcd ? (
            <LCDDisplay has={has} title={title} sub1={sub1} sub2={sub2} year={year} format={format} pos={pos} dur={dur} playing={playing} muted={muted} vol={vol} nowStation={nowStation} cover={cover}/>
          ) : (<>
          <div className="mk-now-cover">
            {cover ? <img src={cover} alt="" /> : <div className="mk-now-cover-empty"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>}
          </div>
          <div className="mk-now-info">
            <div className={"mk-now-title" + (has ? "" : " idle")}>{title}</div>
            <div className="mk-now-sub">
              {sub1 || "—"}
              {sub2 && <> <span className="mk-dot">·</span> <span className="mk-now-album">{sub2}</span></>}
            </div>
            <div className="mk-now-meta mono">
              <span className="mk-meta-key">Year:</span> <span className="mk-meta-val">{year || "—"}</span>
              <span className="mk-dot">·</span>
              <span className="mk-meta-key">Format:</span> <span className="mk-meta-val">{has ? format : "—"}</span>
            </div>
          </div>
          </>)}
          <div className="mk-transport">
            <button className="mk-tbtn" onClick={handlePrev} aria-label="Previous" data-tooltip="Previous (p)">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M6 6h2v12H6zM20 6v12L9 12z"/></svg>
            </button>
            <button className={"mk-tbtn mk-tbtn-play" + (playing ? " playing" : "")} onClick={handlePlayPause} aria-label="Play/pause" data-tooltip={playing ? "Pause (space)" : "Play (space)"}>
              {playing
                ? <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>
                : <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M7 5l13 7-13 7z"/></svg>}
            </button>
            <button className="mk-tbtn" onClick={handleNext} aria-label="Next" data-tooltip="Next (n)">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M16 6h2v12h-2zM4 6l11 6-11 6z"/></svg>
            </button>
            <button className={"mk-tbtn" + (muted ? " muted" : "")} onClick={() => setMuted(!muted)} aria-label="Mute" data-tooltip={muted ? "Unmute (m)" : "Mute (m)"}>
              {muted
                ? <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M3 10v4h4l5 4V6L7 10H3zM16 8l5 5m0-5l-5 5" stroke="currentColor" strokeWidth="2"/></svg>
                : <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M3 10v4h4l5 4V6L7 10H3zM16 7c2 2 2 8 0 10M19 4c4 4 4 12 0 16"/></svg>}
            </button>
            <input
              className="mk-vol"
              type="range" min="0" max="1" step="0.01"
              value={muted ? 0 : vol}
              onChange={(e) => { setVol(parseFloat(e.target.value)); if (muted) setMuted(false); }}
            />
          </div>
        </div>
        <div className="mk-scrub-row">
          <span className="mk-scrub-state">
            {playing ? <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor"><path d="M7 5l13 7-13 7z"/></svg>
                     : <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>}
          </span>
          <span className="mk-scrub-time mono">{fmtDur_ch(pos)}</span>
          <div className="mk-scrub-bar">
            <input
              className="mk-scrub"
              type="range" min="0" max={Math.max(1, dur)} step="1"
              value={Math.min(pos, dur || 0)}
              onChange={(e) => { const v = parseFloat(e.target.value); setPos(v); MK_AUDIO?.seek?.(v); }}
              disabled={!has || !dur}
              style={{ "--mk-progress": `${dur ? (pos / dur) * 100 : 0}%` }}
            />
          </div>
          <span className="mk-scrub-time mono">{has && dur ? fmtDur_ch(dur) : "—:—"}</span>
        </div>
      </div>

      {showSpectrum && layout !== "bottombar" && (
        <div className="mk-spectrum-pane">
          <div className="mk-pane-label">
            Spectrum
            <button className="mk-fs-btn" data-tooltip="Fullscreen (f)" aria-label="Fullscreen visualizer" onClick={() => setFullscreenViz(true)}>
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6"/></svg>
            </button>
          </div>
          <div
            className="mk-spectrum-canvas"
            style={{ cursor: "pointer" }}
            onClick={cycleViz}
          >
            <Visualizer style={vizStyle} running={playing && !muted} accent={palette.viz} />
          </div>
        </div>
      )}
      {showSpectrum && layout === "topband" && <SpectrumResizer />}
    </div>
  );
}

function FullscreenViz({ onClose, vizStyle, tweak, running, palette, nowTrack, nowArtist, nowAlbum, nowStation, radioTitle, pos, dur, playing, onPlayPause, onPrev, onNext }) {
  const cycleViz = () => {
    const i = VIZ_ORDER.indexOf(vizStyle);
    tweak("viz", VIZ_ORDER[(i + 1) % VIZ_ORDER.length]);
  };
  const title = nowStation?.name || nowTrack?.title || "—";
  const sub = nowStation ? (radioTitle || "Radio") : (nowArtist ? `${nowArtist.name} · ${nowAlbum?.name || ""}` : "");
  const cover = nowAlbum ? makeCover(nowAlbum.cover, nowAlbum.color) : null;
  return (
    <div className="mk-fullscreen-viz">
      <button className="mk-fs-close" onClick={onClose} aria-label="Close fullscreen" data-tooltip="Close (esc)" data-tooltip-placement="bottom">×</button>
      <div className="mk-fs-head">
        {cover && <img src={cover} className="mk-fs-cover" alt=""/>}
        <div className="mk-fs-meta">
          <div className="mk-fs-title">{title}</div>
          <div className="mk-fs-sub">{sub}</div>
        </div>
      </div>
      <div className="mk-fs-canvas" style={{ cursor: "pointer" }} onClick={cycleViz}>
        <Visualizer style={vizStyle} running={running} accent={palette.viz} dense />
      </div>
      <div className="mk-fs-controls">
        <button className="mk-tbtn" onClick={onPrev} aria-label="Previous" data-tooltip="Previous (p)"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M6 6h2v12H6zM20 6v12L9 12z"/></svg></button>
        <button className={"mk-tbtn mk-tbtn-play" + (playing ? " playing" : "")} onClick={onPlayPause} aria-label="Play/pause" data-tooltip={playing ? "Pause (space)" : "Play (space)"}>
          {playing
            ? <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>
            : <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7 5l13 7-13 7z"/></svg>}
        </button>
        <button className="mk-tbtn" onClick={onNext} aria-label="Next" data-tooltip="Next (n)"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M16 6h2v12h-2zM4 6l11 6-11 6z"/></svg></button>
        <span className="mk-fs-time mono">{fmtDur_ch(pos)} / {dur ? fmtDur_ch(dur) : "live"}</span>
      </div>
      <div className="mk-fs-hint mono">esc to exit · f to toggle</div>
    </div>
  );
}

// Main area router: renders the right panes per section + the now-playing.
function MainArea(props) {
  const { t, tweak, section, setSection, loaded, ARTISTS, STATIONS, artist, artistId, setArtistId, album, albumId, setAlbumId,
          playTrack, playStation, now, nowTrack, nowStation, nowArtist, nowAlbum, radioTitle,
          starredTracks, isStarred, toggleStar,
          playing, muted, vol, setVol, pos, setPos, dur,
          setMuted, handlePlayPause, handleNext, handlePrev, palette, fullscreenViz, setFullscreenViz, setShowLyrics, repeat,
          showStats, onCloseStats } = props;

  const nowPlaying = (
    <NowPlaying
      nowTrack={nowTrack} nowArtist={nowArtist} nowAlbum={nowAlbum} nowStation={nowStation} radioTitle={radioTitle}
      playing={playing} muted={muted} vol={vol} setVol={setVol}
      pos={pos} setPos={setPos} dur={dur}
      handlePlayPause={handlePlayPause} handleNext={handleNext} handlePrev={handlePrev}
      setMuted={setMuted}
      palette={palette} vizStyle={t.viz} tweak={tweak}
      fullscreenViz={fullscreenViz} setFullscreenViz={setFullscreenViz}
      showSpectrum={t.showSpectrum}
      layout={t.layout}
      lcd={t.lcd}
      lcdColor={t.lcdColor}
      showStats={showStats}
      onCloseStats={onCloseStats}
    />
  );

  const { kind, session, selectedVideo, setSelectedVideo, q } = props;
  const videoMode = kind === "video";
  const videoSearchActive = videoMode && (q || "").trim().length > 0;
  const browse = (
    <div className={"mk-browse" + (videoMode ? " mk-browse-video" : "")}>
      <Sidebar kind={kind} section={section} setSection={setSection} ARTISTS={ARTISTS} artistId={artistId} setArtistId={(id) => { setSection("library"); setArtistId(id); }} loaded={loaded}/>
      {!videoMode && section === "library" && <AlbumsPane artist={artist} albumId={albumId} setAlbumId={setAlbumId} loaded={loaded}/>}
      {!videoMode && section === "library" && <TracksPane artist={artist} album={album} playTrack={playTrack} now={now} nowAlbum={nowAlbum} repeat={t.repeat} isStarred={isStarred} toggleStar={toggleStar} loaded={loaded && (!album || album.tracksLoaded)}/>}
      {!videoMode && section === "stations" && <StationsPane STATIONS={STATIONS} playStation={playStation} now={now} loaded={loaded}/>}
      {!videoMode && section === "starred" && <StarredPane starredTracks={starredTracks} playTrack={playTrack} toggleStar={toggleStar}/>}
      {videoMode && session && !videoSearchActive && <VideosPane session={session} selectedId={selectedVideo?.id} onSelect={setSelectedVideo}/>}
      {videoMode && session && videoSearchActive && <VideoSearchPane session={session} q={q} selectedId={selectedVideo?.id} onSelect={setSelectedVideo}/>}
      {videoMode && session && <VideoSplitter/>}
      {videoMode && session && selectedVideo && (
        // Key on video.id so React unmounts + remounts the player when
        // the selection changes. Without the key, the component instance
        // sticks around and video.js's dispose + re-init on the same
        // <video> ref leaves the player in an error state (full-black
        // overlay) because video.js has already mangled the DOM around
        // the element by the time the second init runs.
        <VideoPlayerPane key={selectedVideo.id} session={session} video={selectedVideo} onClose={() => setSelectedVideo(null)} showStats={showStats} onCloseStats={onCloseStats}/>
      )}
    </div>
  );

  // Video mode hides the audio NowPlaying entirely. The video player is
  // the focal point; running audio playback alongside is a separate (later)
  // design decision.
  if (videoMode) {
    return <div className="mk-body layout-topband">{browse}</div>;
  }
  if (t.layout === "rightrail") {
    return (
      <div className="mk-body layout-rightrail">
        <div className="mk-body-main">{browse}</div>
        <div className="mk-body-rail">{nowPlaying}</div>
      </div>
    );
  }
  if (t.layout === "bottombar") {
    return (
      <div className="mk-body layout-bottombar">
        {browse}
        <div className="mk-body-dock">{nowPlaying}</div>
      </div>
    );
  }
  // topband default
  return (
    <div className="mk-body layout-topband">
      {nowPlaying}
      {browse}
    </div>
  );
}

// Tweaks UI — uses the tweaks-panel starter.
function TweaksControls({ tweak, t, setShowConn }) {
  return (
    <TweaksPanel title="Tweaks">
      <TweakSection title="Theme">
        <TweakSelect label="Preset" value={t.preset} onChange={(v) => tweak("preset", v)} options={[
          {value:"tokyo",label:"Tokyo Night — default"},
          {value:"vinyl",label:"Vinyl — paper + serif"},
          {value:"cassette",label:"Cassette — industrial mono"},
          {value:"neon",label:"Neon — synthwave glow"},
        ]}/>
        <TweakRadio label="Mode" value={t.theme} onChange={(v) => tweak("theme", v)} options={[{value:"dark",label:"Dark"},{value:"light",label:"Light"}]}/>
        <TweakSelect label="Accent (Tokyo only)" value={t.accent} onChange={(v) => tweak("accent", v)} options={[
          {value:"tokyo",label:"Tokyo Night"},
          {value:"cool",label:"Cool — cyan + violet"},
          {value:"warm",label:"Warm — coral + rose"},
          {value:"mono",label:"Mono + lime"},
        ]}/>
      </TweakSection>
      <TweakSection title="Layout">
        <TweakSelect label="Now-Playing position" value={t.layout} onChange={(v) => tweak("layout", v)} options={[
          {value:"topband",label:"Top hero band (current)"},
          {value:"bottombar",label:"Slim bottom bar"},
          {value:"rightrail",label:"Right-rail (Spotify-ish)"},
        ]}/>
        <TweakRadio label="Density" value={t.density} onChange={(v) => tweak("density", v)} options={[{value:"compact",label:"Compact"},{value:"comfortable",label:"Comfy"}]}/>
        <TweakSlider label="Font scale" min={0.85} max={1.2} step={0.05} value={t.fontScale} onChange={(v) => tweak("fontScale", v)} format={(v)=>v.toFixed(2)+"×"}/>
      </TweakSection>
      <TweakSection title="Now Playing">
        <TweakToggle label="LCD display" value={t.lcd} onChange={(v) => tweak("lcd", v)}/>
        <TweakRadio label="LCD tint" value={t.lcdColor} onChange={(v) => tweak("lcdColor", v)} options={[
          {value:"green",label:"Green"},{value:"amber",label:"Amber"},{value:"blue",label:"Blue"},
        ]}/>
      </TweakSection>
      <TweakSection title="Visualizer">
        <TweakSelect label="Style" value={t.viz} onChange={(v) => tweak("viz", v)} options={[
          {value:"bars",label:"Bars (FFT)"},
          {value:"mirror",label:"Mirrored bars"},
          {value:"ridge",label:"Ridge"},
          {value:"scope",label:"Oscilloscope"},
        ]}/>
        <TweakToggle label="Show spectrum panel" value={t.showSpectrum} onChange={(v) => tweak("showSpectrum", v)}/>
        <TweakSlider label="Spectrum delay" min={0} max={1} step={0.05} value={t.vizDelay || 0} onChange={(v) => tweak("vizDelay", v)} unit="s"/>
      </TweakSection>
      <TweakSection title="Demos">
        <TweakButton onClick={() => setShowConn && setShowConn(true)}>Trigger connection error</TweakButton>
      </TweakSection>
    </TweaksPanel>
  );
}

export { TopBar, MainArea, KindRail, FullscreenViz, TweaksControls };
