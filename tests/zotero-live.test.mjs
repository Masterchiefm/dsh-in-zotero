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

/** A minimal one-page PDF (with valid xref offsets) carrying known text —
 * lets the live test exercise the real PDFWorker full-text path. */
function buildMinimalPdf(textLine) {
	const enc = (s) => Buffer.from(s, 'latin1')
	const content = `BT /F1 14 Tf 72 720 Td (${textLine}) Tj ET`
	const header = '%PDF-1.4\n'
	const objs = [
		'1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
		'2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
		'3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
		`4 0 obj\n<< /Length ${enc(content).length} >>\nstream\n${content}\nendstream\nendobj\n`,
		'5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
	]
	let body = ''
	const offsets = []
	for (const obj of objs) {
		offsets.push(enc(header + body).length)
		body += obj
	}
	let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
	for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`
	const startx = enc(header + body).length
	const trailer = `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${startx}\n%%EOF\n`
	return enc(header + body + xref + trailer)
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
	const linkAttID = attach.body.attachment?.id

	// --- locate（在文献列表中定位并高亮） ---------------------------------------
	// The library tab is brought forward and the item is selected; the fresh
	// row may still be mid-notify, so this also exercises the poll-then-select
	// path inside the op.
	const locate = await call('locate', { id: itemID })
	check('locate selects the item in the list', locate.body.ok === true
		&& locate.body.found !== false && locate.body.item?.id === itemID, locate.body.error?.message ?? '')

	const locateAtt = await call('locate', { id: linkAttID })
	check('locate attachment resolves to parent item', locateAtt.body.ok === true
		&& locateAtt.body.item?.id === itemID && locateAtt.body.parentID === itemID, locateAtt.body.error?.message ?? '')

	// --- standalone attachment → add with adoptAttachmentIDs -----------------
	// The "PDF dragged into the library with no metadata" flow: import a file
	// as a top-level attachment inside the test collection, then create its
	// parent item, which adopts the attachment and inherits the collection.
	const tmpFile = path.join(os.tmpdir(), `dsh-adopt-selftest-${Date.now()}.txt`)
	fs.writeFileSync(tmpFile, 'dsh-in-zotero standalone adopt selftest\n')
	const standalone = await call('attach', { standalone: true, path: tmpFile, collectionIDs: [collectionID] })
	check('attach standalone file', standalone.body.ok === true, `id ${standalone.body.attachment?.id}`)
	const standaloneID = standalone.body.attachment?.id

	const adopted = await call('add', {
		itemType: 'journalArticle',
		fields: { title: `${marker} — adopted parent`, DOI: '10.0000/dsh-adopt.test' },
		creators: [{ firstName: 'San', lastName: 'Zhang', creatorType: 'author' }],
		adoptAttachmentIDs: [standaloneID],
	})
	check('add adopts standalone attachment', adopted.body.ok === true
		&& (adopted.body.adoptedAttachments ?? []).some(a => a.id === standaloneID), `item id ${adopted.body.item?.id}`)
	const adoptedID = adopted.body.item?.id

	const adoptedDetail = await call('item', { id: adoptedID })
	check('attachment re-parented under the new item', adoptedDetail.body.ok === true
		&& adoptedDetail.body.item.attachments.some(a => a.id === standaloneID))
	check('new item inherited the attachment collection', (adoptedDetail.body.item.collections ?? []).includes(collectionID))
	const standaloneAfter = await call('item', { id: standaloneID })
	check('attachment left its own collections', (standaloneAfter.body.item.collections ?? []).length === 0)

	const reAdopt = await call('add', {
		itemType: 'report',
		fields: { title: `${marker} — should not exist` },
		adoptAttachmentIDs: [standaloneID],
	})
	const junk = await call('search', { query: 'should not exist' })
	check('re-adopt rejected (already parented), no junk item left', reAdopt.body.ok === false
		&& junk.body.items.length === 0, reAdopt.body.error?.message ?? '')

	const adoptedGone = await call('trash', { id: adoptedID, action: 'delete' })
	check('delete adopted item tree', adoptedGone.body.ok === true)
	fs.rmSync(tmpFile, { force: true })

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

	// --- full-text read of a REAL PDF (the PDFWorker path) ---------------------
	// Regression: PDFWorker.getFullText() resolves to { text, pages } — an early
	// version assigned the whole object, so every unindexed PDF blew up as
	// "[zotero/error] text.slice is not a function" / "text.toLowerCase …".
	// The fresh attachment has no .zotero-ft-cache yet, so this walks exactly
	// that path and asserts a string comes back.
	const probeLine = 'dsh fulltext probe 12345'
	const pdfFile = path.join(os.tmpdir(), `dsh-pdf-selftest-${Date.now()}.pdf`)
	fs.writeFileSync(pdfFile, buildMinimalPdf(probeLine))
	const pdfAtt = await call('attach', { standalone: true, path: pdfFile, collectionIDs: [collectionID] })
	check('attach standalone pdf', pdfAtt.body.ok === true, pdfAtt.body.error?.message ?? `id ${pdfAtt.body.attachment?.id}`)
	const pdfAttID = pdfAtt.body.attachment?.id
	if (pdfAtt.body.ok === true && pdfAttID) {
		const pdfRead = await call('read', { id: pdfAttID, maxChars: 4000 })
		check('read extracts PDF text (string, not object)', pdfRead.body.ok === true
			&& typeof pdfRead.body.text === 'string'
			&& pdfRead.body.text.includes(probeLine),
			`source=${pdfRead.body?.source} total=${pdfRead.body?.total} ${pdfRead.body?.error?.message ?? ''}`)
		const pdfSearch = await call('read', { id: pdfAttID, search: 'fulltext probe' })
		check('read search on PDF (toLowerCase path)', pdfSearch.body.ok === true
			&& typeof pdfSearch.body.text === 'string'
			&& pdfSearch.body.text.includes(probeLine), pdfSearch.body?.error?.message ?? '')
		const pdfGone = await call('trash', { id: pdfAttID, action: 'delete' })
		check('delete pdf attachment', pdfGone.body.ok === true)
	}
	fs.rmSync(pdfFile, { force: true })

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
