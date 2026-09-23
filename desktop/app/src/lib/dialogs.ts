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

import { createStore } from '@/lib/store'

/** The dialogs the shell raises. Named rather than counted, so a stuck flag has an owner. */
export type DialogName = 'settings' | 'shortcuts'

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

/** Say whether one dialog is standing. The shell is the only caller. */
export function setDialogOpen(name: DialogName, standing: boolean): void {
    dialogsOpen.update((open) => withDialog(open, name, standing))
}

/** Whether a bare key belongs to a dialog rather than to the app. */
export function dialogUp(): boolean {
    return anyOpen(dialogsOpen.get())
}
