/**
 * Keeps bun.lock fetching public packages from the public registry.
 *
 * Only @winterop-com comes from GitHub Packages. Dependabot, given a GitHub Packages token so it
 * can read sokkel-ui, has written ordinary packages (`@types/react` and the like) into bun.lock
 * with npm.pkg.github.com addresses. GitHub Packages hands those on only to a token that can read
 * packages, so the install fails with a 403 wherever the token cannot, a Dependabot pull
 * request's CI among them.
 *
 *   bun lockfile-registry.ts          fail, naming the packages, when any is pointed there
 *   bun lockfile-registry.ts --fix    point them back at the default registry
 *
 * It runs before `bun install` (the Makefile's app-gate), so needs nothing installed.
 */

const LOCKFILE = new URL('./bun.lock', import.meta.url)
const MISPLACED = /"https:\/\/npm\.pkg\.github\.com\/(?!download\/@winterop-com\/)([^"]+?)\/-\/[^"]+\.tgz"/g

const text = await Bun.file(LOCKFILE).text()
const found = [...text.matchAll(MISPLACED)].map((match) => match[1])

if (process.argv.includes('--fix')) {
    await Bun.write(LOCKFILE, text.replace(MISPLACED, '""'))
    process.stdout.write(`bun.lock: ${String(found.length)} packages pointed back at the default registry\n`)
} else if (found.length > 0) {
    console.error(
        `bun.lock fetches ${String(found.length)} public packages from GitHub Packages, which a token ` +
            `without package access cannot read: ${found.slice(0, 5).join(', ')}` +
            `${found.length > 5 ? ', ...' : ''}\nFix it with: cd desktop/app && bun lockfile-registry.ts --fix`,
    )
    process.exit(1)
}
