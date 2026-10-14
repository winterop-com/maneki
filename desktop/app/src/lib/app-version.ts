/**
 * The release this bundle was built from, which is not the server's.
 *
 * A desktop shell carries its own copy of the client and talks to whatever server it is pointed
 * at, so the two drift: an app from last month against a server upgraded this morning. The
 * server's version is what `/capabilities` answers; this one is baked in at build time from
 * `pyproject.toml`, the one place a release is numbered (see `vite.config.ts`).
 */
export const APP_VERSION: string = __APP_VERSION__
