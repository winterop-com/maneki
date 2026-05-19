/**
 * Video listing fetched from GET /video/api/videos. Uses authedFetch from the
 * auth context when --auth is on; passes through unchanged otherwise.
 */

export interface SubtitleSummary {
  lang: string;
  format: string;
  url?: string;
}

export interface Video {
  id: string;
  name: string;
  path: string;
  size_bytes: number;
  rel_path: string;
  duration_s: number | null;
  subtitles: SubtitleSummary[];
}

export type AuthedFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function fetchVideos(authedFetch: AuthedFetch): Promise<Video[]> {
  const resp = await authedFetch("/video/api/videos");
  if (!resp.ok) {
    throw new Error(`/video/api/videos returned HTTP ${resp.status}`);
  }
  return (await resp.json()) as Video[];
}

export async function fetchSubtitles(authedFetch: AuthedFetch, videoId: string): Promise<SubtitleSummary[]> {
  const resp = await authedFetch(`/video/api/videos/${encodeURIComponent(videoId)}/subtitles`);
  if (!resp.ok) return [];
  return (await resp.json()) as SubtitleSummary[];
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "?:??";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatSize(bytes: number): string {
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(bytes / 1e6).toFixed(1)} MB`;
}
