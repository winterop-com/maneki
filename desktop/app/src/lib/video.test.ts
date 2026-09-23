import { describe, expect, it } from 'vitest'

import type {
    VideoBrowse,
    VideoEntry,
    VideoFolder,
    VideoScanState,
    VideoSessionStats,
    VideoStatsFrame,
    VideoSubtitleTrack,
} from '@/lib/types'
import type { PlaybackSample } from '@/lib/video'
import {
    bitrateLabel,
    browseHref,
    compareNames,
    crumbsOf,
    encoderOf,
    fileSize,
    hlsPath,
    neighbours,
    otherStreams,
    parentOf,
    posterPath,
    preferredSubtitles,
    resolutionLabel,
    rowsOf,
    scanProgress,
    sessionFor,
    streamVerdict,
    subtitleKey,
    subtitleLabel,
    subtitleNote,
    subtitlePath,
    thumbnailPath,
    watchHref,
} from '@/lib/video'

const MOUNT = '/video/api'

function folder(name: string, relPath = name, count = 1): VideoFolder {
    return { name, rel_path: relPath, video_count: count }
}

function video(name: string, id = name): VideoEntry {
    return {
        id,
        name,
        path: `/library/${name}.mkv`,
        size_bytes: 1_000_000,
        rel_path: `${name}.mkv`,
        duration_s: 60,
        subtitles: [],
    }
}

function browse(folders: VideoFolder[], videos: VideoEntry[]): VideoBrowse {
    return { rel_path: '', crumbs: [], folders, videos }
}

function track(partial: Partial<VideoSubtitleTrack>): VideoSubtitleTrack {
    return {
        track_id: 'embed:0',
        kind: 'embedded',
        lang: 'en',
        label: 'English',
        format: 'subrip',
        default: false,
        url: '',
        ...partial,
    }
}

function sample(partial: Partial<PlaybackSample> = {}): PlaybackSample {
    return {
        paused: false,
        bufferAheadS: 20,
        bandwidthBps: 5_000_000,
        readyState: 4,
        droppedFrames: null,
        totalFrames: null,
        ...partial,
    }
}

function session(partial: Partial<VideoSessionStats> = {}): VideoSessionStats {
    return {
        video_id: 'one',
        name: 'One',
        segments_total: 100,
        transcodes_done: 10,
        inflight_foreground: [],
        inflight_prefetch: [],
        recent: [],
        avg_realtime_ratio: 0.3,
        idle_seconds: 0,
        ...partial,
    }
}

describe('crumbsOf', () => {
    it('gives nothing for the root', () => {
        expect(crumbsOf('')).toEqual([])
    })

    it('builds a path per segment', () => {
        expect(crumbsOf('Star Trek/TNG/S01')).toEqual([
            { name: 'Star Trek', path: 'Star Trek' },
            { name: 'TNG', path: 'Star Trek/TNG' },
            { name: 'S01', path: 'Star Trek/TNG/S01' },
        ])
    })

    it('drops stray separators rather than making a nameless crumb', () => {
        expect(crumbsOf('/films//noir/')).toEqual([
            { name: 'films', path: 'films' },
            { name: 'noir', path: 'films/noir' },
        ])
    })
})

describe('browseHref', () => {
    it('sends the root to the section rather than to an empty folder', () => {
        expect(browseHref('')).toBe('/video')
    })

    it('escapes each segment on its own, so a separator survives', () => {
        expect(browseHref('Star Trek & co/S01')).toBe('/video/browse/Star%20Trek%20%26%20co/S01')
    })
})

describe('watchHref', () => {
    it('escapes an id that holds separators', () => {
        expect(watchHref('Star Trek-S01-one')).toBe('/video/v/Star%20Trek-S01-one')
    })
})

describe('parentOf', () => {
    it('answers the root for a file at the top', () => {
        expect(parentOf('film.mkv')).toBe('')
    })

    it('answers the folder a file sits in', () => {
        expect(parentOf('Star Trek/TNG/S01/one.mkv')).toBe('Star Trek/TNG/S01')
    })

    it('ignores a trailing separator', () => {
        expect(parentOf('Star Trek/TNG/')).toBe('Star Trek')
    })
})

