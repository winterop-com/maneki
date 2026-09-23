import { barHeights, COVER_TINTS, COVER_VIEWBOX, coverFace, type CoverFace } from '@/lib/covers'
import { cn } from '@/lib/utils'

/**
 * The mark a record wears when it has no sleeve.
 *
 * `lib/covers` decides which face an id gets and how strongly it is inked; this draws it. The
 * split is the usual one -- the decision is arithmetic a Node test makes, and what is left here
 * is eight lists of coordinates.
 *
 * IT IS SIZED BY WHOEVER DRAWS IT, exactly as the flat square it replaces was: the caller's
 * classes are the size, and the square is kept by `aspect-square` rather than by a width this
 * component picked. So the shelf card's cover follows its column, the player bar's is 36px, and
 * neither has to be told about the other.
 *
 * IT IS HIDDEN FROM A SCREEN READER. The title is always beside it, and a drawing derived from
 * an id has nothing to say that the title does not already say better.
 */
export function CoverArt({ id, className }: { id: string; className?: string }) {
    const face = coverFace(id)
    return (
        <svg
            viewBox={`0 0 ${String(COVER_VIEWBOX)} ${String(COVER_VIEWBOX)}`}
            aria-hidden
            className={cn('aspect-square bg-muted text-foreground', className)}
        >
            <Face face={face} />
        </svg>
    )
}

/**
 * One face, drawn in the ink the surface hands it.
 *
 * Every shape is `currentColor` at an alpha, so the whole set follows the palette and the mode
 * with nothing kept in step by hand. Three depths per face -- the ink, a lighter pass under it
 * and a stronger accent on top -- which is what stops a drawing at 12% alpha being one flat
 * silhouette.
 */
function Face({ face }: { face: CoverFace }) {
    const ink = COVER_TINTS[face.tint]
    const under = ink * 0.55
    const over = ink * 1.7

    switch (face.kind) {
        case 'rings':
            return (
                <g fill="none" stroke="currentColor" strokeWidth={1.5}>
                    <circle cx={32} cy={32} r={25} opacity={under} />
                    <circle cx={32} cy={32} r={18} opacity={ink} />
                    <circle cx={32} cy={32} r={11} opacity={ink} />
                    <circle cx={32} cy={32} r={4} opacity={over} />
                </g>
            )
        case 'wave':
            return (
                <g fill="currentColor">
                    <path d="M0 34 Q16 22 32 34 T64 34 L64 64 L0 64 Z" opacity={under} />
                    <path d="M0 44 Q16 32 32 44 T64 44 L64 64 L0 64 Z" opacity={ink} />
                    <path d="M0 54 Q16 44 32 54 T64 54 L64 64 L0 64 Z" opacity={over} />
                </g>
            )
        case 'peaks':
            return (
                <g fill="currentColor">
                    <path d="M0 64 L22 22 L36 40 L48 26 L64 64 Z" opacity={ink} />
                    <path d="M0 64 L16 40 L30 52 L44 36 L64 64 Z" opacity={over} />
                </g>
            )
        case 'orb':
            return (
                <g fill="currentColor">
                    <circle cx={32} cy={36} r={21} opacity={ink} />
                    <path d="M11 36 Q32 11 53 36 Q32 61 11 36 Z" opacity={under} />
                    <circle cx={32} cy={36} r={6} opacity={over} />
                </g>
            )
        case 'bars': {
            // The one face whose shape is the id rather than a constant: a row of fixed bars
            // would be one drawing worn by every eighth record in the library. A bar is keyed by
            // where it stands, which is what a bar in a row is.
            const bars = barHeights(face.hash).map((height, index) => ({
                x: 5 + index * 8,
                height: height * 50,
                loud: index % 2 === 0,
            }))
            return (
                <g fill="currentColor">
                    {bars.map((bar) => (
                        <rect
                            key={bar.x}
                            x={bar.x}
                            y={58 - bar.height}
                            width={5}
                            height={bar.height}
                            rx={1}
                            opacity={bar.loud ? ink : over}
                        />
                    ))}
                </g>
            )
        }
        case 'grid':
            return (
                <g fill="currentColor">
                    {[0, 1, 2, 3].map((row) =>
                        [0, 1, 2, 3].map((column) => (
                            <circle
                                key={`${String(row)}-${String(column)}`}
                                cx={13 + column * 12.5}
                                cy={13 + row * 12.5}
                                r={(row + column) % 3 === 0 ? 4 : 2.5}
                                opacity={(row + column) % 3 === 0 ? over : ink}
                            />
                        )),
                    )}
                </g>
            )
        case 'sun':
            return (
                <g>
                    <circle cx={43} cy={21} r={12} fill="currentColor" opacity={over} />
                    <g stroke="currentColor" strokeWidth={1.5} opacity={ink}>
                        <line x1={0} y1={42} x2={64} y2={42} />
                        <line x1={0} y1={48} x2={64} y2={48} />
                        <line x1={0} y1={54} x2={64} y2={54} />
                    </g>
                    <path d="M0 64 L64 64 L64 58 L0 58 Z" fill="currentColor" opacity={under} />
                </g>
            )
        default:
            return (
                <g fill="none" stroke="currentColor">
                    <rect x={6} y={6} width={52} height={52} strokeWidth={1.5} opacity={under} />
                    <rect x={14} y={14} width={36} height={36} strokeWidth={1.5} opacity={ink} />
                    <rect x={24} y={24} width={16} height={16} strokeWidth={2} opacity={over} />
                </g>
            )
    }
}
