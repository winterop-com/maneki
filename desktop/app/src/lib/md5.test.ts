import { describe, expect, test } from 'vitest'

import { md5 } from '@/lib/md5'

/**
 * The Subsonic token is `md5(password + salt)`, so a wrong digest means a
 * failed login and nothing else to debug. These are the RFC 1321 vectors
 * plus the worked example from the Subsonic API documentation.
 */
describe('md5', () => {
    test('matches the RFC 1321 vectors', () => {
        expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e')
        expect(md5('a')).toBe('0cc175b9c0f1b6a831c399e269772661')
        expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72')
        expect(md5('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0')
        expect(md5('abcdefghijklmnopqrstuvwxyz')).toBe('c3fcd3d76192e4007dfb496cca67e13b')
    })

    test('matches the Subsonic documentation example', () => {
        expect(md5('sesamec19b2d')).toBe('26719a1196d2a940705a59634eb18eab')
    })

    test('handles non-ASCII passwords', () => {
        expect(md5('Røyksopp')).toHaveLength(32)
        expect(md5('Røyksopp')).toBe(md5('Røyksopp'))
        expect(md5('Røyksopp')).not.toBe(md5('Royksopp'))
    })
})
