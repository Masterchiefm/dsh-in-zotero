// A mock of the Zotero-side bridge (the /dsh-bridge/* endpoints implemented by
// zotero-plugin/content/scripts/bridge.js) for testing the dsh plugin without
// a running Zotero. Keeps an in-memory fixture library and records every call.

import http from 'node:http'

const LIBRARY = [
	{
		id: 101, key: 'AAAAAAAA', itemType: 'journalArticle', title: 'CRISPR-Cas12i structure reveals RNA-guided DNA cleavage',
		creator: 'Zhang, Bin', year: '2020', hasAttachment: true,
	},
	{
		id: 102, key: 'BBBBBBBB', itemType: 'preprint', title: 'Structure of the IscB–ωRNA complex',
		creator: 'Kato, Kai', year: '2022', hasAttachment: true,
	},
	{
		id: 103, key: 'CCCCCCCC', itemType: 'book', title: 'Molecular Biology of the Cell',
		creator: 'Alberts, Bruce', year: '2017', hasAttachment: false,
	},
]

const COLLECTIONS = [
	{ id: 1, key: 'COLL0001', name: '基因编辑', parentID: null, subcollections: 1, items: 2 },
	{ id: 2, key: 'COLL0002', name: 'Cas12i', parentID: 1, subcollections: 0, items: 1 },
]

const FULLTEXT = 'CRISPR-Cas12i is a Class 2 type V-B effector. The structure reveals a bilobed architecture with a recognition (REC) lobe and a nuclease (NUC) lobe. The seed sequence of the crRNA interacts with the target DNA strand. Picosecond dynamics were measured at 298 K.'

export function startMockZotero({ port = 0, token = 'test-token' } = {}) {
	const calls = []
	const updates = []
	const server = http.createServer((req, res) => {
		const send = (status, body) => {
			res.writeHead(status, { 'content-type': 'application/json' })
			res.end(JSON.stringify(body))
		}
		if (!req.url.startsWith('/dsh-bridge/')) return send(404, { ok: false, error: { code: 'nope', message: 'not found' } })
		const op = req.url.slice('/dsh-bridge/'.length).split('?')[0]
		if (req.headers['x-dsh-in-zotero-token'] !== token) {
			return send(403, { ok: false, error: { code: 'zotero/bad-token', message: 'invalid bridge token' } })
		}
		let raw = ''
		req.on('data', chunk => { raw += chunk })
		req.on('end', () => {
			let payload = {}
			try { payload = JSON.parse(raw || '{}') } catch { payload = {} }
			calls.push({ op, payload })
			switch (op) {
				case 'status':
					return send(200, { ok: true, zoteroVersion: '10.0.8-test', serverPort: 23119, items: LIBRARY.length, collections: COLLECTIONS.length })
				case 'search': {
					const q = String(payload.query ?? '').toLowerCase()
					const rows = LIBRARY.filter(item => !q || item.title.toLowerCase().includes(q) || item.creator.toLowerCase().includes(q))
					return send(200, { ok: true, items: rows, hint: '' })
				}
				case 'item': {
					const found = LIBRARY.find(item => item.id === Number(payload.id))
					if (!found) return send(404, { ok: false, error: { code: 'zotero/no-item', message: `找不到条目 id ${payload.id}` } })
					return send(200, {
						ok: true,
						item: {
							...found,
							creators: [{ creatorType: 'author', firstName: found.creator.split(', ')[1] ?? '', lastName: found.creator.split(', ')[0], fieldMode: 0 }],
							fields: { title: found.title, DOI: found.id === 101 ? '10.1038/s41594-020-00503-0' : '' },
							tags: ['structure'],
							collections: found.id === 101 ? [1] : [],
							parentID: null,
							attachments: found.hasAttachment
								? [{ id: found.id + 1000, key: 'ATT' + found.id, title: found.title + '.pdf', contentType: 'application/pdf', linkMode: 0, linkModeName: 'importedFile', path: `C:/fake/storage/${found.key}/${found.title}.pdf`, url: '' }]
								: [],
							notes: [],
							bestAttachmentID: found.hasAttachment ? found.id + 1000 : null,
						},
					})
				}
				case 'collections':
					return send(200, { ok: true, collections: COLLECTIONS })
				case 'read': {
					const found = LIBRARY.find(item => item.id === Number(payload.id)) ?? LIBRARY.find(item => item.id === Number(payload.id) - 1000)
					if (!found) return send(404, { ok: false, error: { code: 'zotero/no-item', message: 'not found' } })
					if (payload.search) {
						const lower = FULLTEXT.toLowerCase()
						const needle = String(payload.search).toLowerCase()
						const index = lower.indexOf(needle)
						return send(200, {
							ok: true, kind: 'text', path: `C:/fake/storage/${found.key}/${found.title}.pdf`, source: 'pdf-worker',
							total: FULLTEXT.length, matches: index >= 0 ? 1 : 0,
							text: index >= 0 ? `…${FULLTEXT.slice(Math.max(0, index - 50), index + needle.length + 100)}…` : '(未找到匹配)',
						})
					}
					return send(200, {
						ok: true, kind: 'text', path: `C:/fake/storage/${found.key}/${found.title}.pdf`, source: 'pdf-worker',
						total: FULLTEXT.length, offset: 0, nextOffset: null, text: FULLTEXT,
					})
				}
				case 'update': {
					const found = LIBRARY.find(item => item.id === Number(payload.id))
					if (!found) return send(404, { ok: false, error: { code: 'zotero/no-item', message: 'not found' } })
					updates.push(payload)
					if (payload.itemType) found.itemType = payload.itemType
					if (payload.fields?.title) found.title = String(payload.fields.title)
					return send(200, { ok: true, item: found })
				}
				case 'add':
					return send(200, { ok: true, item: { id: 999, key: 'NEWITEM1', itemType: payload.itemType, title: payload.fields?.title ?? '', creator: '', year: '', hasAttachment: false } })
				case 'attach':
					return send(200, { ok: true, attachment: { id: 888, key: 'NEWATT1', title: payload.path ?? payload.url ?? '', contentType: 'application/pdf', linkMode: 0, path: payload.path ?? null, url: payload.url ?? '' } })
				case 'collection':
					return send(200, { ok: true, collection: { id: 7, key: 'NEWCOLL1', name: payload.name ?? '新分类' } })
				case 'trash':
					return send(200, { ok: true, trashed: payload.action !== 'restore' })
				case 'note':
					return send(200, { ok: true, noteID: 777 })
				case 'itemtypes':
					return send(200, { ok: true, itemTypes: [
						{ itemType: 'journalArticle', fields: ['title', 'publicationTitle', 'DOI', 'abstractNote', 'shortTitle'], creatorTypes: ['author', 'editor'] },
						{ itemType: 'preprint', fields: ['title', 'repository', 'DOI', 'abstractNote'], creatorTypes: ['author'] },
					] })
				case 'open':
					return send(200, { ok: true, opened: 'C:/fake/x.pdf' })
				default:
					return send(400, { ok: false, error: { code: 'zotero/unknown-op', message: `unknown op ${op}` } })
			}
		})
	})
	return new Promise((resolve) => {
		server.listen(port, '127.0.0.1', () => {
			resolve({
				server,
				port: server.address().port,
				token,
				calls: () => calls,
				updates: () => updates,
				stop: () => new Promise(done => server.close(done)),
			})
		})
	})
}
