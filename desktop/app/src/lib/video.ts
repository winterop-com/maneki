/**
 * What the video screens decide, decided here.
 *
 * NOTHING IN THIS FILE TOUCHES A SERVER OR A DOM, so every rule the video section reads by is
 * exercised in plain Node: where a folder sits in its trail, what order a folder's rows come
 * out in, what a subtitle track is called, and -- the one worth the most -- whether a stream is
 * actually keeping up. A screen draws the answer and decides nothing itself.
 *
 * THE PATHS ARE BUILT HERE AND MADE ABSOLUTE IN `lib/api`. Every video URL hangs off the mount
 * `/capabilities` names, and a thumbnail on a row is the same path as the poster behind a
 * player with one segment changed -- so the shape is stated once, as a function of the mount,
 * and `lib/api` puts the server in front of it.
 */

import type {
    VideoBrowse,
    VideoEntry,
    VideoFolder,
    VideoProgress,
    VideoScanState,
    VideoSessionStats,
    VideoStatsFrame,
    VideoSubtitleTrack,
} from '@/lib/types'

/** Where maneki mounts the video API when `/capabilities` has not said otherwise. */
export const VIDEO_MOUNT = '/video/api'

/** One step of the trail above a folder: what it is called, and the path that opens it. */
export interface Crumb {
    name: string
    /** Relative to the library root, which is what `/api/browse?path=` takes. */
    path: string
}

/**
 * The trail above one folder, root excluded.
 *
 * The root is not a crumb: the screen draws it itself as the word the section is called, and a
 * trail that began with a segment nothing on the wire carries would be a path nobody can build.
 * Empty and stray separators are dropped, so a path typed into the address bar with a trailing
 * slash reads as the folder it names rather than as a folder with a nameless child.
 */
export function crumbsOf(relPath: string): Crumb[] {
    const segments = relPath.split('/').filter((segment) => segment !== '')
    return segments.map((name, index) => ({ name, path: segments.slice(0, index + 1).join('/') }))
}

/**
 * Where a folder is read, as an address somebody can be sent.
 *
 * The root is the section's own address rather than a browse with an empty segment on the end,
 * so the entry in the rail and the top of the trail are one place. Each segment is escaped on
 * its own -- a folder called `Star Trek & co` is one segment of a path, not three.
 */
export function browseHref(relPath: string): string {
    const segments = relPath.split('/').filter((segment) => segment !== '')
    if (segments.length === 0) return '/video'
    return `/video/browse/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`
}

/** Where one video is watched. */
export function watchHref(id: string): string {
    return `/video/v/${encodeURIComponent(id)}`
}

/** The folder a path sits in. A path with no separator in it sits in the root, which is `''`. */
export function parentOf(relPath: string): string {
    const trimmed = relPath.replace(/\/+$/, '')
    const cut = trimmed.lastIndexOf('/')
    return cut < 0 ? '' : trimmed.slice(0, cut)
}

/**
 * How two names compare in a listing.
 *
 * `localeCompare` with `numeric`, so `S2` sorts before `S10` rather than between `S1` and `S3`
 * -- a season folder and an episode file are numbered, and a plain string comparison files a
 * library of television in the wrong order from the second season on. Case is not a second
 * alphabet, which is what `base` says.
 */
export function compareNames(left: string, right: string): number {
    return left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true })
}

/** One line of a folder listing: a folder to go into, or a video to watch. */
export type BrowseRow =
    | { kind: 'folder'; key: string; name: string; folder: VideoFolder }
    | { kind: 'video'; key: string; name: string; video: VideoEntry }

/**
 * A folder's contents in the order they are read.
 *
 * FOLDERS FIRST, THEN FILES, EACH BY NAME. A folder is a place to go and a file is a thing to
 * watch, and a listing that interleaved them would make somebody scan the whole of it to find
 * out whether there is anywhere further down. The server answers in its own walk order, which
 * is the filesystem's, and that is no order at all to a reader.
 */
export function rowsOf(browse: VideoBrowse): BrowseRow[] {
    const folders: BrowseRow[] = browse.folders
        .map((folder): BrowseRow => ({
            kind: 'folder',
            key: `folder:${folder.rel_path}`,
            name: folder.name,
            folder,
        }))
        .toSorted((left, right) => compareNames(left.name, right.name))
    const videos: BrowseRow[] = browse.videos
        .map((video): BrowseRow => ({ kind: 'video', key: video.id, name: video.name, video }))
        .toSorted((left, right) => compareNames(left.name, right.name))
    return [...folders, ...videos]
}

