/**
 * What the Radio screen marks as playing.
 *
 * A ROW IS THE ONE PLAYING BY ITS STREAM, NOT ONLY ITS ID. A station tried from search plays
 * under a preview id, so once kept, the saved row never lit up although it was the very stream
 * sounding. And a station that would not play is not playing: the row said "playing" beside a bar
 * that said "No sound from".
 */
export function stationIsPlaying(
    row: { id: string; streamUrl: string },
    playing: { id: string; streamUrl: string } | null,
    refused: boolean,
    sounding: boolean,
): boolean {
    // Nor is a paused one: the row said "playing" beside a bar offering Play.
    if (playing === null || refused || !sounding) return false
    return playing.id === row.id || playing.streamUrl === row.streamUrl
}
