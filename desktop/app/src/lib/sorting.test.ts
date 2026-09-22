import { describe, expect, test } from 'vitest'

import { articlesOf, DEFAULT_ARTICLES, fold, initialOf, sortArtists, sortName } from '@/lib/sorting'

const artists = [
    { name: 'The Beatles', albumCount: 12 },
    { name: 'ABBA', albumCount: 2 },
    { name: 'Röyksopp', albumCount: 5 },
    { name: 'beck', albumCount: 2 },
    { name: '50 Cent', albumCount: 1 },
]

describe('the name a row sorts by', () => {
    test('has its leading article taken off, so The Beatles files under B', () => {
        expect(sortName('The Beatles')).toBe('Beatles')
        expect(sortName('Los Lobos')).toBe('Lobos')
    })

    test('keeps a word that only looks like an article', () => {
        expect(sortName('Theatre of Tragedy')).toBe('Theatre of Tragedy')
        expect(sortName('Theme Park')).toBe('Theme Park')
    })

    test('does not care how the article is capitalised', () => {
        expect(sortName('the beatles')).toBe('beatles')
        expect(sortName('THE BEATLES')).toBe('BEATLES')
    })

    test('a name that is only an article is left alone rather than emptied', () => {
        expect(sortName('The')).toBe('The')
    })

    test('takes the articles the server named, which are not always English', () => {
        expect(sortName('De Lillos', ['De', 'Den'])).toBe('Lillos')
        // With the default list, the Norwegian article is part of the name.
        expect(sortName('De Lillos')).toBe('De Lillos')
    })
})

describe('the articles a server named', () => {
    test('arrive space separated and come back as a list', () => {
        expect(articlesOf('The El La')).toEqual(['The', 'El', 'La'])
    })

    test('a server that says nothing gets the default list rather than none', () => {
        expect(articlesOf(undefined)).toEqual(DEFAULT_ARTICLES)
        expect(articlesOf('')).toEqual(DEFAULT_ARTICLES)
        expect(articlesOf('   ')).toEqual(DEFAULT_ARTICLES)
    })
})

describe('ordering a list of artists', () => {
    test('A-Z reads by the sorting name, not the printed one', () => {
        expect(sortArtists(artists, 'name').map((a) => a.name)).toEqual([
            '50 Cent',
            'ABBA',
            'The Beatles',
            'beck',
            'Röyksopp',
        ])
    })

    test('Z-A is the same order backwards', () => {
        const up = sortArtists(artists, 'name').map((a) => a.name)
        expect(sortArtists(artists, 'name-desc').map((a) => a.name)).toEqual(up.toReversed())
    })

    test('by albums puts the fullest shelves first and breaks ties by name', () => {
        expect(sortArtists(artists, 'albums').map((a) => a.name)).toEqual([
            'The Beatles',
            'Röyksopp',
            'ABBA',
            'beck',
            '50 Cent',
        ])
    })

    test('case is not a second alphabet: beck sorts beside Beatles, not after Z', () => {
        const names = sortArtists([{ name: 'beck' }, { name: 'Beatles' }, { name: 'Zoo' }], 'name')
        expect(names.map((a) => a.name)).toEqual(['Beatles', 'beck', 'Zoo'])
    })

    // The order of Ø against Z is the reader's own: Norwegian puts it after Z, English
    // beside O, and `localeCompare` with no locale follows the browser rather than deciding
    // here. What must hold everywhere is that it is a letter and not punctuation.
    test('a letter outside a-z is sorted as a letter, wherever the reader is', () => {
        const names = sortArtists([{ name: 'Ørjan' }, { name: 'Anne' }, { name: '4hero' }], 'name')
        expect(names[0]?.name).toBe('4hero')
        expect(names.map((a) => a.name)).toContain('Ørjan')
        expect(names).toHaveLength(3)
    })

    test('leaves the list it was handed alone', () => {
        const original = [...artists]
        sortArtists(artists, 'name-desc')
        expect(artists).toEqual(original)
    })
})

describe('the letter a name is filed under', () => {
    test('ignores the article, the way the sort does', () => {
        expect(initialOf('The Beatles')).toBe('B')
        expect(initialOf('röyksopp')).toBe('R')
    })

    test('anything that is not a letter is one group', () => {
        expect(initialOf('50 Cent')).toBe('#')
        expect(initialOf('[dunkelbunt]')).toBe('#')
        expect(initialOf('')).toBe('#')
    })
})

describe('folding a name for a search', () => {
    test('finds Röyksopp from royk, which is what a keyboard without an umlaut types', () => {
        expect(fold('Röyksopp').includes(fold('royk'))).toBe(true)
        expect(fold('Motörhead').includes(fold('motorhead'))).toBe(true)
        expect(fold('Sigur Rós').includes(fold('sigur ros'))).toBe(true)
    })

    test('still finds a name typed with its marks', () => {
        expect(fold('Röyksopp').includes(fold('röyk'))).toBe(true)
    })

    test('does not make two different names the same', () => {
        expect(fold('Beck')).not.toBe(fold('Bach'))
    })

    test('case is not a filter anybody typed on purpose', () => {
        expect(fold('ABBA')).toBe(fold('abba'))
    })
})
