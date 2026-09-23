/**
 * Every key this app answers, and the rules that decide when a press is one of them.
 *
 * KEYS ARE MATCHED BY THE CHARACTER THEY PRODUCE, NOT BY THE KEY THAT PRODUCED IT, and every
 * chord sits on a letter. On a Norwegian layout the bracket, brace, pipe and backslash keys all
 * need Alt to reach at all, so a binding over one of them is a binding nobody on these machines
 * can press. A letter is a letter on every layout, and `?` is tested as the character rather
 * than as Shift plus a physical key, because which physical key makes it moves with the layout.
 *
 * THE PRESS IS DECIDED HERE AND READ ELSEWHERE. These take a plain description of the press and
 * of whatever has focus, so the awkward half of a shortcut -- "not while somebody is typing",
 * "which modifier on which platform" -- is a pure function with a test rather than a condition
 * buried in an effect.
 */

/** The letter that opens the command palette, under either modifier. */
export const PALETTE_KEY = 'k'

/** The letter that collapses and expands the navigation rail, under the platform's own modifier. */
export const RAIL_KEY = 'b'

/** The letter that shows and hides the side panel, under the platform's own modifier. */
export const PANEL_KEY = 'j'

/** The character that puts this list on screen. */
export const SHORTCUTS_KEY = '?'

/** The character that starts and stops what is playing, pressed bare. */
export const PLAY_KEY = ' '

/** The letter that moves to the next track, pressed bare. */
export const NEXT_KEY = 'n'

/** The letter that moves to the previous track, pressed bare. */
export const PREVIOUS_KEY = 'p'

/** The letter that shows and hides the spectrum, pressed bare. */
export const VISUALIZER_KEY = 'v'

/** The letter that puts the spectrum over the whole screen, pressed bare. */
export const STAGE_KEY = 'f'

/** The letter that shuffles the queue, pressed bare. */
export const SHUFFLE_KEY = 's'

/** The letter that cycles what happens at the end of the queue, pressed bare. */
export const REPEAT_KEY = 'r'

/** The letter that takes the list off the side of a video, pressed bare. */
export const THEATER_KEY = 't'

/** How far one press of an arrow moves the playhead, in seconds. */
export const SEEK_S = 5

/**
 * The tags a bare press activates rather than reaches this app.
 *
 * Space on a focused button is that button, and a transport that stole it would make every
 * control in the app pause the music instead of doing its own job.
 */
export const PRESSABLE_TAG_NAMES = ['BUTTON', 'A', 'SUMMARY']

/** The tags a person types into. A press that lands in one of these is typing, not a shortcut. */
export const TYPING_TAG_NAMES = ['INPUT', 'TEXTAREA', 'SELECT']

/** One key press, reduced to what a shortcut has to know about it. */
export interface KeyPress {
    /** The character or named key the press produced -- `event.key`, verbatim. */
    key: string
    ctrlKey: boolean
    metaKey: boolean
    altKey: boolean
}

/** Whatever has focus, reduced to what a shortcut has to know about it. */
export interface FocusedField {
    /** The element's tag, upper case as the DOM gives it. */
    tagName: string
    /** True inside a rich-text region, where the browser claims plain letters. */
    isContentEditable: boolean
}

/** Whether something is being typed into, which a bare-character shortcut must never interrupt. */
export function isTypingField(focused: FocusedField | null): boolean {
    if (focused === null) return false
    return TYPING_TAG_NAMES.includes(focused.tagName.toUpperCase()) || focused.isContentEditable
}

/**
 * Whether this press opens the command palette.
 *
 * Either modifier, unlike the rail: Cmd+K and Ctrl+K both mean the palette in every app that
 * has one, and neither is claimed by anything here. It fires while a box has focus, because
 * the palette is how somebody leaves the box they are in.
 */
export function opensPalette(press: KeyPress): boolean {
    if (press.key.toLowerCase() !== PALETTE_KEY) return false
    if (press.altKey) return false
    return press.metaKey || press.ctrlKey
}

/**
 * Whether this press collapses or expands the navigation rail.
 *
 * CMD ON APPLE KEYBOARDS AND CTRL EVERYWHERE ELSE, rather than either modifier. Ctrl+B on macOS
 * is the emacs-style "back one character" that every text field answers, and a binding that
 * swallowed it would take a caret movement away from every input in the app.
 */
