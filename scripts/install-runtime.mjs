// Installs the dsh runtime (the @deepseek-ai/dsh npm package) into a local
// directory, mirroring what the Zotero plugin does on first run.
//
//   node scripts/install-runtime.mjs [targetDir]

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const target = process.argv[2] ?? path.join(ROOT, '.dsh-runtime')
const version = process.env.DSH_VERSION ?? '0.2.2-rc.1'

fs.mkdirSync(target, { recursive: true })
fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({
	name: 'dsh-in-zotero-runtime',
	private: true,
}, null, 2))

console.log(`installing @deepseek-ai/dsh@${version} into ${target} …`)
execFileSync(process.execPath, [
	// npm-cli.js ships next to node.exe on Windows and inside lib/node_modules elsewhere.
	...(process.platform === 'win32'
		? [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')]
		: [path.join(path.dirname(path.dirname(process.execPath)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]),
	'install', '--no-audit', '--no-fund', '--loglevel=error',
	`@deepseek-ai/dsh@${version}`,
	`--prefix`, target,
], { stdio: 'inherit' })

const bin = path.join(target, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
if (!fs.existsSync(bin)) throw new Error(`runtime install incomplete: ${bin} missing`)
console.log(`runtime ready: ${bin}`)