/**
 * Under this, a position is not one worth coming back to.
 *
 * Opening a video, watching the titles and leaving again is not a decision to resume from, and a
 * folder of rows each carrying a sliver of a meter is a folder saying nothing. The server stores
 * whatever it is told; what counts as having started something is decided here, once, so the
 * resume and the meter under a row cannot disagree about it.
 */
export const STARTED_AFTER_S = 15

/** Where a player should open: what was saved, or the top. */
export function resumeAt(progress: VideoProgress | null): number {
    if (progress === null || progress.finished) return 0
    return progress.position_s >= STARTED_AFTER_S ? progress.position_s : 0
}

/** Whether a row has a position worth drawing under it. A finished video says so instead. */
export function started(progress: VideoProgress | null | undefined): boolean {
    if (progress === undefined || progress === null || progress.finished) return false
    return progress.position_s >= STARTED_AFTER_S
}

/** Where an episode number begins, which is where the name of an episode begins. */
const EPISODE_MARK = /\bS\d{1,2}E\d{1,3}\b/i

/** What a scene release puts between the parts of a filename, and what a trimmed name drops. */
const LEADING_SEPARATORS = /^[\s\-–—_.·]+/

/**
 * What one video is called among the others in its folder.
 *
 * THE ROW HAS TO SAY THE ONE THING THAT DIFFERS. A season of television is twenty-six files
 * whose names begin with the same forty characters, so a column of them reads "Star Trek The
 * Next Generation ..." twenty-six times with the episode -- the only part anybody is looking
 * for -- cut off past the edge of the row. The trail above the listing already says which show
 * and which season; the row's job is the episode.
 *
 * SO WHAT THEY SHARE COMES OFF, AT A WORD BOUNDARY. The prefix is measured in whole words
 * against every other name in the folder, which is what stops "The Hunted" and "The High
 * Ground" losing their "The H". A folder whose names share nothing keeps its names.
 *
 * AND THE CUT PREFERS A SEPARATOR WHERE THE SHARED RUN HOLDS ONE, because that is where a
 * release name's fields divide. Two parts of one film share "The Lord of the Rings - Part ",
 * every word of it, and a cut at the end of that leaves a row reading "1".
 *
 * AND AN EPISODE NUMBER LEADS WHEREVER IT IS. `S03E04` is how somebody finds an episode and how
 * a folder sorts, so a name carrying one starts there -- which also answers the single-file
 * folder, where there is no sibling to measure a prefix against and the name is otherwise left
 * whole.
 *
 * Never empty: a name that is entirely what its siblings share is returned as it was, because a
 * blank row says less than a repeated one.
 */
export function episodeName(name: string, siblings: readonly string[]): string {
    const marked = EPISODE_MARK.exec(name)
    if (marked !== null && marked.index > 0) return name.slice(marked.index)
    const own = name.split(' ')
    const cut = cutAt(own, sharedWords(name, siblings))
    if (cut === 0 || cut >= own.length) return name
    const rest = own.slice(cut).join(' ').replace(LEADING_SEPARATORS, '').trim()
    return rest === '' ? name : rest
}

/** Where to cut a shared run of words: after its last separator, or after all of it. */
function cutAt(own: readonly string[], shared: number): number {
    for (let at = shared; at > 0; at -= 1) {
        if (SEPARATOR_WORD.test(own[at - 1] ?? '')) return at
    }
    return shared
}

/** A word that is only punctuation, which is a release name saying one field has ended. */
const SEPARATOR_WORD = /^[-–—_.·|]+$/

/** How many whole leading words every other name in the folder has in common with this one. */
function sharedWords(name: string, siblings: readonly string[]): number {
    const own = name.split(' ')
    let shared = -1
    for (const other of siblings) {
        if (other === name) continue
        const words = other.split(' ')
        let count = 0
        while (count < own.length && count < words.length && own[count] === words[count]) count += 1
        shared = shared < 0 ? count : Math.min(shared, count)
    }
    return shared < 0 ? 0 : shared
}

/** What sits either side of one video in the folder it came out of. */
export interface Neighbours {
    previous: VideoEntry | null
    next: VideoEntry | null
}

/**
 * The video before and the video after, in the order the folder is read in.
 *
 * IN THE LISTING'S ORDER, NOT THE SERVER'S. The wire answers a folder in the filesystem's walk
 * order, which is no order to a reader, and the screen sorts it -- so "the next one" has to be
 * the next one on screen or `n` moves somewhere nobody was pointing at. Same comparison the
 * listing uses, which is what keeps S2 before S10.
 *
 * A video the folder does not hold, and either end of it, answer null: there is nothing there,
 * and a step that wrapped round to the first episode after the last would be a season that
 * never ends.
 */
