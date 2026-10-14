import { describe, expect, it } from 'vitest'

import { answering, candidates } from '@/lib/server-address'
import type { Capabilities } from '@/lib/types'

describe('candidates', () => {
    it('tries a bare name on the default port first, then a tailscale serve front, then port 80', () => {
        expect(candidates('macmini')).toEqual(['http://macmini:8765', 'https://macmini', 'http://macmini'])
    })

    it('keeps a full tailnet name the same way', () => {
        expect(candidates('macmini.tail4a4b9a.ts.net')).toEqual([
            'http://macmini.tail4a4b9a.ts.net:8765',
            'https://macmini.tail4a4b9a.ts.net',
            'http://macmini.tail4a4b9a.ts.net',
        ])
    })

    it('tries a name with a port over both schemes and adds nothing else', () => {
        expect(candidates('macmini:9000')).toEqual(['http://macmini:9000', 'https://macmini:9000'])
    })

    it('takes a full URL as spelled, adding the default port only when none was given', () => {
        expect(candidates('http://macmini:8765')).toEqual(['http://macmini:8765'])
        expect(candidates('https://macmini.tail4a4b9a.ts.net')).toEqual(['https://macmini.tail4a4b9a.ts.net'])
        expect(candidates('http://macmini')).toEqual(['http://macmini', 'http://macmini:8765'])
    })

    it('takes a pasted phone address back to the root and drops trailing slashes', () => {
        expect(candidates('http://macmini:8765/audio/')).toEqual(['http://macmini:8765'])
        expect(candidates('macmini/audio')).toEqual([
            'http://macmini:8765',
            'https://macmini',
            'http://macmini',
        ])
    })

    it('offers nothing for nothing', () => {
        expect(candidates('   ')).toEqual([])
    })
})

describe('answering', () => {
    const caps = { server: 'maneki', version: '9.9.9' } as Capabilities

    it('asks the ways a typed name is reached, in order, and takes the first that answers', async () => {
        const asked: string[] = []
        const answer = await answering('macmini', (origin) => {
            asked.push(origin)
            return Promise.resolve(origin === 'https://macmini' ? caps : null)
        })
        expect(asked).toEqual(['http://macmini:8765', 'https://macmini'])
        expect(answer).toEqual({ origin: 'https://macmini', caps })
    })

    it('is null when nothing answers, and asks nothing for an empty field', async () => {
        expect(await answering('macmini', () => Promise.resolve(null))).toBeNull()
        let asked = 0
        expect(
            await answering('  ', () => {
                asked += 1
                return Promise.resolve(caps)
            }),
        ).toBeNull()
        expect(asked).toBe(0)
    })
})
