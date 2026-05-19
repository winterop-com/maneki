/**
 * Server capability discovery via GET /capabilities.
 *
 * The MediaKit server advertises what it has (audio? video?) and whether auth
 * is required for the MediaKit-native endpoints. The SPA branches its nav and
 * gating on this. Non-MediaKit servers (Navidrome, MusicKit, ...) don't expose
 * /capabilities at all - those 404 and the SPA falls back to assuming Subsonic
 * audio-only (handled at the use-site).
 */

export interface Capabilities {
  server: string;
  version: string;
  audio: boolean;
  video: boolean;
  auth_required: boolean;
  endpoints: Record<string, string | null>;
}

export async function fetchCapabilities(): Promise<Capabilities> {
  const resp = await fetch("/capabilities");
  if (!resp.ok) {
    throw new Error(`/capabilities returned HTTP ${resp.status}`);
  }
  return (await resp.json()) as Capabilities;
}