export function neighbours(videos: readonly VideoEntry[], id: string): Neighbours {
    const ordered = videos.toSorted((left, right) => compareNames(left.name, right.name))
    const at = ordered.findIndex((one) => one.id === id)
    if (at < 0) return { previous: null, next: null }
    return { previous: ordered[at - 1] ?? null, next: ordered[at + 1] ?? null }
}

/**
 * The tail a subtitle track is fetched by.
 *
 * The server takes a language tag for a sidecar and `embed-<index>` for a stream inside the
 * file, while the listing hands back `sidecar:<lang>` and `embed:<index>`. One colon becomes
 * one hyphen; anything else is passed through, so a track kind this client was built before
 * still reaches the endpoint that knows about it.
 */
export function subtitleKey(trackId: string): string {
    if (trackId.startsWith('sidecar:')) return trackId.slice('sidecar:'.length)
    if (trackId.startsWith('embed:')) return `embed-${trackId.slice('embed:'.length)}`
    return trackId
}

/** Language tags that mean the file did not say, which is not a language to put in a menu. */
const UNKNOWN_LANGUAGES = new Set(['und', 'unk', ''])

/**
 * What a subtitle track is called in the menu.
 *
 * THE SERVER'S LABEL WINS WHERE THERE IS ONE: it has the stream's own title, which says
 * "English (SDH)" where a language tag says `eng`. What this answers is the case where there is
 * not -- a sidecar whose name carried only a tag, or a track this client built a key for
 * itself -- and the answer is the tag in capitals, because `EN` beside `NO` reads as a choice
 * while `en` reads as a filename. A track that named no language at all is just Subtitles.
 */
export function subtitleLabel(trackId: string, lang?: string | null, given?: string | null): string {
    const label = (given ?? '').trim()
    if (label !== '') return label
    const tag = (lang ?? '').trim().toLowerCase()
    if (!UNKNOWN_LANGUAGES.has(tag)) return tag.toUpperCase()
    if (trackId.startsWith('embed:')) {
        const index = trackId.slice('embed:'.length)
        return index === '' ? 'Subtitles' : `Track ${index}`
    }
    return 'Subtitles'
}

/**
 * What the meta line says about captions.
 *
 * NOTHING IS NOT AN ANSWER. A file with no usable track used to leave the fact off the line
 * entirely, which reads as a screen that forgot to look -- and looking is exactly what somebody
 * does when the control bar has no captions button on it. So an answered read with nothing in it
 * says so, and only an unanswered one is silent.
 *
 * `null` while the read is in flight, because a line that said "no subtitles" for half a second
 * on every open would be wrong more often than it was right.
 *
 * A Blu-ray rip commonly lands here: its only subtitle stream is `hdmv_pgs_subtitle`, which is
 * pictures of words rather than words, and nothing short of OCR turns that into WebVTT. The
 * server leaves those out of what it offers, so as far as this screen is concerned there are
 * none.
 */
export function subtitleNote(count: number | null): string | null {
    if (count === null) return null
    if (count === 0) return 'no subtitles'
    return `${String(count)} subtitle${count === 1 ? '' : 's'}`
}

/** A subtitle track as the player takes one: a name, an address, and the tag it is in. */
export interface SubtitleSource {
    label: string
    src: string
    lang?: string
    /** Whether the server picked this one to be on when playback starts. */
    default?: boolean
}

/**
 * The tracks worth registering with the player, best first.
 *
 * A .mkv can carry forty subtitle streams, and registering all of them fires one extraction per
 * track: each is an ffmpeg run, the browser opens six connections to an origin, and the rest
 * queue up in front of the segment requests playback actually needs. That was ten seconds of a
 * player doing nothing on the files that have the most to offer.
 *
 * So the ones that get registered are the ones somebody is almost certainly after: the track
 * the server marked, and English -- the hearing-impaired variant first, since a viewer who
 * turns captions on usually wants the whole soundtrack described. Everything else is left off
 * rather than made to wait, and a file with nothing English in it still offers its first track,
 * because a captions menu with no rows in it is a control that does nothing.
 */
