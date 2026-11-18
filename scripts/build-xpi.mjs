// Packages zotero-plugin/ (plus the dsh-plugin payload it embeds) into
// dsh-in-zotero.xpi. Also cross-checks the bundled file list against the
// sidecar's PLUGIN_FILES manifest so the payload can never drift silently.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PLUGIN = path.join(ROOT, 'zotero-plugin')
const DSH = path.join(ROOT, 'dsh-plugin')
const OUT = path.join(ROOT, 'dsh-in-zotero.xpi')

// The sidecar seeds exactly these dsh-plugin files into its profile; anything
// new under dsh-plugin/ must be added to BOTH lists (this script errors when
// they diverge).
const PAYLOAD = [
	'package.json',
	'cordis.patch.yml',
	'index.js',
	'client.js',
	'src/version.js',
	'src/zoteroClient.js',
	'src/metadata.js',
	'src/prompts.js',
	'src/sessions.js',
	'src/translate.js',
	'src/tools.js',
]

const sidecarSource = fs.readFileSync(path.join(PLUGIN, 'content', 'scripts', 'sidecar.js'), 'utf8')
const manifestMatch = /const PLUGIN_FILES = \[([\s\S]*?)\];/.exec(sidecarSource)
if (!manifestMatch) throw new Error('cannot read PLUGIN_FILES from sidecar.js')
const manifest = [...manifestMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1])
const onDisk = (() => {
	const walk = (dir, prefix = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name
		if (entry.isDirectory()) return walk(path.join(dir, entry.name), rel)
		return [rel]
	})
	return walk(DSH).filter(rel => !rel.startsWith('node_modules'))
})()
const missing = manifest.filter(rel => !onDisk.includes(rel))
const extra = onDisk.filter(rel => !manifest.includes(rel))
if (missing.length || extra.length) {
	throw new Error([
		'PLUGIN_FILES and dsh-plugin/ contents diverge:',
		...(missing.length ? [`  missing from dsh-plugin/: ${missing.join(', ')}`] : []),
		...(extra.length ? [`  not in PLUGIN_FILES: ${extra.join(', ')}`] : []),
	].join('\n'))
}

// Copy the dsh-plugin payload into zotero-plugin/dsh-plugin/ (excluded from
// chrome registration; fetched by the sidecar via rootURI at runtime).
const target = path.join(PLUGIN, 'dsh-plugin')
fs.rmSync(target, { recursive: true, force: true })
for (const rel of PAYLOAD) {
	const dest = path.join(target, rel)
	fs.mkdirSync(path.dirname(dest), { recursive: true })
	fs.copyFileSync(path.join(DSH, rel), dest)
}

// Zip the plugin directory with a tiny dependency-free zip writer (stored +
// deflate entries, forward-slash names, UTF-8 flags) — PowerShell's
// Compress-Archive writes backslash entry names on some systems, which
// Zotero's reader rejects.
fs.rmSync(OUT, { force: true })

const CRC_TABLE = (() => {
	const table = new Uint32Array(256)
	for (let n = 0; n < 256; n++) {
		let c = n
		for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
		table[n] = c >>> 0
	}
	return table
})()

function crc32(buffer) {
	let crc = 0xFFFFFFFF
	for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8)
	return (crc ^ 0xFFFFFFFF) >>> 0
}

/** Write a zip archive from [name, contents] pairs (deflate when smaller). */
function writeZip(outputPath, entries) {
	const chunks = []
	const central = []
	let offset = 0
	const push = (buffer) => {
		chunks.push(buffer)
		offset += buffer.length
	}
	for (const [name, contents] of entries) {
		const nameBytes = Buffer.from(name, 'utf8')
		const data = Buffer.from(contents)
		const crc = crc32(data)
		let method = 0
		let payload = data
		try {
			const { deflateRawSync } = zlib
			const deflated = deflateRawSync(data, { level: 9 })
			if (deflated.length < data.length) {
				method = 8
				payload = deflated
			}
		}
		catch { /* stored entry */ }
		const local = Buffer.alloc(30)
		local.writeUInt32LE(0x04034b50, 0)
		local.writeUInt16LE(20, 4) // version needed
		local.writeUInt16LE(0x0800, 6) // UTF-8 names
		local.writeUInt16LE(method, 8)
		local.writeUInt16LE(0, 10) // time
		local.writeUInt16LE(0, 12) // date
		local.writeUInt32LE(crc, 14)
		local.writeUInt32LE(payload.length, 18)
		local.writeUInt32LE(data.length, 22)
		local.writeUInt16LE(nameBytes.length, 26)
		local.writeUInt16LE(0, 28)
		const entryOffset = offset
		push(local)
		push(nameBytes)
		push(payload)
		const dir = Buffer.alloc(46)
		dir.writeUInt32LE(0x02014b50, 0)
		dir.writeUInt16LE(20, 4)
		dir.writeUInt16LE(20, 6)
		dir.writeUInt16LE(0x0800, 8)
		dir.writeUInt16LE(method, 10)
		dir.writeUInt16LE(0, 12)
		dir.writeUInt16LE(0, 14)
		dir.writeUInt32LE(crc, 16)
		dir.writeUInt32LE(payload.length, 20)
		dir.writeUInt32LE(data.length, 24)
		dir.writeUInt16LE(nameBytes.length, 28)
		dir.writeUInt16LE(0, 30)
		dir.writeUInt16LE(0, 32)
		dir.writeUInt16LE(0, 34)
		dir.writeUInt16LE(0, 36)
		dir.writeUInt32LE(0, 38)
		dir.writeUInt32LE(entryOffset, 42)
		central.push(Buffer.concat([dir, nameBytes]))
	}
	const centralStart = offset
	for (const dir of central) push(dir)
	const end = Buffer.alloc(22)
	end.writeUInt32LE(0x06054b50, 0)
	end.writeUInt16LE(0, 4)
	end.writeUInt16LE(0, 6)
	end.writeUInt16LE(central.length, 8)
	end.writeUInt16LE(central.length, 10)
	end.writeUInt32LE(offset - centralStart, 12)
	end.writeUInt32LE(centralStart, 16)
	end.writeUInt16LE(0, 20)
	push(end)
	fs.writeFileSync(outputPath, Buffer.concat(chunks))
}

const entries = []
const walk = (dir, prefix = '') => {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name
		if (entry.isDirectory()) walk(path.join(dir, entry.name), rel)
		else entries.push([rel, fs.readFileSync(path.join(dir, entry.name))])
	}
}
walk(PLUGIN)
writeZip(OUT, entries)
console.log(`built ${OUT} (${fs.statSync(OUT).size} bytes, ${entries.length} files)`)
