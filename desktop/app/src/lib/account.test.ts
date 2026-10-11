import { describe, expect, it } from 'vitest'

import { accountInitial, serverHost } from '@/lib/account'

describe('the account corner', () => {
    it('badges a name with its first letter, upper-cased', () => {
        expect(accountInitial('admin')).toBe('A')
        expect(accountInitial('  morten')).toBe('M')
        expect(accountInitial('ørjan')).toBe('Ø')
    })

    it('never draws an empty badge', () => {
        expect(accountInitial(undefined)).toBe('?')
        expect(accountInitial('   ')).toBe('?')
    })

    it('names the server by its host and port', () => {
        expect(serverHost('http://msai-media:8765')).toBe('msai-media:8765')
        expect(serverHost('https://music.example.org')).toBe('music.example.org')
    })

    it('shows a base URL that is not one as it is', () => {
        expect(serverHost('')).toBe('')
    })
})
