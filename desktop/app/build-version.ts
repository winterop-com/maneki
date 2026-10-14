import { readFileSync } from 'node:fs'

/**
 * The release number, read from `pyproject.toml` -- the one place a release is numbered -- and
 * handed to the bundle as `__APP_VERSION__`. Shared by the build and the tests so both see the
 * same number. See `src/lib/app-version.ts` for why the client carries its own.
 */
export function appVersionDefine(): { __APP_VERSION__: string } {
    const pyproject = readFileSync(new URL('../../pyproject.toml', import.meta.url), 'utf8')
    const version = /^version = "([^"]+)"/m.exec(pyproject)?.[1]
    if (version === undefined) throw new Error('no version in pyproject.toml')
    return { __APP_VERSION__: JSON.stringify(version) }
}
