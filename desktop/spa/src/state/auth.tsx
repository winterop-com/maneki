/**
 * Auth state: bearer token stored in localStorage, exchanged via POST /auth/login.
 *
 * When the server has auth_required=true, every fetch to /video/* (and later
 * to other MediaKit-native endpoints) must carry `Authorization: Bearer <token>`.
 * The audio Subsonic mount at /audio/rest/* has its own auth grammar; this
 * context does NOT cover that side.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

const STORAGE_KEY = "mediakit.auth.token";

interface AuthSession {
  token: string;
  username: string;
  expiresAt: string;
}

interface AuthContextValue {
  session: AuthSession | null;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  authedFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function readStoredSession(): AuthSession | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    return JSON.parse(raw) as AuthSession;
  } catch {
    return null;
  }
}

function writeStoredSession(session: AuthSession | null): void {
  if (session === null) {
    window.localStorage.removeItem(STORAGE_KEY);
  } else {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }
}

export function AuthProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [session, setSession] = useState<AuthSession | null>(() => readStoredSession());

  // Keep localStorage in sync whenever session changes (login/logout).
  useEffect(() => {
    writeStoredSession(session);
  }, [session]);

  const login = useCallback(async (username: string, password: string): Promise<void> => {
    const resp = await fetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!resp.ok) {
      const detail = await resp.text();
      throw new Error(`login failed (HTTP ${resp.status}): ${detail || "no detail"}`);
    }
    const data = (await resp.json()) as { token: string; username: string; expires_at: string };
    setSession({ token: data.token, username: data.username, expiresAt: data.expires_at });
  }, []);

  const logout = useCallback((): void => {
    setSession(null);
  }, []);

  const authedFetch = useCallback(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      if (session !== null) {
        headers.set("Authorization", `Bearer ${session.token}`);
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