describe('compareNames', () => {
    it('sorts a number by its value rather than its characters', () => {
        expect(['S10', 'S2', 'S1'].toSorted(compareNames)).toEqual(['S1', 'S2', 'S10'])
    })

    it('does not treat case as a second alphabet', () => {
        expect(compareNames('alpha', 'Alpha')).toBe(0)
    })
})

describe('rowsOf', () => {
    it('puts every folder above every file', () => {
        const rows = rowsOf(browse([folder('zebra')], [video('alpha')]))
        expect(rows.map((row) => row.kind)).toEqual(['folder', 'video'])
    })

    it('sorts each group by name, numerically', () => {
        const rows = rowsOf(
            browse([folder('S10'), folder('S2')], [video('ep10'), video('ep2'), video('ep1')]),
        )
        expect(rows.map((row) => row.name)).toEqual(['S2', 'S10', 'ep1', 'ep2', 'ep10'])
    })

    it('keys a folder apart from a video of the same name', () => {
        const rows = rowsOf(browse([folder('same')], [video('same', 'same')]))
        expect(new Set(rows.map((row) => row.key)).size).toBe(2)
    })
})

describe('subtitleKey', () => {
    it('takes the language out of a sidecar id', () => {
        expect(subtitleKey('sidecar:no')).toBe('no')
    })

    it('spells an embedded stream the way the endpoint does', () => {
        expect(subtitleKey('embed:12')).toBe('embed-12')
    })

    it('passes a shape it does not know through untouched', () => {
        expect(subtitleKey('forced-en')).toBe('forced-en')
    })
})

describe('subtitleLabel', () => {
    it('keeps the label the server wrote', () => {
        expect(subtitleLabel('embed:2', 'en', 'English (SDH)')).toBe('English (SDH)')
    })

    it('falls back to the tag in capitals', () => {
        expect(subtitleLabel('sidecar:no', 'no', '')).toBe('NO')
    })

    it('names an embedded track by its index when nothing said a language', () => {
        expect(subtitleLabel('embed:3', 'und', null)).toBe('Track 3')
    })

    it('says Subtitles for a sidecar that named no language', () => {
        expect(subtitleLabel('sidecar:und', 'und')).toBe('Subtitles')
    })
})

describe('neighbours', () => {
    const season = [video('S01E10'), video('S01E02'), video('S01E01')]

    it('steps in the order the listing draws, not the order the wire answered', () => {
        const around = neighbours(season, 'S01E02')
        expect(around.previous?.id).toBe('S01E01')
        expect(around.next?.id).toBe('S01E10')
    })

    it('stops at either end rather than wrapping round', () => {
        expect(neighbours(season, 'S01E01').previous).toBeNull()
        expect(neighbours(season, 'S01E10').next).toBeNull()
    })

    it('answers nothing about a video the folder does not hold', () => {
        expect(neighbours(season, 'nowhere')).toEqual({ previous: null, next: null })
    })
})

describe('subtitleNote', () => {
    it('says nothing while the read is in flight', () => {
        expect(subtitleNote(null)).toBeNull()
    })

    it('says so when the file offers none, rather than leaving the fact off', () => {
        expect(subtitleNote([])).toBe('no subtitles')
    })

    it('counts what there is, singular for one', () => {
        expect(subtitleNote([track({ track_id: 'embed:2' })])).toBe('1 subtitle')
        expect(subtitleNote([track({ track_id: 'embed:2' }), track({ track_id: 'embed:3' })])).toBe(
            '2 subtitles',
        )
    })
})

