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
 * What a channel's item is: which tab it came from, said as a word.
 *
 * `live` covers a broadcast that has finished as well as one still running -- the tab holds
 * both -- so `is_live` on the item is what says whether it is on air now.
 */
export type YouTubeKind = 'video' | 'short' | 'live'

/** Which of a channel's three tabs a listing is asked for, spelled as the wire spells it. */
export type YouTubeTab = 'videos' | 'shorts' | 'streams'

/** One subscribed channel. `id` is the stable `UC...` the rest of the API is addressed by. */
export interface YouTubeChannel {
    id: string
    title: string
    url: string
    handle: string | null
    thumbnail_url: string | null
}

/** One item in a channel listing. Flat extraction, so there are no stream URLs on it. */
export interface YouTubeVideo {
    id: string
    title: string
    duration_s: number | null
    thumbnail_url: string
    kind: YouTubeKind
    is_live: boolean
    upload_date: string | null
}

/**
 * How many items a channel has on each tab.
 *
 * The numbers are the size of a capped listing, so `*_capped` says the channel has at least
 * that many rather than exactly that many. A true total costs a full extraction.
 */
export interface YouTubeCounts {
    videos: number
    shorts: number
    live: number
    videos_capped: boolean
    shorts_capped: boolean
    live_capped: boolean
}

/** The heights this server will transcode a YouTube video down to, and the one it picks itself. */
export interface YouTubeQuality {
    heights: number[]
    default: number
}
