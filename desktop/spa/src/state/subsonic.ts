/**
 * Subsonic API client - talks to mediakit serve's /audio/rest/* mount (or any
 * spec-compliant Subsonic server at the configured baseUrl).
 *
 * Auth model: salted-token. At login the password is hashed once into
 * `token = md5(password + salt)`. The plaintext password is dropped after that
 * derivation - only (salt, token) is persisted in localStorage. Reusing the
 * same (salt, token) for every request is supported by the spec.
 */

import { md5 } from "js-md5";

const CLIENT_NAME = "mediakit-spa";
const API_VERSION = "1.16.1";

export interface SubsonicSession {
  baseUrl: string;
  user: string;
  salt: string;
  token: string;
}

export interface SubsonicArtist {
  id: string;
  name: string;
  albumCount?: number;
  coverArt?: string;
  starred?: string;
}

export interface SubsonicAlbum {
  id: string;
  name: string;
  artist?: string;
  artistId?: string;
  year?: number;
  songCount?: number;
  duration?: number;
  coverArt?: string;
  starred?: string;
}

export interface SubsonicSong {
  id: string;
  parent?: string;
  title: string;
  album?: string;
  albumId?: string;
  artist?: string;
  artistId?: string;
  track?: number;
  discNumber?: number;
  year?: number;
  genre?: string;
  duration?: number;
  bitRate?: number;
  suffix?: string;
  contentType?: string;
  coverArt?: string;
  starred?: string;
}

export interface SubsonicSearchResult {
  artist: SubsonicArtist[];
  album: SubsonicAlbum[];
  song: SubsonicSong[];
}

interface SubsonicEnvelope<T> {
  "subsonic-response": {
    status: "ok" | "failed";
    version?: string;
    error?: { code?: number; message?: string };
  } & T;
}

function genSalt(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function buildAuthQuery(session: SubsonicSession): URLSearchParams {
  return new URLSearchParams({
    u: session.user,
    t: session.token,
    s: session.salt,
    v: API_VERSION,
    c: CLIENT_NAME,
    f: "json",
  });
}

async function call<T>(
  session: SubsonicSession,
  endpoint: string,
  params?: Record<string, string | number | undefined>,
): Promise<T> {
  const qs = buildAuthQuery(session);
  if (params !== undefined) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
  }
  const url = `${session.baseUrl}/${endpoint}?${qs.toString()}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} on ${endpoint}`);
  }
  const json = (await response.json()) as SubsonicEnvelope<T>;
  const inner = json["subsonic-response"];
  if (inner === undefined) {
    throw new Error(`bad envelope on ${endpoint}`);
  }
  if (inner.status === "failed") {
    const code = inner.error?.code ?? "?";
    const msg = inner.error?.message ?? "unknown error";
    throw new Error(`Subsonic ${code}: ${msg}`);
  }
  return inner as T;
}

/** Build a URL for an asset (cover art, stream) - the (salt, token) is in the query string. */
export function assetUrl(
  session: SubsonicSession,
  endpoint: string,
  id: string,
  extra?: Record<string, string | number>,
): string {
  const qs = buildAuthQuery(session);
  qs.set("id", id);
  if (extra !== undefined) {
    for (const [k, v] of Object.entries(extra)) qs.set(k, String(v));
  }
  return `${session.baseUrl}/${endpoint}?${qs.toString()}`;
}

/** Derive a Subsonic session (salt + token) from the plaintext password. */
export async function authenticate(opts: {
  baseUrl: string;
  user: string;
  password: string;
}): Promise<SubsonicSession> {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const salt = genSalt();
  const token = md5(opts.password + salt);
  const session: SubsonicSession = { baseUrl: base, user: opts.user, salt, token };
  // Ping first so an invalid credential doesn't pollute storage.
  await call(session, "ping");
  return session;
}

interface IndexedArtists {
  artists?: { index?: { artist?: SubsonicArtist[] }[] };
}

interface ArtistDetail {
  artist?: SubsonicArtist & { album?: SubsonicAlbum[] };
}

interface AlbumDetail {
  album?: SubsonicAlbum & { song?: SubsonicSong[] };
}

interface Starred2Result {
  starred2?: SubsonicSearchResult;
}

interface SearchResult3Result {
  searchResult3?: SubsonicSearchResult;
}

export async function getArtists(session: SubsonicSession): Promise<SubsonicArtist[]> {
  const r = await call<IndexedArtists>(session, "getArtists");
  const index = r.artists?.index ?? [];
  const out: SubsonicArtist[] = [];
  for (const group of index) {
    for (const a of group.artist ?? []) out.push(a);
  }
  return out;
}

export async function getArtist(
  session: SubsonicSession,
  id: string,
): Promise<(SubsonicArtist & { album?: SubsonicAlbum[] }) | undefined> {
  const r = await call<ArtistDetail>(session, "getArtist", { id });
  return r.artist;
}

export async function getAlbum(
  session: SubsonicSession,
  id: string,
): Promise<(SubsonicAlbum & { song?: SubsonicSong[] }) | undefined> {
  const r = await call<AlbumDetail>(session, "getAlbum", { id });
  return r.album;
}

export async function getStarred2(session: SubsonicSession): Promise<SubsonicSearchResult> {
  const r = await call<Starred2Result>(session, "getStarred2");
  return r.starred2 ?? { artist: [], album: [], song: [] };
}

export async function search3(
  session: SubsonicSession,
  query: string,
  opts?: { artistCount?: number; albumCount?: number; songCount?: number },
): Promise<SubsonicSearchResult> {
  const r = await call<SearchResult3Result>(session, "search3", {
    query,
    artistCount: opts?.artistCount ?? 20,
    albumCount: opts?.albumCount ?? 20,
    songCount: opts?.songCount ?? 40,
  });
  return r.searchResult3 ?? { artist: [], album: [], song: [] };
}

export async function star(
  session: SubsonicSession,
  args: { id?: string; albumId?: string; artistId?: string },
): Promise<void> {
  await call(session, "star", args);
}

export async function unstar(
  session: SubsonicSession,
  args: { id?: string; albumId?: string; artistId?: string },
): Promise<void> {
  await call(session, "unstar", args);
}

export function coverArtUrl(
  session: SubsonicSession,
  coverArtId: string | undefined,
  size?: number,
): string | null {
  if (coverArtId === undefined || coverArtId === "") return null;
  return assetUrl(session, "getCoverArt", coverArtId, size !== undefined ? { size } : undefined);
}

export function streamUrl(session: SubsonicSession, trackId: string): string {
  return assetUrl(session, "stream", trackId);
}
