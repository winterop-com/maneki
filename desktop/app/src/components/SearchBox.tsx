import { Search } from 'lucide-react'
import { SEARCH_TITLE } from '@/components/SearchOverlay'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Kbd } from '@/components/ui/kbd'
import { openSearch } from '@/lib/search'
import { SEARCH_KEY } from '@/lib/shortcuts'

export const SEARCH_BOX_PLACEHOLDER = 'Search'

/**
 * The search, where the client this replaces put it: a field at the left of the top strip.
 *
 * A DOOR RATHER THAN A BOX. What answers the question is the overlay -- one list of shelved
 * rows, arrows that walk them, a key that opens one -- and a second field that held text of its
 * own would be two places to type the same question into. So this one holds nothing ever:
 * clicking it, or typing into it, opens the overlay, and a letter typed goes with it, which is
 * why somebody who starts typing here never notices that the box they end up in is a different
 * one.
 *
 * IT IS NOT DRAWN BELOW THE BREAKPOINT. There the palette button already carries the search
 * glyph in the square the finger rule gives an icon button, and a phone has no room for a field
 * beside it -- the same reason the chord is a glyph down there.
 *
 * FOCUS ALONE OPENS NOTHING. It used to open on focus, so tabbing past it on the way into the
 * page threw up a dialog that held the Tab key (a change of context on focus), and the focus
 * handed back on Escape needed swallowing. A click, a letter, Enter or ArrowDown is somebody
 * asking; arriving by Tab is somebody passing through.
 */
export function SearchBox() {
    return (
        <InputGroup className="hidden w-56 md:flex">
            <InputGroupAddon>
                <Search aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
                // Never holds what was typed: the letters go to the overlay, and what is left
                // behind on the strip is the placeholder saying what the field is for.
                value=""
                aria-label={SEARCH_TITLE}
                placeholder={SEARCH_BOX_PLACEHOLDER}
                spellCheck={false}
                onPointerDown={(event) => {
                    event.preventDefault()
                    openSearch('')
                }}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === 'ArrowDown') {
                        event.preventDefault()
                        openSearch('')
                    }
                }}
                onChange={(event) => {
                    openSearch(event.target.value)
                }}
            />
            <InputGroupAddon align="inline-end">
                <Kbd>{SEARCH_KEY}</Kbd>
            </InputGroupAddon>
        </InputGroup>
    )
}
