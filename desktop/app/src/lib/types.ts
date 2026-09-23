/** The shapes the server sends. Mirrors the pydantic models in `maneki.books.serve`. */

export interface Capabilities {
    server: string
    version: string
    audio: boolean
    video: boolean
    youtube: boolean
    radio: boolean
    books: boolean
    auth_required: boolean
    endpoints: {
        audio_subsonic: string | null
        video_api: string | null
        books_api: string | null
        auth_login: string
    }
}

export interface BookSummary {
    id: string
    title: string
    author: string
    narrator: string | null
    year: string | null
    series: string | null
    series_position: string | null
    duration_s: number
    chapters: number
    has_cover: boolean
    /** Where this account stopped, in seconds on the book's timeline. */
    position_s: number
    finished: boolean
}

export interface Chapter {
    title: string
    start_s: number
    end_s: number
}

export interface BookFile {
    index: number
    duration_s: number
    /** Where this file starts on the book's timeline. */
    offset_s: number
    size_bytes: number
    /** Relative to the books mount; `api.books.fileUrl` makes it absolute. */
    url: string
}

export interface BookDetail extends BookSummary {
    description: string | null
    asin: string | null
    chapter_source: 'file' | 'catalog' | 'files' | 'none'
    chapter_list: Chapter[]
    files: BookFile[]
}

export interface BookProgress {
    book_id: string
    position_s: number
    finished: boolean
    updated_at: number
}

/**
 * The video library's shapes. Mirrors the pydantic models in `maneki.video.serve`.
 *
 * A VIDEO IS ADDRESSED BY AN ID AND READ BY A PATH. `id` is the server's own handle for where
 * the file sits and is what every endpoint takes; `rel_path` is where it sits under the library
 * root, which is what a breadcrumb and a folder listing are made of. Neither stands in for the
 * other, so both are carried on every row.
 */

export interface SubtitleSummary {
    lang: string
    /** `srt` or `vtt`, as the sidecar beside the file was written. */
    format: string
}

export interface VideoEntry {
    id: string
    /** The file's name without its extension, which is what a row is headed by. */
    name: string
    /** Absolute on the server's own disk. Nothing in this client draws it. */
    path: string
    size_bytes: number
    /** Under the library root, POSIX separators: `Star Trek/TNG/S01/Encounter at Farpoint.mkv`. */
    rel_path: string
    /** Null until the server has probed the file. */
    duration_s: number | null
    subtitles: SubtitleSummary[]
}

export interface VideoFolder {
    name: string
    rel_path: string
    /** Videos in this folder and in every folder under it. */
    video_count: number
}

export interface VideoBrowse {
    /** The folder this answer is about; the empty string is the library root. */
    rel_path: string
    /** That path split into segments: `['Star Trek', 'TNG']`. The root's is empty. */
    crumbs: string[]
    folders: VideoFolder[]
    videos: VideoEntry[]
}

/** What the server is doing to the library right now. */
export type ScanPhase = 'idle' | 'walking' | 'probing' | 'done'

export interface VideoScanState {
    scanning: boolean
    phase: ScanPhase
    /** How many files the walk found. Zero until the walk has finished, which is why it is best effort. */
    total: number
    scanned: number
    walked: number
}

export interface VideoSubtitleTrack {
    /** `sidecar:<lang>` or `embed:<stream index>`. What a URL for the track is built from. */
    track_id: string
    kind: 'sidecar' | 'embedded'
    lang: string
    label: string
    format: string
    /** The server marks at most one, preferring English. */
    default: boolean
    /** Relative to the video sub-app, which does not know its own mount. Rebuilt on this side. */
    url: string
}

/** What one segment's transcode cost, as the stats stream reports it. */
export interface SegmentTiming {
    idx: number
    seconds: number
    /** Seconds spent per second of video. At or above 1 the encoder is falling behind. */
    realtime_ratio: number
    low_priority: boolean
    /** Which H.264 encoder produced it, which is how you tell whether the GPU engaged. */
    encoder: string
}

/** One video being streamed, as the server sees it. */
export interface VideoSessionStats {
    video_id: string
    name: string
    segments_total: number
    transcodes_done: number
    inflight_foreground: number[]
    inflight_prefetch: number[]
    recent: SegmentTiming[]
    avg_realtime_ratio: number | null
    idle_seconds: number
}

/** The transcode pool every stream on this server shares. */
export interface TranscodeBudget {
    max_workers: number
    foreground_in_flight: number
    background_in_flight: number
}

/** One frame of `/api/stats/stream`: the shared budget, and everybody streaming against it. */
export interface VideoStatsFrame {
    seg_len: number
    budget: TranscodeBudget
    sessions: VideoSessionStats[]
}