describe('preferredSubtitles', () => {
    it('registers the default and the English tracks, and nothing else', () => {
        const chosen = preferredSubtitles([
            track({ track_id: 'embed:0', lang: 'pl', label: 'Polish' }),
            track({ track_id: 'embed:1', lang: 'en', label: 'English' }),
            track({ track_id: 'embed:2', lang: 'vi', label: 'Vietnamese' }),
        ])
        expect(chosen.map((one) => one.track_id)).toEqual(['embed:1'])
    })

    it('puts the hearing-impaired English variant above the plain one', () => {
        const chosen = preferredSubtitles([
            track({ track_id: 'embed:1', lang: 'en', label: 'English' }),
            track({ track_id: 'embed:2', lang: 'eng', label: 'English SDH' }),
        ])
        expect(chosen.map((one) => one.track_id)).toEqual(['embed:2', 'embed:1'])
    })

    it('leads with whatever the server marked', () => {
        const chosen = preferredSubtitles([
            track({ track_id: 'embed:1', lang: 'en', label: 'English' }),
            track({ track_id: 'embed:9', lang: 'no', label: 'Norwegian', default: true }),
        ])
        expect(chosen[0]?.track_id).toBe('embed:9')
    })

    it('offers one track rather than an empty menu when nothing is English', () => {
        const chosen = preferredSubtitles([track({ track_id: 'embed:4', lang: 'pl', label: 'Polish' })])
        expect(chosen.map((one) => one.track_id)).toEqual(['embed:4'])
    })

    it('answers nothing for a file with no subtitles at all', () => {
        expect(preferredSubtitles([])).toEqual([])
    })
})

describe('paths', () => {
    it('escapes an id that holds what a filename holds', () => {
        expect(thumbnailPath(MOUNT, 'Star Trek/S01 & more')).toBe(
            '/video/api/videos/Star%20Trek%2FS01%20%26%20more/thumbnail',
        )
    })

    it('busts the cache only when there is a token', () => {
        expect(thumbnailPath(MOUNT, 'one')).toBe('/video/api/videos/one/thumbnail')
        expect(posterPath(MOUNT, 'one', 2)).toBe('/video/api/videos/one/poster?v=2')
    })

    it('points the player at the manifest', () => {
        expect(hlsPath(MOUNT, 'one')).toBe('/video/api/videos/one/hls/index.m3u8')
    })

    it('builds a subtitle URL the way the endpoint spells one', () => {
        expect(subtitlePath(MOUNT, 'one', 'embed:2')).toBe('/video/api/videos/one/subtitles/embed-2')
    })
})

describe('fileSize', () => {
    it('writes gigabytes past a gigabyte and megabytes under it', () => {
        expect(fileSize(1_407_531_619)).toBe('1.41 GB')
        expect(fileSize(695_002_256)).toBe('695 MB')
    })

    it('says nothing useful about a size that is not one', () => {
        expect(fileSize(Number.NaN)).toBe('?')
    })
})

describe('resolutionLabel', () => {
    it('names the rungs by height', () => {
        expect(resolutionLabel(3840, 2160)).toBe('4K')
        expect(resolutionLabel(1920, 1080)).toBe('1080p')
        expect(resolutionLabel(1280, 720)).toBe('720p')
    })

    it('calls an ultra-wide by the rung its height sits on', () => {
        expect(resolutionLabel(1920, 800)).toBe('720p')
    })

    it('spells out a size below the lowest rung', () => {
        expect(resolutionLabel(640, 360)).toBe('640x360')
    })

    it('answers nothing where there is no size to name', () => {
        expect(resolutionLabel(0, 0)).toBeNull()
    })
})

describe('bitrateLabel', () => {
    it('quotes a link in megabits', () => {
        expect(bitrateLabel(4_200_000)).toBe('4.2 Mbit/s')
    })

    it('draws a dash where nothing measured one', () => {
        expect(bitrateLabel(null)).toBe('-')
    })
})

function state(partial: Partial<VideoScanState>): VideoScanState {
    return { scanning: true, phase: 'walking', total: 0, scanned: 0, walked: 0, ...partial }
}

