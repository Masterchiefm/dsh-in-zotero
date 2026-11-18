// Sidecar integration test (offline plumbing — no LLM needed):
//
//   1. seeds a throwaway DSH_HOME with a profile whose node_modules carries a
//      physical copy of the dsh-in-zotero-bridge plugin (exactly what the
//      Zotero plugin's seedProfile does),
//   2. starts the mock Zotero bridge,
//   3. boots `dsh web --port 0 --no-open` as a child process,
//   4. verifies: stdout URL line → /connect cookie exchange → JSON-RPC
//      session.list → the bridge plugin's /api/zotero routes → direct
//      execution of the zotero_* tools against the mock → the translate
//      route's no-model error path.
//
// Usage: node tests/sidecar.test.mjs [--runtime <dir>]

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startMockZotero } from './mock-zotero.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const args = new Map(process.argv.slice(2).map((value, index, all) => (value.startsWith('--') ? [value.slice(2), all[index + 1]] : [])).filter(Boolean))
const RUNTIME = args.get('runtime') ?? path.join(ROOT, '.dsh-runtime')
const DSH_BIN = path.join(RUNTIME, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

let failed = 0
const check = (name, condition, detail = '') => {
	const mark = condition ? 'PASS' : 'FAIL'
	if (!condition) failed += 1
	console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
	// --- preflight ------------------------------------------------------------
	if (!fs.existsSync(DSH_BIN)) {
		console.error(`dsh runtime missing at ${DSH_BIN} — run: node scripts/install-runtime.mjs`)
		process.exit(2)
	}

	// --- seed a throwaway dsh home --------------------------------------------
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-in-zotero-test-'))
	const profileName = 'zotero-test'
	const profileDir = path.join(home, 'profiles', profileName)
	const bridgeDir = path.join(profileDir, 'node_modules', 'dsh-in-zotero-bridge')
	for (const rel of ['package.json', 'cordis.patch.yml', 'index.js', 'client.js', 'src/version.js', 'src/zoteroClient.js', 'src/metadata.js', 'src/prompts.js', 'src/sessions.js', 'src/translate.js', 'src/tools.js']) {
		fs.mkdirSync(path.dirname(path.join(bridgeDir, rel)), { recursive: true })
		fs.copyFileSync(path.join(ROOT, 'dsh-plugin', rel), path.join(bridgeDir, rel))
	}
	fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
		name: `dsh-profile-${profileName}`,
		private: true,
		dependencies: { 'dsh-in-zotero-bridge': '0.2.0' },
		dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-in-zotero-bridge'] } },
	}, null, 2))
	fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[]\n')
	fs.writeFileSync(path.join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
	console.log(`test home: ${home}`)

	// --- mock Zotero bridge -----------------------------------------------------
	const mock = await startMockZotero({ token: 'integration-token' })

	// --- boot the sidecar -------------------------------------------------------
	const child = spawn(process.execPath, [DSH_BIN, '--profile', profileName, '--no-open', '--port', '0'], {
		env: {
			...process.env,
			DSH_HOME: home,
			DSH_ZOTERO_PORT: String(mock.port),
			DSH_ZOTERO_TOKEN: mock.token,
			DSH_IN_ZOTERO: '1',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	let output = ''
	let stderr = ''
	child.stdout.on('data', chunk => { output += chunk })
	child.stderr.on('data', chunk => { stderr += chunk })
	const urlLine = await new Promise((resolve, reject) => {
		const started = Date.now()
		const poll = setInterval(() => {
			const match = /dsh web: (\S+)/.exec(output)
			if (match) {
				clearInterval(poll)
				resolve(match[1])
			}
			else if (Date.now() - started > 120000) {
				clearInterval(poll)
				reject(new Error(`sidecar did not report its URL in 120s\nstdout:\n${output.slice(-2000)}\nstderr:\n${stderr.slice(-2000)}`))
			}
			else if (child.exitCode !== null) {
				clearInterval(poll)
				reject(new Error(`sidecar exited early (${child.exitCode})\nstdout:\n${output.slice(-2000)}\nstderr:\n${stderr.slice(-2000)}`))
			}
		}, 200)
	})
	check('sidecar boots and prints the authenticated URL', /^https?:\/\/127\.0\.0\.1:\d+\/\?token=/.test(urlLine), urlLine.slice(0, 60) + '…')

	const base = new URL(urlLine).origin
	const token = new URL(urlLine).searchParams.get('token')

	// --- /connect cookie exchange ------------------------------------------------
	const connect = await fetch(`${base}/connect?token=${encodeURIComponent(token)}&interactions=none`, { redirect: 'manual' })
	const cookies = (connect.headers.getSetCookie?.() ?? []).map(line => line.split(';')[0]).join('; ')
	check('/connect exchange yields an API cookie', cookies.length > 0, connect.status + ' ' + cookies.slice(0, 40))
	const api = async (path, body) => {
		const response = await fetch(`${base}${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...(cookies ? { cookie: cookies } : {}) },
			body: JSON.stringify(body ?? {}),
		})
		return response
	}

	// (The gateway's unary POST /api/<method> channel is not mounted by the
	// web-app bundle in 0.2.2-rc - the browser talks over the WS mux instead.
	// Zotero chrome only ever uses the bridge plugin's own route below.)

	// --- the bridge plugin's routes ---------------------------------------------
	const statusResponse = await api('/api/zotero/rpc', { op: 'status', payload: {} })
	const status = await statusResponse.json()
	check('plugin route status', status.ok === true && typeof status.version === 'string', `v${status.version}`)

	const createResponse = await api('/api/zotero/rpc', { op: 'session.create', payload: { title: '测试会话' } })
	const created = await createResponse.json()
	check('plugin route session.create', created.ok === true && typeof created.sessionId === 'string' && created.sessionId.length > 0, created.sessionId?.slice(0, 12))

	const resolveResponse = await api('/api/zotero/rpc', { op: 'session.resolve', payload: { sessionId: created.sessionId } })
	const resolved = await resolveResponse.json()
	check('plugin route session.resolve (alive)', resolved.ok === true && resolved.alive === true)

	const listResponse = await api('/api/zotero/rpc', { op: 'session.list', payload: {} })
	const listed = await listResponse.json()
	check('plugin route session.list includes the new session', listed.ok === true
		&& listed.items.some(row => row.sessionId === created.sessionId), `${listed.items?.length ?? 0} sessions`)

	const unknownResponse = await api('/api/zotero/rpc', { op: 'nope', payload: {} })
	const unknown = await unknownResponse.json()
	check('plugin route unknown op → structured error', unknown.ok === false && unknown.error?.code === 'zotero/unknown-op')

	// --- direct tool execution against the mock bridge ---------------------------
	// (These run in THIS process; the tools only need the env vars.)
	process.env.DSH_ZOTERO_PORT = String(mock.port)
	process.env.DSH_ZOTERO_TOKEN = mock.token
	const tools = await import(pathToFileURL(path.join(bridgeDir, 'src', 'tools.js')).href)
	const defs = tools.createTools({ logger: { info() {}, warn() {} } })
	const byName = new Map(defs.map(def => [def.name, def]))

	const statusTool = await byName.get('zotero_status').execute({})
	check('tool zotero_status', statusTool.ok === true && statusTool.zoteroVersion === '10.0.8-test')

	const searchTool = await byName.get('zotero_search').execute({ query: 'Cas12i' })
	check('tool zotero_search', searchTool.ok === true && searchTool.items.length === 1, searchTool.items?.[0]?.title?.slice(0, 40))

	const itemTool = await byName.get('zotero_item').execute({ id: 101 })
	check('tool zotero_item', itemTool.ok === true && itemTool.item.attachments[0].path.includes('C:/fake/storage'))

	const readTool = await byName.get('zotero_read').execute({ id: 101, search: 'seed sequence' })
	check('tool zotero_read (search)', readTool.ok === true && readTool.matches === 1)

	const collectionsTool = await byName.get('zotero_collections').execute({})
	check('tool zotero_collections', collectionsTool.ok === true && collectionsTool.collections.length === 2)

	const updateTool = await byName.get('zotero_update').execute({
		id: 102,
		itemType: 'journalArticle',
		fields: { shortTitle: 'IscB结构与ωRNA', abstractNote: null },
		addCollections: [2],
	})
	check('tool zotero_update (type change + collections)', updateTool.ok === true)
	const recorded = mock.updates().at(-1)
	check('mock bridge recorded the update', recorded?.itemType === 'journalArticle' && recorded?.addCollections?.[0] === 2)

	let threw = null
	try {
		await byName.get('zotero_item').execute({ id: 424242 })
	}
	catch (error) {
		threw = error
	}
	check('tool zotero_item missing id → coded error', threw !== null && /no-item/.test(threw.message), threw?.message?.slice(0, 60))

	const lookupTool = await byName.get('zotero_lookup').execute({ identifier: '10.1038/nature15714' })
	check('tool zotero_lookup resolves a real DOI (online)', lookupTool.ok === true && lookupTool.found === true
		&& lookupTool.draft?.fields?.title?.length > 0, lookupTool.draft?.fields?.title?.slice(0, 50))

	// Draft path: a real DOI (fed via the text param — item 103 has none of its
	// own) resolves online into an authoritative draft with a numeric titleMatch.
	const identifyDraft = await byName.get('zotero_identify').execute({ id: 103, text: 'doi:10.1038/nature15714' })
	check('tool zotero_identify (identifier → authoritative draft)', identifyDraft.ok === true && identifyDraft.found === true
		&& identifyDraft.draft?.fields?.title?.length > 0 && typeof identifyDraft.draft?.titleMatch === 'number',
	`${identifyDraft.draft?.fields?.title?.slice(0, 50)} match=${identifyDraft.draft?.titleMatch}`)

	// Fallback path: item 101's fixture DOI is fabricated (unresolvable online),
	// so the tool must fall back to a structured title-search candidate list.
	const identifyFallback = await byName.get('zotero_identify').execute({ id: 101 })
	check('tool zotero_identify unresolvable-DOI fallback stays structured', identifyFallback.ok === true
		&& Array.isArray(identifyFallback.candidates) && typeof identifyFallback.current?.title === 'string',
	`found=${identifyFallback.found} candidates=${identifyFallback.candidates?.length}`)

	// --- translate route error path (no credentials in the temp home): the call
	// starts streaming, then fails inside the stream as an NDJSON error event —
	// exactly what the Zotero popup renders.
	const translateResponse = await api('/api/zotero/translate', { text: 'hello world', thinking: false })
	const translateText = await translateResponse.text()
	const translateEvents = translateText.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
	check('translate route streams a structured error without credentials', translateEvents.some(evt => evt.type === 'error'
		&& /API key|模型|no-model|no-llm/i.test(evt.message ?? '')), (translateEvents.find(evt => evt.type === 'error')?.message ?? '').slice(0, 70))

	// --- cleanup ------------------------------------------------------------------
	child.kill()
	await new Promise(resolve => child.on('exit', resolve))
	await mock.stop()
	fs.rmSync(home, { recursive: true, force: true })

	if (failed > 0) {
		console.error(`\n${failed} check(s) FAILED`)
		process.exit(1)
	}
	console.log('\nall sidecar checks passed')
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