export function preferredSubtitles(tracks: readonly VideoSubtitleTrack[]): VideoSubtitleTrack[] {
    const ranked = tracks
        .map((track, index) => ({ track, index, rank: subtitleRank(track) }))
        .toSorted((left, right) => left.rank - right.rank || left.index - right.index)
    const eager = ranked.filter((row) => row.rank < LAST_RESORT).map((row) => row.track)
    if (eager.length > 0) return eager
    const first = ranked[0]?.track
    return first === undefined ? [] : [first]
}

/** The rank a track nobody asked for takes, which is what keeps it out of the eager set. */
const LAST_RESORT = 99

function subtitleRank(track: VideoSubtitleTrack): number {
    if (track.default) return 0
    const english = track.lang.toLowerCase() === 'en' || track.lang.toLowerCase() === 'eng'
    if (!english) return LAST_RESORT
    return /\b(sdh|cc|hoh|hearing|closed)\b/i.test(track.label) ? 1 : 2
}

/** Every video path hangs off the mount, and the id can hold anything a filename can. */
function videoPath(mount: string, id: string, tail: string): string {
    return `${mount}/videos/${encodeURIComponent(id)}${tail}`
}

/**
 * A row's still frame.
 *
 * `token` busts the cache. The server answers a placeholder while ffmpeg is still making the
 * real frame, and without a changed URL the browser holds that placeholder for as long as the
 * folder is open -- so the screen bumps the token once `/thumbnails/ready` names the id.
 */
export function thumbnailPath(mount: string, id: string, token?: number): string {
    return videoPath(mount, id, '/thumbnail') + (token ? `?v=${String(token)}` : '')
}

/** The contact sheet behind a paused player. Same placeholder story as a thumbnail. */
export function posterPath(mount: string, id: string, token?: number): string {
    return videoPath(mount, id, '/poster') + (token ? `?v=${String(token)}` : '')
}

/** The HLS manifest: what the player is pointed at, whatever the file underneath it is. */
export function hlsPath(mount: string, id: string): string {
    return videoPath(mount, id, '/hls/index.m3u8')
}

/** The file itself, bytes and ranges, for a container the browser can already play. */
export function streamPath(mount: string, id: string): string {
    return videoPath(mount, id, '/stream')
}

/** One subtitle track as WebVTT. */
export function subtitlePath(mount: string, id: string, trackId: string): string {
    return videoPath(mount, id, `/subtitles/${encodeURIComponent(subtitleKey(trackId))}`)
}

