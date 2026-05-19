/**
 * Unified session model. ONE login form fills:
 *
 *   - SubsonicSession: salt-token derived from the plaintext password,
 *     used for every /audio/rest/* call (the spec's auth grammar).
 *   - MediaKitSession: bearer token from POST /auth/login, used for
 *     /video/* (and future MediaKit-native endpoints) when --auth is on.
 *
 * Either may be null:
 *   - audio-disabled server -> subsonic is null
 *   - --auth off            -> mediakit is null
 *
 * Login derives both in parallel when possible, swallowing the irrelevant
 * one if the server doesn't advertise that kind.
 *
 * Cross-origin Subsonic servers (Navidrome on a different URL) are NOT
 * supported by this SPA - it assumes same-origin (the mediakit serve --ui
 * deployment).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { authenticate } from "./subsonic";
import type { SubsonicSession } from "./subsonic";
import type { Capabilities } from "./capabilities";

const STORAGE_KEY = "mediakit.auth.session";

interface MediaKitSession {
  token: string;
  username: string;
  expiresAt: string;
}

interface UnifiedSession {
  username: string;
  subsonic: SubsonicSession | null;
  mediakit: MediaKitSession | null;
}

interface AuthContextValue {
  session: UnifiedSession | null;
  isAuthenticated: boolean;
  login: (capabilities: Capabilities, username: string, password: string) => Promise<void>;
  logout: () => void;
  authedFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function readStoredSession(): UnifiedSession | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    return JSON.parse(raw) as UnifiedSession;
  } catch {
    return null;
  }
}

function writeStoredSession(session: UnifiedSession | null): void {
  if (session === null) {
    window.localStorage.removeItem(STORAGE_KEY);
  } else {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }
}

async function mediakitLogin(username: string, password: string): Promise<MediaKitSession> {
  const resp = await fetch("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`/auth/login HTTP ${resp.status}: ${detail || "no detail"}`);
  }
  const data = (await resp.json()) as { token: string; username: string; expires_at: string };
  return { token: data.token, username: data.username, expiresAt: data.expires_at };
}

export function AuthProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [session, setSession] = useState<UnifiedSession | null>(() => readStoredSession());

  useEffect(() => {
    writeStoredSession(session);
  }, [session]);

  const login = useCallback(
    async (capabilities: Capabilities, username: string, password: string): Promise<void> => {
      let subsonic: SubsonicSession | null = null;
      let mediakit: MediaKitSession | null = null;

      // Both auth surfaces run against window.location.origin. The mediakit
      // serve mounts /audio/rest at /audio (capabilities.endpoints.audio_subsonic)
      // and /auth/login at /auth/login.
      if (capabilities.audio) {
        const audioMount = capabilities.endpoints.audio_subsonic ?? "/audio/rest";
        subsonic = await authenticate({
          baseUrl: window.location.origin + audioMount,
          user: username,
          password,
        });
      }
      if (capabilities.auth_required) {
        mediakit = await mediakitLogin(username, password);
      }

      if (subsonic === null && mediakit === null) {
        // Nothing to authenticate against. Either misconfigured server or the
        // SPA was loaded without anything to do - signal so the form shows.
        throw new Error("server has neither audio nor MediaKit auth requirements; nothing to log into");
      }
      setSession({ username, subsonic, mediakit });
    },
    [],
  );

  const logout = useCallback((): void => {
    setSession(null);
  }, []);

  const authedFetch = useCallback(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      const bearer = session?.mediakit?.token;
      if (bearer !== undefined && bearer !== "") {
        headers.set("Authorization", `Bearer ${bearer}`);
      }
      return fetch(input, { ...init, headers });
    },
    [session],
  );

  const value: AuthContextValue = useMemo(
    () => ({
      session,
      isAuthenticated: session !== null,
      login,
      logout,
      authedFetch,
    }),
    [session, login, logout, authedFetch],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}

/** Convenience selector for code that needs the Subsonic session specifically. */
export function useSubsonicSession(): SubsonicSession | null {
  return useAuth().session?.subsonic ?? null;
}