export function togglesRail(press: KeyPress, focused: FocusedField | null, apple: boolean): boolean {
    if (press.key.toLowerCase() !== RAIL_KEY) return false
    if (press.altKey) return false
    if (apple ? !press.metaKey : !press.ctrlKey || press.metaKey) return false
    return !(focused?.isContentEditable ?? false)
}

/**
 * Whether this press shows or hides the side panel.
 *
 * The rail's own modifier rule, for the same reason: Ctrl+J on macOS is a text field's own
 * binding, and a panel toggle that swallowed it would take that away from every input here.
 */
export function togglesPanel(press: KeyPress, focused: FocusedField | null, apple: boolean): boolean {
    if (press.key.toLowerCase() !== PANEL_KEY) return false
    if (press.altKey) return false
    if (apple ? !press.metaKey : !press.ctrlKey || press.metaKey) return false
    return !(focused?.isContentEditable ?? false)
}

/**
 * Whether this press asks for the list of shortcuts.
 *
 * No modifier beyond whatever the layout needs to produce the character: Shift is how most
 * keyboards make a `?` and so is not a modifier this can refuse, while Ctrl, Cmd and Alt each
 * mean something else somewhere. Never while something is being typed into -- a `?` typed into
 * a filter box is a question mark and nothing else.
 */
export function opensShortcuts(press: KeyPress, focused: FocusedField | null): boolean {
    if (press.key !== SHORTCUTS_KEY) return false
    if (press.ctrlKey || press.metaKey || press.altKey) return false
    return !isTypingField(focused)
}

/**
 * Whether this press starts or stops what is playing.
 *
 * SPACE, WHICH IS WHAT EVERY PLAYER BINDS, and the one binding here that is not a letter: it is
 * the same key on every layout, which is the property the letters-only rule is protecting. It
 * is refused while something is being typed into, and refused again while a button or a link
 * has focus -- there the press is that control's, and a transport that took it would turn every
 * control in the app into a pause button.
 */
export function togglesPlayback(press: KeyPress, focused: FocusedField | null): boolean {
    if (press.key !== PLAY_KEY && press.key !== 'Spacebar') return false
    if (press.ctrlKey || press.metaKey || press.altKey) return false
    if (isTypingField(focused)) return false
    return !PRESSABLE_TAG_NAMES.includes((focused?.tagName ?? '').toUpperCase())
}

/** Whether this press moves along the queue: `n` forward, `p` back. Never under a modifier. */
export function steps(press: KeyPress, focused: FocusedField | null): 'next' | 'previous' | null {
    if (press.ctrlKey || press.metaKey || press.altKey) return null
    if (isTypingField(focused)) return null
    const key = press.key.toLowerCase()
    if (key === NEXT_KEY) return 'next'
    if (key === PREVIOUS_KEY) return 'previous'
    return null
}

/**
 * Whether this press puts the spectrum over the whole screen.
 *
 * `f` for full screen, bare, beside the other listening letters. It is not the browser's own
 * full screen and does not ask for it: this is the app's own stage, and Escape leaves it.
 */
export function opensStage(press: KeyPress, focused: FocusedField | null): boolean {
    if (press.key.toLowerCase() !== STAGE_KEY) return false
    if (press.ctrlKey || press.metaKey || press.altKey) return false
    return !isTypingField(focused)
}

/**
 * Whether this press shuffles the queue, or cycles the repeat mode.
 *
 * Bare letters, like the rest of the transport: these are pressed while listening, and a chord
 * for each would be two more things to remember. Under a modifier they belong to the browser --
 * Cmd+S saves the page, Cmd+R reloads it -- so a modifier means this is not ours.
 */
export function togglesShuffle(press: KeyPress, focused: FocusedField | null): boolean {
    if (press.key.toLowerCase() !== SHUFFLE_KEY) return false
    if (press.ctrlKey || press.metaKey || press.altKey) return false
    return !isTypingField(focused)
}

export function cyclesRepeat(press: KeyPress, focused: FocusedField | null): boolean {
    if (press.key.toLowerCase() !== REPEAT_KEY) return false
    if (press.ctrlKey || press.metaKey || press.altKey) return false
    return !isTypingField(focused)
}

