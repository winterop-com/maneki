/**
 * Which of the shell's dialogs is standing.
 *
 * WHY A STORE AND NOT A PROP. The keys are read on the document, in `hooks/use-app-shortcuts`,
 * which is bound once and outside every dialog; what the shell knows about its own dialogs is
 * React state inside the shell. A store is the one line between the two, and it is the same
 * shape the palette and the search already answer that question with.
 *
 * WHAT IT IS FOR IS THE BARE KEYS. A chord is answered wherever focus is, because that is what
 * a chord is for; a bare letter belongs to whatever is in front of somebody, and while a
 * dialog is up that is the dialog. Opening the search over a settings pane, or putting the
 * spectrum on the whole screen behind the list of every shortcut, is two things at once in a
 * place that can only hold one.
 *
 * THE DECISIONS ARE PURE. `withDialog` and `anyOpen` are plain set arithmetic and are what is
 * worth a test; the store is the one line that has to be shared.
 */

import { createStore } from '@winterop-com/sokkel-ui/lib/stored'

/**
 * The dialogs standing over the app. Named rather than counted, so a stuck flag has an owner.
 *
 * `palette` is the frame's command palette, which the shell holds open for the app; it is
 * named here because it loads on first use, and a key pressed before it has drawn is still a
 * key pressed into it. `playlist` is the one a screen raises rather than the shell: choosing a
 * playlist, naming one, or saying yes to deleting one.
 */
export type DialogName = 'settings' | 'palette' | 'playlist'

/** Which of them are standing right now. */
export const dialogsOpen = createStore<ReadonlySet<DialogName>>(new Set())

/**
 * The set with one dialog's state written.
 *
 * A set that already says what it is being told answers with itself, so the store publishes on
 * identity and a dialog re-rendering does not wake every listener.
 */
export function withDialog(
    open: ReadonlySet<DialogName>,
    name: DialogName,
    standing: boolean,
): ReadonlySet<DialogName> {
    if (open.has(name) === standing) return open
    const next = new Set(open)
    if (standing) next.add(name)
    else next.delete(name)
    return next
}

/** Whether anything is standing over the app. */
export function anyOpen(open: ReadonlySet<DialogName>): boolean {
    return open.size > 0
}

/** Say whether one dialog is standing: the shell for its own, the playlist dialogs for theirs. */
export function setDialogOpen(name: DialogName, standing: boolean): void {
    dialogsOpen.update((open) => withDialog(open, name, standing))
}

/**
 * Whether a bare key belongs to a dialog rather than to the app.
 *
 * The named ones, and whatever modal dialog the document has open: the frame's shortcuts list
 * is the library's, held inside its shell, and is seen here by its open popup.
 */
export function dialogUp(): boolean {
    return anyOpen(dialogsOpen.get()) || (typeof document !== 'undefined' && dialogStanding(document))
}

/**
 * Whether a modal dialog is standing open in `doc`. Base UI marks an open popup `data-open`; the
 * player's fullscreen view carries no such mark and is the stage, not a dialog.
 */
export function dialogStanding(doc: Pick<Document, 'querySelector'>): boolean {
    return (
        doc.querySelector(
            '[role="dialog"][data-open]:not([aria-modal="false"]), [role="alertdialog"][data-open]:not([aria-modal="false"])',
        ) !== null
    )
}

/**
 * Whether the palette may open with `over` standing on top of the page, as the shell asks.
 *
 * Over nothing, when the app's own rules allow it; over the library search's results, which the
 * palette replaces (the shell's opening closes them); over anything else, never. The results are
 * a popover, which the shell counts as a layer, so Cmd+K from the field is asked about them.
 */
export function mayOpenPaletteOver(
    over: Element | null,
    standing: Standing,
    doc: Pick<Document, 'querySelectorAll'> = document,
): boolean {
    if (over === null) return mayOpen('palette', standing)
    return searchResults(over, doc)
}

/**
 * Whether a layer is the library search's results: the list the top bar's search field controls.
 *
 * sokkel-ui's `Search` marks its field (`data-slot="search"`) but not its popover, so the popover
 * is known by the list its field names in `aria-controls`.
 */
export function searchResults(
    layer: Pick<Element, 'querySelector'>,
    doc: Pick<Document, 'querySelectorAll'>,
): boolean {
    const list = layer.querySelector('[role="listbox"][id]')
    if (list === null) return false
    const fields = Array.from(doc.querySelectorAll('[data-slot="search"] [aria-controls]'))
    return fields.some((field) => field.getAttribute('aria-controls') === list.id)
}

/** What a key would open over the app. */
export type Opener = 'palette' | 'search' | 'shortcuts' | 'lyrics' | 'stage'

/** What is standing when the key is pressed, and whether a track (not a station) is playing. */
export interface Standing {
    dialog: boolean
    stage: boolean
    lyrics: boolean
    song: boolean
}

/**
 * Whether a key may open `opener` over what is already standing.
 *
 * ONE SURFACE AT A TIME. The palette opened over Settings, and Escape then left Settings stuck;
 * `?`, `/`, `l` and Cmd+K opened dialogs over the stage, and `f` the stage behind the lyrics,
 * with focus moving into what could not be seen. A key that would stack one surface on another
 * does nothing. And lyrics are a track's: over a station `l` opened "Nothing is playing".
 */
export function mayOpen(opener: Opener, standing: Standing): boolean {
    if (opener === 'palette' && standing.dialog) return false
    if (opener === 'stage') return !standing.lyrics
    if (standing.stage || standing.lyrics) return false
    if (opener === 'lyrics') return standing.song
    return true
}

/**
 * Whether a menu (the account menu, a select's list) is standing open in `doc`.
 *
 * A MENU IS A SURFACE TOO. The keys are read in the capture phase, ahead of the menu's own, so
 * with the account menu open its arrows also seeked the track, Space played instead of choosing,
 * type-ahead letters toggled shuffle and mute, and `f`, `/` and Cmd+K stacked the stage, the
 * search and the palette over it. While a menu is open the app answers no key at all.
 */
export function menuStanding(doc: Pick<Document, 'querySelector'>): boolean {
    // The app's own menus, by their slot: the video player keeps hidden `role="menu"` lists in
    // the page at all times, and matching those would take every key from the watch screen.
    return doc.querySelector('[data-slot="dropdown-menu-content"], [data-slot="select-content"]') !== null
}
