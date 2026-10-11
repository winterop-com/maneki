import { ChevronsUpDown, Keyboard, LogIn, LogOut, Monitor, Moon, Settings, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'

import { MODES, MODE_LABELS, type Mode } from '@/components/ThemeToggle'
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
import { useSmallScreen } from '@/hooks/use-small-screen'
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
export const SIGN_IN_LABEL = 'Sign in to a server'

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
    // ON A PHONE THE MENU IS ITS OWN COLUMN. There is no room beside the drawer for a submenu,
    // which flipped up over the menu it came from, and no keyboard for a shortcuts list: the
    // looks are three rows of the menu itself, and the shortcuts are left out.
    const small = useSmallScreen()
    // Listening without a server there is no account: the corner says so, and the way out is
    // to sign in to one rather than to sign out of nothing.
    const radioOnly = session.phase === 'radio'
    const name = radioOnly ? 'Radio only' : (session.username ?? 'Signed in')
    const host = radioOnly ? 'No server' : serverHost(session.baseUrl)
    const mode: Mode = theme === 'light' || theme === 'dark' ? theme : 'system'
    const ModeIcon = MODE_ICONS[mode]
    const looks = (
        <DropdownMenuRadioGroup value={mode} onValueChange={(chosen) => setTheme(String(chosen))}>
            {MODES.map((one) => {
                const Icon = MODE_ICONS[one]
                return (
                    <DropdownMenuRadioItem key={one} value={one} className={cn(small && 'min-h-finger')}>
                        <Icon aria-hidden />
                        {MODE_LABELS[one]}
                    </DropdownMenuRadioItem>
                )
            })}
        </DropdownMenuRadioGroup>
    )

    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                render={
                    <Button
                        variant="ghost"
                        aria-label={ACCOUNT_LABEL}
                        // The whole name, wherever the corner has to cut it short.
                        title={name}
                        className={cn(
                            'h-full w-full rounded-none text-sm text-muted-foreground hover:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground',
                            collapsed ? 'justify-center p-0' : 'justify-start gap-2.5 px-3',
                        )}
                    >
                        <Badge username={radioOnly ? 'Radio' : session.username} />
                        {!collapsed && (
                            <>
                                <span className="min-w-0 flex-1 truncate text-left font-medium">{name}</span>
                                <ChevronsUpDown className="size-3.5 shrink-0 opacity-60" aria-hidden />
                            </>
                        )}
                    </Button>
                }
            />
            {/* Inset 4 px inside the corner it opens from, so it lines up with the rail rather
                than running past its edge; never narrower than its rows need. */}
            <DropdownMenuContent
                side="top"
                align="start"
                sideOffset={6}
                alignOffset={4}
                className="w-[calc(var(--anchor-width)-8px)] min-w-56"
            >
                <DropdownMenuGroup>
                    <DropdownMenuLabel className="flex items-center gap-2.5 px-1.5 py-1.5" title={name}>
                        <Badge username={radioOnly ? 'Radio' : session.username} large />
                        <span className="min-w-0">
                            <span className="block truncate text-sm font-medium text-foreground">{name}</span>
                            {host !== '' && <span className="block truncate font-mono text-xs">{host}</span>}
                        </span>
                    </DropdownMenuLabel>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onSettings} className={cn(small && 'min-h-finger')}>
                    <Settings aria-hidden />
                    {SETTINGS_LABEL}
                </DropdownMenuItem>
                {!small && (
                    <DropdownMenuItem onClick={onShortcuts}>
                        <Keyboard aria-hidden />
                        {SHORTCUTS_LABEL}
                        <DropdownMenuShortcut>{SHORTCUTS_KEY}</DropdownMenuShortcut>
                    </DropdownMenuItem>
                )}
                {small ? (
                    <DropdownMenuGroup>
                        <DropdownMenuLabel>{APPEARANCE_LABEL}</DropdownMenuLabel>
                        {looks}
                    </DropdownMenuGroup>
                ) : (
                    <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                            {/* The look in force, not always the sun. */}
                            <ModeIcon aria-hidden />
                            {APPEARANCE_LABEL}
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent sideOffset={4} alignOffset={-4}>
                            {looks}
                        </DropdownMenuSubContent>
                    </DropdownMenuSub>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={signOut} className={cn(small && 'min-h-finger')}>
                    {radioOnly ? <LogIn aria-hidden /> : <LogOut aria-hidden />}
                    {radioOnly ? SIGN_IN_LABEL : SIGN_OUT_LABEL}
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
