import { Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'

import { Button } from '@/components/ui/button'

/** Light or dark, on the mode axis that next-themes owns. The palette is chosen elsewhere. */
export function ThemeToggle() {
    const { resolvedTheme, setTheme } = useTheme()
    const dark = resolvedTheme === 'dark'
    return (
        <Button
            variant="ghost"
            size="sm"
            aria-label={dark ? 'Switch to light' : 'Switch to dark'}
            onClick={() => setTheme(dark ? 'light' : 'dark')}
        >
            {dark ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
        </Button>
    )
}
