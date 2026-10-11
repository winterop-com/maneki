import { describe, expect, test, vi } from 'vitest'

import { DEVICE_STATIONS, deviceRadio } from '@/lib/radio-source'

function memory(): Pick<Storage, 'getItem' | 'setItem'> {
    const held = new Map<string, string>()
    return {
        getItem: (key) => held.get(key) ?? null,
        setItem: (key, value) => {
            held.set(key, value)
        },
    }
}

const directory = [
    {
        stationuuid: 'u1',
        name: 'Jazz FM',
        url_resolved: 'https://jazz.example/live.mp3',
        homepage: 'https://jazz.example',
        favicon: 'https://jazz.example/logo.png',
        countrycode: 'GB',
        tags: 'jazz,smooth',
        codec: 'MP3',
        bitrate: 128,
        hls: 0,
    },
    { stationuuid: 'u2', name: 'Jazz HLS', url_resolved: 'https://jazz.example/live.m3u8', hls: 1 },
    {
        stationuuid: 'u3',
        name: 'No logo',
        url_resolved: 'http://plain.example/stream',
        favicon: 'null',
        hls: 0,
    },
]

describe('radio on this device, with no server', () => {
    test('starts with the built-in stations, none of them removable', async () => {
        const radio = deviceRadio(memory(), vi.fn())
        const stations = await radio.stations()
        expect(stations.map((one) => one.streamUrl)).toEqual(DEVICE_STATIONS.map((one) => one.streamUrl))
        expect(stations.every((one) => !one.custom)).toBe(true)
    })

    test('keeps a station added from search, first, across a new start, and removes it again', async () => {
        const storage = memory()
        const radio = deviceRadio(storage, vi.fn())
        await radio.add({
            id: 'u1',
            name: 'Jazz FM',
            streamUrl: 'https://jazz.example/live.mp3',
            tags: [],
            added: false,
        })
        const again = await deviceRadio(storage, vi.fn()).stations()
        expect(again[0]).toMatchObject({
            name: 'Jazz FM',
            streamUrl: 'https://jazz.example/live.mp3',
            custom: true,
        })
        await expect(
            radio.add({
                id: 'u1',
                name: 'Jazz FM',
                streamUrl: 'https://jazz.example/live.mp3',
                tags: [],
                added: false,
            }),
        ).rejects.toThrow(/already/)
        await radio.remove(again[0]!)
        expect((await radio.stations()).some((one) => one.name === 'Jazz FM')).toBe(false)
    })

    test('searches the open directory directly, leaving out what cannot play', async () => {
        const fetcher = vi.fn(
            async (_address: string) => ({ ok: true, json: async () => directory }) as Response,
        )
        const radio = deviceRadio(memory(), fetcher)
        const found = await radio.search('jazz')
        expect(String(fetcher.mock.calls[0]![0])).toContain('radio-browser.info')
        expect(found.map((one) => one.name)).toEqual(['Jazz FM', 'No logo'])
        expect(found[0]).toMatchObject({
            logo: 'https://jazz.example/logo.png',
            countryCode: 'GB',
            tags: ['jazz', 'smooth'],
            added: false,
        })
        expect(found[1]!.logo).toBeUndefined()
    })
})
