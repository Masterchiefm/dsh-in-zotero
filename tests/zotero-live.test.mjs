// LIVE Zotero test — exercises the real /dsh-bridge/* endpoints implemented by
// the plugin inside a RUNNING Zotero. Creates disposable test items in a test
// collection, runs the full CRUD cycle through the bridge, then cleans up.
//
// Prereq: dsh-in-zotero.xpi installed, Zotero running, and the plugin started
// (its startup writes <profile>/dsh-in-zotero/bridge-token).
//
// Usage: node tests/zotero-live.test.mjs [--port 23119]

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const argv = new Map()
for (let i = 2; i < process.argv.length; i++) {
	if (process.argv[i].startsWith('--')) argv.set(process.argv[i].slice(2), process.argv[i + 1])
}

let failed = 0
const check = (name, condition, detail = '') => {
	const mark = condition ? 'PASS' : 'FAIL'
	if (!condition) failed += 1
	console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function findZoteroProfile() {
	// Windows-first, then generic.
	const candidates = []
	if (process.platform === 'win32') {
		const appData = process.env.APPDATA
		if (appData) candidates.push(path.join(appData, 'Zotero', 'Zotero', 'Profiles'))
	}
	candidates.push(path.join(process.env.HOME ?? '', '.zotero', 'zotero', 'Profiles'))
	for (const dir of candidates) {
		if (!fs.existsSync(dir)) continue
		for (const entry of fs.readdirSync(dir)) {
			const profile = path.join(dir, entry)
			if (!fs.existsSync(path.join(profile, 'prefs.js'))) continue
			return profile
		}
	}
	return null
}

async function main() {
	const port = Number(argv.get('port') ?? 23119)
	const base = `http://127.0.0.1:${port}/dsh-bridge/`
	const profile = findZoteroProfile()
	check('Zotero profile found', profile !== null, profile ?? '')
	if (!profile) process.exit(2)

	const tokenFile = path.join(profile, 'dsh-in-zotero', 'bridge-token')
	if (!fs.existsSync(tokenFile)) {
		console.error(`bridge token file missing (${tokenFile}) — start Zotero with the plugin once`)
		process.exit(2)
	}
	const token = fs.readFileSync(tokenFile, 'utf8').trim()

	const call = async (op, payload) => {
		const response = await fetch(base + op, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-dsh-in-zotero-token': token },
			body: JSON.stringify(payload ?? {}),
			signal: AbortSignal.timeout(90_000),
		})
		return { status: response.status, body: await response.json().catch(() => null) }
	}

	const badToken = await fetch(base + 'status', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-dsh-in-zotero-token': 'wrong' },
		body: '{}',
	})
	check('bad token rejected (403)', badToken.status === 403)

	const status = await call('status')
	check('status', status.status === 200 && status.body.ok === true, `${status.body.items} items / ${status.body.collections} collections / Zotero ${status.body.zoteroVersion}`)

	const types = await call('itemtypes')
	check('itemtypes', types.body.ok === true && types.body.itemTypes.some(t => t.itemType === 'journalArticle'), `${types.body.itemTypes?.length} types`)

	// --- disposable test data -------------------------------------------------
	const marker = `dsh-in-zotero 自检 ${Date.now()}`
	const collection = await call('collection', { action: 'create', name: marker })
	check('collection create', collection.body.ok === true, `id ${collection.body.collection?.id}`)
	const collectionID = collection.body.collection.id

	const added = await call('add', {
		itemType: 'journalArticle',
		fields: { title: `${marker} — bridge test`, DOI: '10.0000/dsh-in-zotero.test' },
		creators: [{ firstName: 'San', lastName: 'Zhang', creatorType: 'author' }],
		tags: ['dsh-自检'],
		collectionIDs: [collectionID],
	})
	check('item add', added.body.ok === true, `id ${added.body.item?.id}`)
	const itemID = added.body.item.id

	const search = await call('search', { query: marker })
	check('search finds it', search.body.ok === true && search.body.items.some(i => i.id === itemID))

	const item = await call('item', { id: itemID })
	check('item detail', item.body.ok === true && item.body.item.fields.DOI === '10.0000/dsh-in-zotero.test')

	const collections = await call('collections')
	check('collections lists the test collection', collections.body.ok === true
		&& collections.body.collections.some(c => c.id === collectionID))

	const note = await call('note', { parentID: itemID, text: 'bridge 自检笔记' })
	check('note create', note.body.ok === true)

	const attach = await call('attach', { id: itemID, url: 'https://example.com/dsh-in-zotero-test', title: '自检链接' })
	check('attach linked URL', attach.body.ok === true)

	const update = await call('update', {
		id: itemID,
		itemType: 'preprint',
		fields: { shortTitle: '桥接自检', abstractNote: null },
		tags: ['dsh-自检', 'updated'],
		addCollections: [],
		removeCollections: [],
	})
	check('update (type change + fields + tags)', update.body.ok === true && update.body.item.itemType === 'preprint')

	const reread = await call('item', { id: itemID })
	check('update persisted', reread.body.item.itemType === 'preprint'
		&& reread.body.item.fields.shortTitle === '桥接自检'
		&& reread.body.item.tags.includes('updated'), '')

	const readAny = await call('read', { id: itemID })
	check('read on item without file attachment → graceful', readAny.status === 400 || readAny.body.ok === false
		|| readAny.body.kind !== undefined, readAny.body.error?.message ?? readAny.body.kind ?? '')

	const annotations = await call('annotations', { id: itemID })
	check('annotations (empty ok)', annotations.body.ok === true)

	const trashed = await call('trash', { id: itemID, action: 'trash' })
	check('trash item', trashed.body.ok === true)

	const trashedCollection = await call('collection', { action: 'trash', id: collectionID })
	check('trash collection', trashedCollection.body.ok === true)

	const restored = await call('trash', { id: itemID, action: 'restore' })
	check('restore item', restored.body.ok === true)

	const deleted = await call('trash', { id: itemID, action: 'delete' })
	check('delete item permanently', deleted.body.ok === true)

	const missing = await call('item', { id: itemID })
	check('deleted item is gone', missing.status === 404)

	if (failed > 0) {
		console.error(`\n${failed} check(s) FAILED`)
		process.exit(1)
	}
	console.log('\nall live Zotero bridge checks passed')
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
