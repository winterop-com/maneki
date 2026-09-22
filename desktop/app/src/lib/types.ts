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
