import { describe, expect, test } from 'vitest'

import { recallScroll, rememberScroll } from '@/lib/scroll-memory'

describe('where a long list was left', () => {
    test('is given back to the list when somebody comes back to it', () => {
        // Back from a book always landed at the top of a 2313-book shelf.
        expect(recallScroll('books')).toBe(0)
        rememberScroll('books', 64_000)
        expect(recallScroll('books')).toBe(64_000)
        expect(recallScroll('elsewhere')).toBe(0)
    })
})
