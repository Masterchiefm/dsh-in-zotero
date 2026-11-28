// Syntax-check every JS file in the repo (ESM for dsh-plugin/, script-scope
// for the Zotero plugin's chrome modules) without executing anything.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const groups = [
	{ label: 'dsh-plugin (ESM)', dir: path.join(ROOT, 'dsh-plugin'), esm: true },
	{ label: 'zotero-plugin (chrome scripts)', dir: path.join(ROOT, 'zotero-plugin'), esm: false },
	{ label: 'scripts+tests (ESM)', esm: true, files: [
		path.join(ROOT, 'scripts', 'build-xpi.mjs'),
		path.join(ROOT, 'scripts', 'install-runtime.mjs'),
		path.join(ROOT, 'scripts', 'check.mjs'),
		path.join(ROOT, 'tests', 'wps.test.mjs'),
	] },
]

const walk = (dir, prefix = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
	const full = path.join(dir, entry.name)
	const rel = prefix ? `${prefix}/${entry.name}` : entry.name
	if (entry.isDirectory()) {
		if (entry.name === 'node_modules' || entry.name === 'dsh-plugin') return []
		return walk(full, rel)
	}
	return /\.js$/.test(entry.name) ? [full] : []
})

let failed = 0
for (const group of groups) {
	const files = group.files ?? walk(group.dir)
	for (const file of files) {
		const isMjs = file.endsWith('.mjs')
		try {
			if (group.esm || isMjs) {
				execFileSync(process.execPath, ['--input-type=module', '--check'], {
					input: fs.readFileSync(file, 'utf8'),
					stdio: ['pipe', 'pipe', 'pipe'],
				})
			}
			else {
				// Zotero chrome scripts share one sandbox: strip nothing, but they
				// must parse as classic scripts with DSH/ctx/Zotero pre-declared —
				// plain script-goal parse is enough.
				execFileSync(process.execPath, ['--check', file], { stdio: ['pipe', 'pipe', 'pipe'] })
			}
			console.log(`ok       ${path.relative(ROOT, file)}`)
		}
		catch (error) {
			failed += 1
			console.error(`FAIL     ${path.relative(ROOT, file)}\n${String(error.stderr)}`)
		}
	}
}
if (failed > 0) {
	console.error(`\n${failed} file(s) failed`)
	process.exit(1)
}
console.log('\nall files parse cleanly')
