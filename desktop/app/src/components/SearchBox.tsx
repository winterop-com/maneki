import { Search } from 'lucide-react'
import { useRef } from 'react'

import { SEARCH_TITLE } from '@/components/SearchOverlay'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Kbd } from '@/components/ui/kbd'
import { openSearch, searchOpen } from '@/lib/search'
import { SEARCH_KEY } from '@/lib/shortcuts'

export const SEARCH_BOX_PLACEHOLDER = 'Search'

/**
 * The search, where the client this replaces put it: a field at the left of the top strip.
 *
 * A DOOR RATHER THAN A BOX. What answers the question is the overlay -- one list of shelved
 * rows, arrows that walk them, a key that opens one -- and a second field that held text of its
 * own would be two places to type the same question into. So this one holds nothing ever:
 * focusing it opens the overlay, and a letter typed into it goes with it, which is why somebody
 * who starts typing here never notices that the box they end up in is a different one.
 *
 * IT IS NOT DRAWN BELOW THE BREAKPOINT. There the palette button already carries the search
 * glyph in the square the finger rule gives an icon button, and a phone has no room for a field
 * beside it -- the same reason the chord is a glyph down there.
 *
 * THE RETURNING FOCUS IS SWALLOWED. A dialog hands the focus back to whatever had it, which
 * here is the field that opened it, and a field that opens on focus would open again the moment
 * somebody escaped out of it. So the focus that comes back is let through once and does
 * nothing; a focus that arrives after this field has genuinely lost it is somebody asking again.
 */
export function SearchBox() {
    const returning = useRef(false)

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
                onFocus={() => {
                    if (returning.current) {
                        returning.current = false
                        return
                    }
                    returning.current = true
                    openSearch('')
                }}
                onBlur={() => {
                    // Only the focus the overlay hands back is swallowed. Losing it to something
                    // else while nothing is open means the next one is a fresh ask.
                    if (!searchOpen.get()) returning.current = false
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