/**
 * Whether this press shows or hides the spectrum.
 *
 * A bare letter, the way the transport keys are: the visualizer is something somebody turns on
 * and off while listening, and a chord for it is a third thing to remember.
 */
export function togglesVisualizer(press: KeyPress, focused: FocusedField | null): boolean {
    if (press.key.toLowerCase() !== VISUALIZER_KEY) return false
    if (press.ctrlKey || press.metaKey || press.altKey) return false
    return !isTypingField(focused)
}

/**
 * Whether this press takes the list off the side of a video.
 *
 * A bare letter beside the transport's, because it is pressed while watching and a chord for it
 * would be one more thing to remember. `t` is free: it is the only letter in this range nothing
 * else here binds, and the run terminal it names in its sibling app does not exist in this one.
 */
export function togglesTheater(press: KeyPress, focused: FocusedField | null): boolean {
    if (press.key.toLowerCase() !== THEATER_KEY) return false
    if (press.ctrlKey || press.metaKey || press.altKey) return false
    return !isTypingField(focused)
}

/**
 * Whether this press moves the playhead, and which way.
 *
 * THE ARROWS ARE THE ONE BINDING HERE THAT IS NOT THE APP'S. They belong to whatever screen is
 * watching for them -- a list walks its rows with them, a slider moves by them -- so this is a
 * predicate a screen reads while it is mounted rather than a chord the shell answers. On a
 * screen playing a video they are the seek every player has, and nowhere else do they mean
 * anything at all.
 */
export function seeks(press: KeyPress, focused: FocusedField | null): 'forward' | 'back' | null {
    if (press.ctrlKey || press.metaKey || press.altKey) return null
    if (isTypingField(focused)) return null
    if (press.key === 'ArrowRight') return 'forward'
    if (press.key === 'ArrowLeft') return 'back'
    return null
}

/** Whether this browser runs on an Apple keyboard, which decides how a chord is spelled. */
export function applePlatform(userAgent: string): boolean {
    return /Mac|iPhone|iPad/.test(userAgent)
}

/** What the chord modifier is called here: the glyph every Apple keyboard carries, or the word. */
export function modifierLabel(apple: boolean): string {
    return apple ? '⌘' : 'Ctrl'
}

/** One shortcut: what pressing it does, and the keys pressed together to do it. */
export interface Shortcut {
    id: string
    /** What the press does, in plain language -- no key name inside the sentence. */
    action: string
    /** The keys, each spelled the way this platform spells it. */
    keys: string[]
}

/** Every shortcut this app answers, chords first because they are the ones nobody discovers. */
export function shortcuts(apple: boolean): Shortcut[] {
    const modifier = modifierLabel(apple)
    return [
        { id: 'palette', action: 'Open the command palette', keys: [modifier, 'K'] },
        { id: 'rail', action: 'Collapse or expand the navigation', keys: [modifier, 'B'] },
        { id: 'panel', action: 'Show or hide the side panel', keys: [modifier, 'J'] },
        { id: 'play', action: 'Start or stop what is playing', keys: ['Space'] },
        { id: 'next', action: 'Move to the next track', keys: ['N'] },
        { id: 'shuffle', action: 'Shuffle the queue', keys: ['S'] },
        { id: 'repeat', action: 'Repeat the queue, or one track', keys: ['R'] },
        { id: 'previous', action: 'Move to the previous track', keys: ['P'] },
        { id: 'visualizer', action: 'Show or hide the spectrum', keys: ['V'] },
        // One key, and what it puts on the whole screen is whatever is in front of somebody:
        // a screen playing a video claims it for that while it is open.
        { id: 'stage', action: 'Put the video, or the spectrum, over the whole screen', keys: ['F'] },
        { id: 'theater', action: 'Hide the list beside a video', keys: ['T'] },
        { id: 'seek', action: `Move a video ${String(SEEK_S)} seconds either way`, keys: ['←', '→'] },
        { id: 'shortcuts', action: 'Open this list', keys: [SHORTCUTS_KEY] },
        { id: 'dismiss', action: 'Close a dialog, a menu, or the palette', keys: ['Esc'] },
        { id: 'choose', action: 'Open the row that has focus', keys: ['Enter'] },
    ]
}
