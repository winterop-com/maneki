import { Radio as RadioIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useStore } from '@/hooks/use-store'
import { playerStore, playStation } from '@/lib/player'
import { sessionStore } from '@/lib/session'
import { getStations, type Station } from '@/lib/subsonic'
import { cn } from '@/lib/utils'

/** The stations this server carries. Picking one replaces whatever was playing. */
export function RadioPage() {
    const session = useStore(sessionStore)
    const player = useStore(playerStore)
    const [stations, setStations] = useState<Station[] | null>(null)
    const [refusal, setRefusal] = useState<string | null>(null)
    const credentials = session.music

    useEffect(() => {
        if (!credentials) return
        getStations(credentials)
            .then(setStations)
            .catch((error: Error) => setRefusal(error.message))
    }, [credentials])

    if (!credentials) return <Notice>This server has no stations.</Notice>
    if (refusal) return <Notice>{refusal}</Notice>
    if (!stations) return <Notice>Reading the stations.</Notice>
    if (!stations.length) return <Notice>No stations.</Notice>

    return (
        <ul className="p-2">
            {stations.map((station) => {
                const live = player.station?.id === station.id
                return (
                    <li key={station.id}>
                        <button
                            type="button"
                            onClick={() => playStation(station)}
                            aria-current={live ? 'true' : undefined}
                            className={cn(
                                'row-hover flex min-h-finger w-full items-center gap-3 rounded-md px-3 text-left text-sm',
                                live && 'bg-muted font-medium',
                            )}
                        >
                            <RadioIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                            <span className="min-w-0 flex-1 truncate">{station.name}</span>
                            {live && <span className="shrink-0 text-xs text-muted-foreground">playing</span>}
                        </button>
                    </li>
                )
            })}
        </ul>
    )
}

function Notice({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex h-full items-center justify-center p-8">
            <p className="text-sm text-muted-foreground">{children}</p>
        </div>
    )
}
