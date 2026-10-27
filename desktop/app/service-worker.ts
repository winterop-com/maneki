import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { Plugin } from 'vite'

/**
 * Write `sw.js`: `service-worker.js` with this build's files and a cache name drawn from them.
 *
 * THE FILE LIST IS WHAT IS ON DISK once the build is written, not the bundle Rollup hands a
 * plugin: that one still names chunks Vite drops afterwards (a stylesheet's empty script), and
 * one missing file fails the whole install. The cache name is a digest of every file's bytes, so
 * a build that changed anything, `index.html` included, is a worker the browser installs again.
 */
export function serviceWorker(): Plugin {
    return {
        name: 'maneki-service-worker',
        apply: 'build',
        writeBundle(options) {
            const outDir = options.dir ?? 'dist'
            const shell = readdirSync(outDir, { recursive: true, withFileTypes: true })
                .filter((entry) => entry.isFile())
                .map((entry) =>
                    path.relative(outDir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'),
                )
                .filter((name) => name !== 'sw.js' && !name.endsWith('.map'))
                .toSorted()
            const digest = createHash('sha256')
            for (const name of shell) digest.update(name).update(readFileSync(path.join(outDir, name)))
            const build = digest.digest('hex').slice(0, 12)
            const template = readFileSync(new URL('./service-worker.js', import.meta.url), 'utf8')
            writeFileSync(
                path.join(outDir, 'sw.js'),
                template.replace('__BUILD__', build).replace('__SHELL__', JSON.stringify(shell)),
            )
        },
    }
}
