import { ChevronsUpDown, Keyboard, LogOut, Monitor, Moon, Settings, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'

import { MODES, MODE_LABELS } from '@/components/ThemeToggle'
import { Button } from '@/components/ui/button'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuShortcut,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useStore } from '@/hooks/use-store'
import { accountInitial, serverHost } from '@/lib/account'
import { sessionStore, signOut } from '@/lib/session'
import { SHORTCUTS_KEY } from '@/lib/shortcuts'
import { cn } from '@/lib/utils'

export const SETTINGS_LABEL = 'Settings'
export const ACCOUNT_LABEL = 'Account'
export const SHORTCUTS_LABEL = 'Keyboard shortcuts'
export const APPEARANCE_LABEL = 'Appearance'
export const SIGN_OUT_LABEL = 'Sign out'

const MODE_ICONS = { light: Sun, dark: Moon, system: Monitor } as const

/**
 * The account: who is signed in, to which server, and what goes with being them.
 *
 * THE CORNER IS THE ACCOUNT, as a desktop app keeps it: settings, the shortcuts, the look and
 * signing out open as one menu from the badge, upward, and the name is said here and nowhere
 * else in the shell. Before this the corner held only Settings, the name sat loose in the
 * status line, and signing out was reachable only from the command palette. The phone's
 * drawer carries the same menu at its foot.
 */
export function AccountMenu({
    collapsed,
    onSettings,
    onShortcuts,
}: {
    collapsed: boolean
    onSettings: () => void
    onShortcuts: () => void
}) {
    const session = useStore(sessionStore)
    const { theme, setTheme } = useTheme()
    const name = session.username ?? 'Signed in'
    const host = serverHost(session.baseUrl)

    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                render={
                    <Button
                        variant="ghost"
                        aria-label={ACCOUNT_LABEL}
                        title={collapsed ? name : undefined}
                        className={cn(
                            'h-full w-full rounded-none text-xs text-muted-foreground hover:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground',
                            collapsed ? 'justify-center p-0' : 'justify-start gap-2.5 px-3',
                        )}
                    >
                        <Badge username={session.username} />
                        {!collapsed && (
                            <>
                                <span className="min-w-0 flex-1 truncate text-left font-medium">{name}</span>
                                <ChevronsUpDown className="size-3.5 shrink-0 opacity-60" aria-hidden />
                            </>
                        )}
                    </Button>
                }
            />
            <DropdownMenuContent side="top" align="start" sideOffset={6} className="w-60">
                <DropdownMenuGroup>
                    <DropdownMenuLabel className="flex items-center gap-2.5 px-1.5 py-1.5">
                        <Badge username={session.username} large />
                        <span className="min-w-0">
                            <span className="block truncate text-sm font-medium text-foreground">{name}</span>
                            {host !== '' && <span className="block truncate font-mono text-xs">{host}</span>}
                        </span>
                    </DropdownMenuLabel>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onSettings}>
                    <Settings aria-hidden />
                    {SETTINGS_LABEL}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onShortcuts}>
                    <Keyboard aria-hidden />
                    {SHORTCUTS_LABEL}
                    <DropdownMenuShortcut>{SHORTCUTS_KEY}</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                        <Sun aria-hidden />
                        {APPEARANCE_LABEL}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                        <DropdownMenuRadioGroup
                            value={theme ?? 'system'}
                            onValueChange={(mode) => setTheme(String(mode))}
                        >
                            {MODES.map((mode) => {
                                const Icon = MODE_ICONS[mode]
                                return (
                                    <DropdownMenuRadioItem key={mode} value={mode}>
                                        <Icon aria-hidden />
                                        {MODE_LABELS[mode]}
                                    </DropdownMenuRadioItem>
                                )
                            })}
                        </DropdownMenuRadioGroup>
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={signOut}>
                    <LogOut aria-hidden />
                    {SIGN_OUT_LABEL}
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    )
}

/** The account's letter in a circle of the accent. */
function Badge({ username, large = false }: { username: string | undefined; large?: boolean }) {
    return (
        <span
            aria-hidden
            className={cn(
                'flex shrink-0 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground',
                large ? 'size-8 text-sm' : 'size-6 text-[11px]',
            )}
        >
            {accountInitial(username)}
        </span>
    )
}