describe('scanProgress', () => {
    it('counts what the walk has found while there is no total', () => {
        const progress = scanProgress(state({ phase: 'walking', walked: 42 }))
        expect(progress).toEqual({ title: 'Discovering files', detail: '42 files found', ratio: 0 })
    })

    it('is a real fraction once the walk has finished', () => {
        const progress = scanProgress(state({ phase: 'probing', total: 200, scanned: 50 }))
        expect(progress.title).toBe('Scanning the library')
        expect(progress.detail).toBe('50 of 200 videos')
        expect(progress.ratio).toBeCloseTo(0.25)
    })

    it('never fills past the end when a rescan finds fewer files', () => {
        expect(scanProgress(state({ phase: 'probing', total: 10, scanned: 12 })).ratio).toBe(1)
    })

    it('says something before the first poll has answered', () => {
        expect(scanProgress(null).title).toBe('Reading the library')
    })
})

describe('stats frames', () => {
    const frame: VideoStatsFrame = {
        seg_len: 6,
        budget: { max_workers: 4, foreground_in_flight: 1, background_in_flight: 0 },
        sessions: [session({ video_id: 'mine' }), session({ video_id: 'theirs' })],
    }

    it('picks this video out of the frame', () => {
        expect(sessionFor(frame, 'mine')?.video_id).toBe('mine')
        expect(sessionFor(frame, 'absent')).toBeNull()
    })

    it('counts everybody else on the same pool', () => {
        expect(otherStreams(frame, 'mine')).toBe(1)
        expect(otherStreams(null, 'mine')).toBe(0)
    })

    it('reads the encoder off the most recent segment', () => {
        const withRecent = session({
            recent: [
                { idx: 1, seconds: 1, realtime_ratio: 0.2, low_priority: false, encoder: 'libx264' },
                {
                    idx: 2,
                    seconds: 1,
                    realtime_ratio: 0.2,
                    low_priority: false,
                    encoder: 'h264_videotoolbox',
                },
            ],
        })
        expect(encoderOf(withRecent)).toBe('h264_videotoolbox')
        expect(encoderOf(session())).toBeNull()
        expect(encoderOf(null)).toBeNull()
    })
})

describe('streamVerdict', () => {
    it('says nothing is wrong before the first sample', () => {
        expect(streamVerdict(null, null)).toEqual({ level: 'idle', text: 'connecting' })
    })

    it('does not call a paused player a fault', () => {
        expect(streamVerdict(sample({ paused: true, bufferAheadS: 0 }), null).level).toBe('idle')
    })

    it('calls a comfortable buffer healthy whatever the encoder is doing', () => {
        const verdict = streamVerdict(sample({ bufferAheadS: 20 }), session({ avg_realtime_ratio: 1.4 }))
        expect(verdict.level).toBe('healthy')
        expect(verdict.text).toBe('healthy, 20s buffered ahead')
    })

    it('calls a player with nothing decoded stalled', () => {
        const verdict = streamVerdict(sample({ bufferAheadS: 0, readyState: 0 }), null)
        expect(verdict).toEqual({ level: 'stalled', text: 'stalled, waiting for data' })
    })

    it('blames the encoder when it is transcoding at realtime', () => {
        const verdict = streamVerdict(sample({ bufferAheadS: 3 }), session({ avg_realtime_ratio: 1.2 }))
        expect(verdict.level).toBe('buffering')
        expect(verdict.text).toBe('encoder-bound, transcoding at 1.2x realtime')
    })

    it('blames the link when the segments are ready and the buffer is not', () => {
        const verdict = streamVerdict(
            sample({ bufferAheadS: 2, bandwidthBps: 1_500_000 }),
            session({ avg_realtime_ratio: 0.2, transcodes_done: 30 }),
        )
        expect(verdict.level).toBe('buffering')
        expect(verdict.text).toBe('network-bound, segments ready but arriving at 1.5 Mbit/s')
    })

    it('says plainly that it is buffering when nothing has been transcoded yet', () => {
        const verdict = streamVerdict(sample({ bufferAheadS: 4 }), null)
        expect(verdict).toEqual({ level: 'buffering', text: 'buffering, 4s ahead' })
    })
})