/** `1.41 GB`, or `695 MB` under a gigabyte. What a film weighs, beside how long it runs. */
export function fileSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '?'
    const gb = bytes / 1e9
    return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(bytes / 1e6).toFixed(0)} MB`
}

/**
 * What a frame size is called.
 *
 * KEYED ON HEIGHT, because that is the axis the names were minted on: an ultra-wide 1920x800
 * is a 1080p source with the bars cut off, and calling it 800p would be a number nobody uses.
 * Anything below the lowest named rung is drawn as the pixels it actually is, which is more
 * use on an old capture than rounding it up to a name it has not earned.
 */
export function resolutionLabel(width: number, height: number): string | null {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
    if (height >= 2160) return '4K'
    if (height >= 1440) return '1440p'
    if (height >= 1080) return '1080p'
    if (height >= 720) return '720p'
    if (height >= 480) return '480p'
    return `${String(Math.round(width))}x${String(Math.round(height))}`
}

/** `4.2 Mbit/s`, the unit a link is quoted in. */
export function bitrateLabel(bitsPerSecond: number | null): string {
    if (bitsPerSecond === null || !Number.isFinite(bitsPerSecond)) return '-'
    return `${(bitsPerSecond / 1e6).toFixed(1)} Mbit/s`
}

/** What one poll of the library says, in the words the screen puts on it. */
export interface ScanProgress {
    title: string
    detail: string
    /** How far through, 0 to 1. Zero while the walk is still counting, which is indeterminate. */
    ratio: number
}

/**
 * What a library being read says while it is being read.
 *
 * A COLD LIBRARY IS TWO PHASES AND THEY ARE NOT THE SAME WAIT. The walk finds the files, and
 * until it has finished there is no total to be a fraction of -- so it says how many it has
 * found and the bar stays empty rather than filling against a number that keeps moving. The
 * probe is the long one and it has a real denominator, which is what somebody wants to see when
 * a thousand-file library is being opened for the first time.
 */
export function scanProgress(state: VideoScanState | null): ScanProgress {
    if (state === null) return { title: 'Reading the library', detail: '', ratio: 0 }
    if (state.total > 0) {
        return {
            title: state.phase === 'probing' ? 'Scanning the library' : 'Reading the library',
            detail: `${String(state.scanned)} of ${String(state.total)} videos`,
            ratio: Math.min(1, state.scanned / state.total),
        }
    }
    return {
        title: state.phase === 'walking' ? 'Discovering files' : 'Reading the library',
        detail: state.walked > 0 ? `${String(state.walked)} files found` : 'discovering files',
        ratio: 0,
    }
}

/** This video's own row in a stats frame, or null while nothing of it has been transcoded. */
export function sessionFor(frame: VideoStatsFrame | null, videoId: string): VideoSessionStats | null {
    return frame?.sessions.find((session) => session.video_id === videoId) ?? null
}

/** How many other people are pulling on the same transcode pool. */
export function otherStreams(frame: VideoStatsFrame | null, videoId: string): number {
    return frame === null ? 0 : frame.sessions.filter((session) => session.video_id !== videoId).length
}

/** Which encoder produced the most recent segment: `h264_videotoolbox`, or `libx264` on the CPU. */
export function encoderOf(session: VideoSessionStats | null): string | null {
    const recent = session?.recent
    if (recent === undefined || recent.length === 0) return null
    return recent[recent.length - 1]?.encoder ?? null
}

/** What the player itself knows about how playback is going, sampled once a second. */
export interface PlaybackSample {
    paused: boolean
    /** Seconds of video buffered past the playhead. */
    bufferAheadS: number
    /** What the adaptive engine measured the link at, where there is one to ask. */
    bandwidthBps: number | null
    /** `HTMLMediaElement.readyState`: 0 is nothing at all, 4 is enough to play through. */
    readyState: number
    droppedFrames: number | null
    totalFrames: number | null
}

/**
 * How playback is going, in one word and one sentence.
 *
 * `idle` is the fourth word and it is not a health: a paused player and one that has not
 * answered yet are both fine, and painting them as a fault would make the overlay cry wolf
 * every time somebody stops to read a subtitle.
 */
export type StreamLevel = 'healthy' | 'buffering' | 'stalled' | 'idle'

export interface StreamStatus {
    level: StreamLevel
    text: string
}

/** Buffered past this, nothing else matters: playback is going to survive whatever happens next. */
export const HEALTHY_BUFFER_S = 12

/** At or above this the encoder is spending a second of wall clock per second of video. */
const ENCODER_BOUND_RATIO = 0.9

/**
 * Whether the stream is keeping up, and if not, which wall it hit.
 *
 * THE VERDICT IS THE WHOLE POINT OF THE OVERLAY. A grid of eight numbers tells somebody who
 * already knows how HLS works what is happening; what everybody else needs is the one sentence
 * those numbers add up to, and in particular whether to blame the machine doing the encoding or
 * the link carrying the result -- because those have different answers. A transcode running at
 * or past realtime cannot stay ahead of playback whatever the network does, and a transcode
 * that finished its segments while the buffer stays thin is a link that cannot carry them.
 *
 * A comfortable buffer is healthy however it got there, which is the first thing checked: a
 * player with twenty seconds ahead of it is not having a problem, and an encoder ratio that
 * looks alarming while the buffer is full is a fact for the grid rather than a verdict.
 */
export function streamVerdict(
    sample: PlaybackSample | null,
    session: VideoSessionStats | null,
): StreamStatus {
    if (sample === null) return { level: 'idle', text: 'connecting' }
    if (sample.paused) return { level: 'idle', text: 'paused' }
    const buffered = Math.max(0, sample.bufferAheadS)
    if (buffered >= HEALTHY_BUFFER_S) {
        return { level: 'healthy', text: `healthy, ${buffered.toFixed(0)}s buffered ahead` }
    }
    // Nothing decoded and nothing buffered is not a thin buffer, it is a player that has
    // stopped: saying "buffering" of it would promise motion that is not coming.
    if (sample.readyState <= 1 && buffered <= 0)
        return { level: 'stalled', text: 'stalled, waiting for data' }
    const ratio = session?.avg_realtime_ratio ?? null
    if (ratio !== null && ratio >= ENCODER_BOUND_RATIO) {
        return {
            level: 'buffering',
            text: `encoder-bound, transcoding at ${ratio.toFixed(1)}x realtime`,
        }
    }
    if (session !== null && session.transcodes_done > 0) {
        return {
            level: 'buffering',
            text: `network-bound, segments ready but arriving at ${bitrateLabel(sample.bandwidthBps)}`,
        }
    }
    return { level: 'buffering', text: `buffering, ${buffered.toFixed(0)}s ahead` }
}
