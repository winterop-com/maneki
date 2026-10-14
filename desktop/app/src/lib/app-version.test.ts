import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, test } from 'vitest'

import { APP_VERSION } from '@/lib/app-version'

describe('APP_VERSION', () => {
    test("is the release this bundle was built from: pyproject's version", () => {
        const pyproject = readFileSync(
            path.resolve(import.meta.dirname, '../../../../pyproject.toml'),
            'utf8',
        )
        expect(APP_VERSION).toBe(/^version = "([^"]+)"/m.exec(pyproject)?.[1])
    })
})
