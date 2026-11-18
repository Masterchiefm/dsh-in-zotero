// Single source of truth for the plugin version: package.json.
import { createRequire } from 'node:module'

export const version = createRequire(import.meta.url)('../package.json').version
