import { BookAudio, Clapperboard, Music, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { NavLink } from 'react-router'

import { ThemeToggle } from '@/components/ThemeToggle'
import { useStore } from '@/hooks/use-store'
import { cn } from '@/lib/utils'
import { sessionStore, signOut } from '@/lib/session'
import { Button } from '@/components/ui/button'

interface Section {
    to: string
    label: string
    icon: LucideIcon
    /** Whether this server has anything to show here. */
    present: (has: { audio: boolean; video: boolean; books: boolean }) => boolean
}

const SECTIONS: Section[] = [
    { to: '/music', label: 'Music', icon: Music, present: (has) => has.audio },
    { to: '/video', label: 'Video', icon: Clapperboard, present: (has) => has.video },
    { to: '/books', label: 'Audiobooks', icon: BookAudio, present: (has) => has.books },
]

/**
 * The frame every screen sits in: a rail of sections, a strip along the top, the screen below.
 *
 * A section the server has nothing for is not drawn, so a music-only library
 * shows one entry rather than three, two of which lead nowhere.
 */
export function AppShell({ children }: { children: ReactNode }) {
    const session = useStore(sessionStore)
    const caps = session.capabilities
    const has = { audio: !!caps?.audio, video: !!caps?.video, books: !!caps?.books }
    const sections = SECTIONS.filter((section) => section.present(has))

    return (
        <div className="flex h-svh bg-background text-foreground">
            {sections.length > 1 && (
                <nav
                    aria-label="Sections"
                    className="flex w-14 shrink-0 flex-col items-center gap-1 border-r bg-sidebar py-2 md:w-48 md:items-stretch md:px-2"
                >
                    {sections.map((section) => (
                        <NavLink
                            key={section.to}
                            to={section.to}
                            className={({ isActive }) =>
                                cn(
                                    'row-hover flex min-h-finger items-center gap-3 rounded-md px-3 text-sm',
                                    'border-l-2 border-transparent',
                                    isActive && 'border-sidebar-primary bg-muted font-medium',
                                )
                            }
                        >
                            <section.icon className="size-4 shrink-0" aria-hidden />
                            <span className="hidden md:inline">{section.label}</span>
                            <span className="sr-only md:hidden">{section.label}</span>
                        </NavLink>
                    ))}
                </nav>
            )}
            <div className="flex min-w-0 flex-1 flex-col">
                <header className="flex h-shell-top shrink-0 items-center gap-3 border-b px-4">
                    <span className="text-sm font-medium">Maneki</span>
                    {caps && <span className="text-xs text-muted-foreground">{caps.version}</span>}
                    <div className="ml-auto flex items-center gap-2">
                        <ThemeToggle />
                        {caps?.auth_required && (
                            <Button variant="ghost" size="sm" onClick={signOut}>
                                Sign out
                            </Button>
                        )}
                    </div>
                </header>
                <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
            </div>
        </div>
    )
}
