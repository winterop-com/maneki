import { useCallback, useRef, useSyncExternalStore } from 'react'

import type { Store } from '@/lib/store'

/** Read a module store in a component, re-rendering when it changes. */
export function useStore<T>(store: Store<T>): T {
    return useSyncExternalStore(store.subscribe, store.get, store.get)
}

/**
 * Read one fact out of a store, re-rendering only when that fact changes.
 *
 * WHY THIS EXISTS. The player's store publishes four times a second while a track plays --
 * the position moved, and that is what a scrub bar is for. A component that reads the whole
 * store to learn whether anything is queued re-renders on every one of those ticks, and so
 * does everything under it: the shell reading `queue.length` this way re-rendered the rail,
 * the status bar and the whole open track list four times a second, which is felt as a
 * pointer that will not keep up.
 *
 * The selected value is compared with `Object.is` and the last one is kept, so a selector
 * returning a primitive re-renders only when that primitive changes. A selector that builds a
 * fresh object each call would defeat it, so selectors return one fact at a time.
 */
export function useStoreValue<T, S>(store: Store<T>, select: (state: T) => S): S {
    const held = useRef<{ from: T; value: S } | null>(null)
    const snapshot = useCallback(() => {
        const state = store.get()
        // The store's own snapshot is stable between changes, so an unchanged state answers
        // the held value without running the selector again.
        if (held.current !== null && Object.is(held.current.from, state)) return held.current.value
        const value = select(state)
        // A change that does not touch this fact keeps the previous value, which is what stops
        // the re-render: `useSyncExternalStore` compares what it is handed.
        const kept =
            held.current !== null && Object.is(held.current.value, value) ? held.current.value : value
        held.current = { from: state, value: kept }
        return kept
    }, [select, store])
    return useSyncExternalStore(store.subscribe, snapshot, snapshot)
}
