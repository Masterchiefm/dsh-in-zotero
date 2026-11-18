// LIVE sidecar test — real model, real credentials, real streaming.
//
// Boots the sidecar against the user's real dsh home (~/.dsh — credentials and
// model selection are shared, which is the plugin's production behaviour) under
// its own profile, then:
//   1. creates a session in the Zotero workspace,
//   2. prompts the agent to CALL zotero_status (mock Zotero bridge answers),
//   3. waits for the turn to end and verifies the tool call + result landed in
//      the transcript,
//   4. streams one real translation over /api/zotero/translate and checks
//      thinking/answer NDJSON events arrive.
//
// Requires: a configured model (dsh web UI → model selection) and network.
// Usage: node tests/sidecar-live.test.mjs [--home <dshHome>] [--timeout 240]

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockZotero } from './mock-zotero.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const argv = new Map()
for (let i = 2; i < process.argv.length; i++) {
	if (process.argv[i].startsWith('--')) argv.set(process.argv[i].slice(2), process.argv[i + 1])
}
const RUNTIME = argv.get('runtime') ?? path.join(ROOT, '.dsh-runtime')
const HOME = argv.get('home') ?? path.join(process.env.USERPROFILE ?? process.env.HOME, '.dsh')
const PROFILE = argv.get('profile') ?? 'dsh-in-zotero'
const TURN_TIMEOUT = Number(argv.get('timeout') ?? 240000)
const DSH_BIN = path.join(RUNTIME, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

let failed = 0
const check = (name, condition, detail = '') => {
	const mark = condition ? 'PASS' : 'FAIL'
	if (!condition) failed += 1
	console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
	if (!fs.existsSync(DSH_BIN)) {
		console.error(`dsh runtime missing at ${DSH_BIN}`)
		process.exit(2)
	}
	if (!fs.existsSync(path.join(HOME, '.credentials.yaml'))) {
		console.error(`no credentials at ${path.join(HOME, '.credentials.yaml')} — configure a model in dsh first`)
		process.exit(2)
	}

	// Seed the profile exactly like the Zotero plugin does (the profile may
	// already exist from the plugin's own runs — refresh the plugin payload).
	const profileDir = path.join(HOME, 'profiles', PROFILE)
	const bridgeDir = path.join(profileDir, 'node_modules', 'dsh-in-zotero-bridge')
	for (const rel of ['package.json', 'cordis.patch.yml', 'index.js', 'client.js', 'src/version.js', 'src/zoteroClient.js', 'src/metadata.js', 'src/prompts.js', 'src/sessions.js', 'src/translate.js', 'src/tools.js']) {
		fs.mkdirSync(path.dirname(path.join(bridgeDir, rel)), { recursive: true })
		fs.copyFileSync(path.join(ROOT, 'dsh-plugin', rel), path.join(bridgeDir, rel))
	}
	if (!fs.existsSync(path.join(profileDir, 'package.json'))) {
		fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
			name: `dsh-profile-${PROFILE}`,
			private: true,
			dependencies: { 'dsh-in-zotero-bridge': '0.2.0' },
			dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-in-zotero-bridge'] } },
		}, null, 2))
		fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[]\n')
		fs.writeFileSync(path.join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
	}
	console.log(`home: ${HOME}\nprofile: ${PROFILE}`)

	const mock = await startMockZotero({ token: 'live-token' })

	const child = spawn(process.execPath, [DSH_BIN, '--profile', PROFILE, '--no-open', '--port', '0'], {
		env: {
			...process.env,
			DSH_HOME: HOME,
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
			else if (Date.now() - started > 180000 || child.exitCode !== null) {
				clearInterval(poll)
				reject(new Error(`sidecar failed to start\nstdout:\n${output.slice(-1500)}\nstderr:\n${stderr.slice(-1500)}`))
			}
		}, 200)
	})
	check('sidecar boots (real home)', /^https?:\/\/127\.0\.0\.1:\d+\/\?token=/.test(urlLine))

	const base = new URL(urlLine).origin
	const token = new URL(urlLine).searchParams.get('token')
	const connect = await fetch(`${base}/connect?token=${encodeURIComponent(token)}&interactions=none`, { redirect: 'manual' })
	const cookies = (connect.headers.getSetCookie?.() ?? []).map(line => line.split(';')[0]).join('; ')
	check('API cookie exchange', cookies.length > 0)

	const api = async (path, body) => (await fetch(`${base}${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie: cookies },
		body: JSON.stringify(body ?? {}),
	})).json()

	// Create a session via the bridge plugin and prompt it to use the tools.
	const created = await api('/api/zotero/rpc', { op: 'session.create', payload: { title: '集成测试：工具调用' } })
	check('session.create on real home', created.ok === true, created.sessionId?.slice(0, 12))

	const refetch = await api('/api/zotero/rpc', {
		op: 'task.refetch',
		payload: { items: [{ id: 101, key: 'AAAAAAAA', title: 'CRISPR-Cas12i structure reveals RNA-guided DNA cleavage', itemType: 'journalArticle', doi: '', attachmentID: 1101 }] },
	})
	check('task.refetch dispatches to the assistant session', refetch.ok === true, refetch.sessionId?.slice(0, 12))

	// Poll session.page until the turn finishes (assistant text present and the
	// log stops growing) or the deadline hits.
	const pageViaRpc = async () => {
		const response = await fetch(`${base}/api/session.page`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: cookies },
			body: JSON.stringify({
				rpcId: 'page-' + Math.random().toString(36).slice(2),
				method: 'session.page',
				payload: { address: { kind: 'session', sessionId: refetch.sessionId }, maxMessages: 300 },
			}),
		})
		const envelope = await response.json().catch(() => null)
		return envelope?.result?.ok === true ? envelope.result.value : null
	}
	let transcript = null
	const deadline = Date.now() + TURN_TIMEOUT
	let lastCount = -1
	let stableSince = 0
	while (Date.now() < deadline) {
		await delay(3000)
		transcript = await pageViaRpc()
		const events = transcript?.records ?? []
		const hasAnswer = events.some(record => record?.event?.type === 'assistant/message'
			&& String(record.event.data?.message?.content?.[0]?.text ?? '').length > 0)
		if (events.length === lastCount && hasAnswer) {
			stableSince += 3000
			if (stableSince >= 6000) break
		}
		else {
			stableSince = 0
		}
		lastCount = events.length
	}
	check('turn produced a transcript', transcript !== null, `${transcript?.records?.length ?? 0} records`)
	const events = transcript?.records ?? []
	const toolCalls = events.filter(record => record?.event?.type === 'tool/call').map(record => record.event.data?.name)
	const toolResults = events.filter(record => record?.event?.type === 'tool/result')
	const assistantText = events
		.filter(record => record?.event?.type === 'assistant/message')
		.map(record => String(record.event.data?.message?.content?.[0]?.text ?? ''))
		.join(' ')
	check('agent called zotero_* tools', toolCalls.some(name => String(name).startsWith('zotero_')), JSON.stringify(toolCalls.slice(0, 8)))
	check('tool calls succeeded (at least one result)', toolResults.length > 0, `${toolResults.length} results`)
	check('agent produced an answer', assistantText.length > 20, assistantText.slice(0, 80))
	check('mock Zotero saw bridge traffic', mock.calls().some(call => call.op === 'read' || call.op === 'search' || call.op === 'item' || call.op === 'update'),
		[...new Set(mock.calls().map(call => call.op))].join(','))
	if (mock.updates().length > 0) {
		check('agent wrote metadata back through the bridge', true, `update: ${JSON.stringify(mock.updates().at(-1)).slice(0, 100)}`)
	}

	// Streaming translation against the real model.
	const translateResponse = await fetch(`${base}/api/zotero/translate`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie: cookies },
		body: JSON.stringify({ text: 'The seed sequence of the crRNA guides target recognition.', thinking: false }),
	})
	check('translate route streams (HTTP 200, NDJSON)', translateResponse.status === 200
		&& /ndjson/.test(translateResponse.headers.get('content-type') ?? ''))
	const reader = translateResponse.body.getReader()
	const decoder = new TextDecoder()
	let buffer = ''
	const events2 = []
	const readDeadline = Date.now() + 120000
	while (Date.now() < readDeadline) {
		const { done, value } = await reader.read()
		if (done) break
		buffer += decoder.decode(value, { stream: true })
		let index
		while ((index = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, index).trim()
			buffer = buffer.slice(index + 1)
			if (!line) continue
			try { events2.push(JSON.parse(line)) } catch { /* torn line */ }
		}
		if (events2.some(evt => evt.type === 'done' || evt.type === 'error')) break
	}
	const answers = events2.filter(evt => evt.type === 'answer').map(evt => evt.text).join('')
	check('translation streamed answer deltas', answers.length > 0, answers.slice(0, 60))
	check('translation completed', events2.some(evt => evt.type === 'done'), events2.find(evt => evt.type === 'error')?.message ?? '')

	child.kill()
	await new Promise(resolve => child.on('exit', resolve))
	await mock.stop()

	if (failed > 0) {
		console.error(`\n${failed} check(s) FAILED`)
		process.exit(1)
	}
	console.log('\nall live checks passed')
	process.exit(0)
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
