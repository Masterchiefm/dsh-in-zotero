// Offline tests for the WPS Zotero add-in's pure logic — no WPS, no Zotero.
//
//   1. zotero-plugin/content/scripts/wps.js : publish.xml merge (the add-in
//      registry WPS reads), and the ADDON_FILES manifest against the directory.
//   2. zotero-plugin/content/wps-addon/js/{html,document}.js : HTML → text +
//      formatting spans, wire/stored field codes, fieldType Field↔Http swap.
//
// Both files are classic scripts meant for foreign hosts (a Zotero bootstrap
// sandbox / a WPS add-in page), so they are loaded into a vm context with the
// few globals they expect. HTML parsing in tests uses a minimal DOM built here
// (html.js only needs nodeType/localName/childNodes/getAttribute/textContent).
//
// Usage: node tests/wps.test.mjs

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ADDON_DIR = path.join(ROOT, 'zotero-plugin', 'content', 'wps-addon')

let failed = 0
let total = 0
function check(name, ok, detail = '') {
	total += 1
	if (!ok) failed += 1
	console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ---------------------------------------------------------------- wps.js (Zotero side)

const zoteroCtx = vm.createContext({
	DSH: { Util: { log() {} } },
	ctx: { rootURI: 'chrome://dsh-in-zotero/content/', VERSION: '0.0.0-test' },
})
vm.runInContext(read('zotero-plugin/content/scripts/wps.js'), zoteroCtx)
const WPS = zoteroCtx.DSH.WPS
const { rewritePublish, findPublishEntry, addonElement, publishItems } = WPS._internals

const OTHER = '<jsplugin name="other-addon" type="et" url="other-addon_1.2.3" version="1.2.3" enable="enable_dev" install="null" customDomain=""/>'
const ONLINE = '<jspluginonline name="devtool" type="wps" url="http://127.0.0.1:3889/" debug="" enable="enable_dev" install="null" customDomain=""/>'
const OURS = addonElement()

console.log('\n--- publish.xml merge ---')
const fresh = rewritePublish('', OURS)
check('empty file → only our entry', fresh === `<jsplugins>\n    ${OURS}\n</jsplugins>\n`, JSON.stringify(fresh))
const merged = rewritePublish(`<jsplugins>\n    ${OTHER}\n    <!-- keep me -->\n</jsplugins>\n`, OURS)
check('ours goes first, other add-ins and comments survive in order',
	merged === `<jsplugins>\n    ${OURS}\n    ${OTHER}\n    <!-- keep me -->\n</jsplugins>\n`, JSON.stringify(merged))
const replaced = rewritePublish(`<jsplugins><jsplugin name="zotero-in-wps" type="wps" url="zotero-in-wps_0.9.0" version="0.9.0" enable="enable_dev" install="null" customDomain=""/>${OTHER}</jsplugins>`, OURS)
check('stale own entry is replaced, never duplicated',
	publishItems(replaced).filter(item => item.includes('zotero-in-wps')).length === 1 && replaced.includes(OTHER), JSON.stringify(replaced))
const uninstalled = rewritePublish(merged, null)
check('uninstall keeps everyone else', uninstalled === `<jsplugins>\n    ${OTHER}\n    <!-- keep me -->\n</jsplugins>\n`, JSON.stringify(uninstalled))
check('uninstall with nobody left → empty table', rewritePublish(fresh, null) === '<jsplugins>\n</jsplugins>\n')
const online = rewritePublish(`<jsplugins>${ONLINE}${OTHER}</jsplugins>`, OURS)
check('debug-mode jspluginonline entries are preserved', online.includes(ONLINE) && online.includes(OTHER) && online.indexOf(OURS) < online.indexOf(ONLINE))

const entry = findPublishEntry(merged)
check('findPublishEntry reads url/version', entry?.url === 'zotero-in-wps_1.0.0' && entry?.version === '1.0.0', JSON.stringify(entry))
check('findPublishEntry → null when absent', findPublishEntry(`<jsplugins>${OTHER}</jsplugins>`) === null)
check('addonElement matches the official offline shape', /^<jsplugin name="zotero-in-wps" type="wps" url="zotero-in-wps_1\.0\.0" version="1\.0\.0" enable="enable_dev" install="null" customDomain=""\/>$/.test(OURS), OURS)

console.log('\n--- ADDON_FILES manifest ---')
const walk = (dir, prefix = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
	const rel = prefix ? `${prefix}/${entry.name}` : entry.name
	return entry.isDirectory() ? walk(path.join(dir, entry.name), rel) : [rel]
})
const onDisk = walk(ADDON_DIR).sort()
const expected = [...WPS.ADDON_FILES, 'js/config.js'].sort() // config.js is generated at install time
check('ADDON_FILES + generated config.js == wps-addon/ contents', JSON.stringify(onDisk) === JSON.stringify(expected),
	`missing from manifest: ${onDisk.filter(rel => !expected.includes(rel))}; listed but absent: ${expected.filter(rel => !onDisk.includes(rel))}`)
/** Cheap well-formedness check: paired tags must nest, void/self-closing tags stand alone. */
function tagsBalance(xml) {
	const VOID = new Set(['meta', 'link', 'br', 'img', 'hr', 'input'])
	const stack = []
	for (const match of xml.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<([A-Za-z][\w:-]*)(?:"[^"]*"|'[^']*'|[^'">])*?(\/?)>|<\/([A-Za-z][\w:-]*)\s*>/g)) {
		if (match[3]) {
			if (stack.pop() !== match[3]) return false
		}
		else if (!match[2] && !VOID.has(match[1])) stack.push(match[1])
	}
	return stack.length === 0
}

check('index.html references every script that exists', ['config', 'html', 'dialog', 'document', 'protocol', 'ribbon'].every(name => read('zotero-plugin/content/wps-addon/index.html').includes(`js/${name}.js`)))
check('ribbon.xml / dialog.html markup is balanced', tagsBalance(read('zotero-plugin/content/wps-addon/ribbon.xml')) && tagsBalance(read('zotero-plugin/content/wps-addon/dialog.html').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '')))

// ---------------------------------------------------------------- add-on scripts (WPS side)

/** Minimal DOM for html.js: tags, attributes, text, entities. Good enough for citeproc output. */
function parseHtml(html) {
	const VOID = new Set(['br', 'img', 'hr', 'meta', 'link', 'input'])
	const decode = (text) => text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|#39);/gi, (whole, entity) => {
		if (entity[0] === '#') {
			const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
			return String.fromCodePoint(code)
		}
		return { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[entity.toLowerCase()]
	})
	const make = (localName) => ({
		nodeType: 1,
		localName,
		attrs: {},
		childNodes: [],
		getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null },
		get textContent() { return this.childNodes.map(child => child.nodeType === 3 ? child.nodeValue : child.textContent).join('') },
		querySelector(selector) {
			for (const child of this.childNodes) {
				if (child.nodeType !== 1) continue
				if (child.localName === selector) return child
				const nested = child.querySelector(selector)
				if (nested) return nested
			}
			return null
		},
	})
	const body = make('body')
	const stack = [body]
	const tokenRe = /<!--[\s\S]*?-->|<![^>]*>|<([A-Za-z][-A-Za-z0-9:._]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|<\/([A-Za-z][-A-Za-z0-9:._]*)\s*>/g
	let last = 0
	let match
	const text = (value) => { if (value) stack.at(-1).childNodes.push({ nodeType: 3, nodeValue: decode(value) }) }
	while ((match = tokenRe.exec(html))) {
		if (match.index > last) text(html.slice(last, match.index))
		if (match[1]) {
			const node = make(match[1].toLowerCase())
			const attrRe = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
			let attr
			while ((attr = attrRe.exec(match[2] || ''))) node.attrs[attr[1].toLowerCase()] = attr[2] ?? attr[3] ?? attr[4] ?? ''
			stack.at(-1).childNodes.push(node)
			if (!match[3] && !VOID.has(node.localName)) stack.push(node)
		}
		else if (match[4]) {
			const name = match[4].trim().toLowerCase()
			for (let i = stack.length - 1; i > 0; i--) {
				if (stack[i].localName === name) { stack.length = i; break }
			}
		}
		last = tokenRe.lastIndex
	}
	if (last < html.length) text(html.slice(last))
	return { body, textContent: body.textContent }
}

const page = vm.createContext({
	window: {},
	DOMParser: class { parseFromString(html) { return parseHtml(html) } },
	console,
})
page.window = page // scripts do `window.ZW = …` and read `window.ZOTERO_WPS_CONFIG`
for (const file of ['js/html.js', 'js/dialog.js', 'js/document.js', 'js/protocol.js', 'js/ribbon.js']) {
	vm.runInContext(fs.readFileSync(path.join(ADDON_DIR, file), 'utf8'), page, { filename: file })
}
const { Html, Doc } = page.ZW

const spans = (compiled) => compiled.spans.map(span => `${span.start}-${span.end}:${JSON.stringify(span.fmt)}`)
const ITALIC = { italic: true }

console.log('\n--- HTML → text + spans ---')
const citation = Html.compile('(Zhang, <i>et al.</i>, 2020, p.&#160;5<sup>1</sup>)')
check('inline citation: text equals textContent', citation.text === '(Zhang, et al., 2020, p.\u00a051)', JSON.stringify(citation.text))
check('inline citation: italic + superscript spans at UTF-16 offsets',
	spans(citation).join(' | ') === '8-14:{"italic":true} | 26-27:{"sup":true}', spans(citation).join(' | '))

const nested = Html.compile('<i><b>AB</b>C<sup>D</sup></i>')
check('nested formats inherit', nested.text === 'ABCD'
	&& spans(nested).join(' | ') === '0-2:{"italic":true,"bold":true} | 2-3:{"italic":true} | 3-4:{"italic":true,"sup":true}', spans(nested).join(' | '))

const styled = Html.compile('<span style="font-style:italic; font-variant:small-caps">x</span><a href="https://doi.org/10.1/x">y</a><span style="text-decoration: line-through">z</span>')
check('span styles and links map to formats', styled.text === 'xyz'
	&& spans(styled).join(' | ') === '0-1:{"italic":true} | 1-2:{"href":"https://doi.org/10.1/x"} | 2-3:{"strike":true}', spans(styled).join(' | '))

const bib = Html.compile('<div class="csl-bib-body"><div class="csl-entry">A<i>1</i></div><div class="csl-entry">B</div><div class="csl-entry">C</div></div>')
check('bibliography: one paragraph per entry, no stray breaks at the ends', bib.text === 'A1\rB\rC' && spans(bib).join() === '1-2:{"italic":true}', JSON.stringify(bib.text) + ' ' + spans(bib).join())

const flush = Html.compile('<div class="csl-bib-body"><div class="csl-entry"><div class="csl-left-margin">[1]</div><div class="csl-right-inline">Author, <i>Title</i></div></div></div>', { tabCount: 2 })
check('second-field-align: left/right stay in one paragraph joined by tabs', flush.text === '[1]\t\tAuthor, Title'
	&& spans(flush).join(' | ') === '13-18:{"italic":true}', JSON.stringify(flush.text) + ' ' + spans(flush).join(' | '))

const delayed = Html.compile("<div class='delayed-zotero-citation-updates'>(X, 2020)</div>")
check('delayed-update wrapper div adds no paragraph breaks', delayed.text === '(X, 2020)', JSON.stringify(delayed.text))

const cjk = Html.compile('（张 <i>等</i>，2020）')
check('CJK text offsets are exact', cjk.text === '（张 等，2020）' && spans(cjk).join() === '3-4:{"italic":true}', spans(cjk).join())

const breaks = Html.compile('line one<br/>line two<p>para</p>')
check('<br> is dropped for field text (Zotero compares against textContent)', breaks.text === 'line oneline two\rpara', JSON.stringify(breaks.text))
const breaksKept = Html.compile('line one<br/>line two<p>para</p>', { keepBreaks: true })
check('<br> becomes a manual line break for inserted notes', breaksKept.text === 'line one\x0bline two\rpara', JSON.stringify(breaksKept.text))

const note = Html.compile('<html><body><p>See <a href="https://www.zotero.org/?abc123">(X, 2020)</a> and <b>bold</b>.</p><p>Second 段</p></body></html>', { keepBreaks: true })
check('note HTML: paragraphs separated, placeholder link kept as a span',
	note.text === 'See (X, 2020) and bold.\rSecond 段'
	&& note.spans.some(span => span.fmt.href === 'https://www.zotero.org/?abc123' && note.text.slice(span.start, span.end) === '(X, 2020)'),
	JSON.stringify(note.text))
check('colorInt: #rrggbb → BGR integer (red in the low byte)', Html.colorInt('#2ea8e5') === (0x2e + 0xa8 * 256 + 0xe5 * 65536) && Html.colorInt('#f00') === 255)

console.log('\n--- field codes and document data ---')
const { toWire, toStored, swapFieldType } = Doc._internals
check('toWire strips the ADDIN ZOTERO_ prefix', toWire(' ADDIN ZOTERO_ITEM CSL_CITATION {} ') === 'ITEM CSL_CITATION {}' && toWire(' ADDIN ZOTERO_TEMP ') === 'TEMP')
check('toWire rejects foreign fields', toWire(' PAGE ') === null && toWire(' ADDIN ZOTEROX ') === null && toWire('') === null)
check('toStored restores the Word form (leading/trailing space)', toStored('ITEM CSL_CITATION {}') === ' ADDIN ZOTERO_ITEM CSL_CITATION {} ')

const WORD_XML = '<data data-version="3" zotero-version="7.0"><session id="ABCD"/><style id="http://www.zotero.org/styles/apa" hasBibliography="1" bibliographyStyleHasBeenSet="0" /><prefs><pref name="fieldType" value="Field"/><pref name="noteType" value="0"/></prefs></data>'
const wireXml = swapFieldType(WORD_XML, 'Field', 'Http')
check('XML doc data: Field → Http on the wire', wireXml.includes('<pref name="fieldType" value="Http"/>') && wireXml.includes('noteType" value="0"'))
check('XML doc data: round trip restores the Word form', swapFieldType(wireXml, 'Http', 'Field') === WORD_XML)
const wordJson = JSON.stringify({ style: { styleID: 'http://www.zotero.org/styles/apa' }, prefs: { fieldType: 'Field', noteType: 0 }, sessionID: 'ABCD', dataVersion: 4 })
const wireJson = swapFieldType(wordJson, 'Field', 'Http')
check('JSON doc data: Field → Http, round trip is lossless', JSON.parse(wireJson).prefs.fieldType === 'Http' && swapFieldType(wireJson, 'Http', 'Field') === wordJson)
check('Bookmark-mode documents are left untouched (Zotero raises its own mismatch alert)',
	swapFieldType(WORD_XML.replace('"Field"', '"Bookmark"'), 'Field', 'Http').includes('value="Bookmark"'))

console.log('\n--- alert dialog (main page side) ---')
const Dialog = page.ZW.Dialog
const { dialogGone, dialogUnloaded, VALUES: BTN_VALUES, CLOSED: BTN_CLOSED, OPEN_GRACE_MS, GONE_AFTER_MS, UNLOAD_AFTER_MS, SETTLE_MS } = Dialog._internals
// Zotero 10 的 integration.js 是这样用 displayAlert 的返回值的：OK_CANCEL → `if (result)` 才继续
// （removeCodes / addField / upgradeWarning）；YES_NO_CANCEL → 0 取消 / 1 否 / 其余是（resolveCorrupt）
check('button values follow Zotero 10 (OK=1, Cancel=0; No=1, Yes=2)', JSON.stringify(BTN_VALUES) === '{"0":[1],"1":[1,0],"2":[1,0],"3":[2,1,0]}', JSON.stringify(BTN_VALUES))
check('closing the window counts as cancel (single-OK box: as OK)', JSON.stringify(BTN_CLOSED) === '{"0":1,"1":0,"2":0,"3":0}', JSON.stringify(BTN_CLOSED))
check('dialog gone: a dialog that never reported alive is given up after the grace period',
	dialogGone(OPEN_GRACE_MS, 0, 0) === false && dialogGone(OPEN_GRACE_MS + 1, 0, 0) === true)
check('dialog gone: a fresh heartbeat keeps waiting, a stale one means the window is gone',
	dialogGone(10_000, 0, 9_000) === false && dialogGone(9_000 + GONE_AFTER_MS, 0, 9_000) === false && dialogGone(9_000 + GONE_AFTER_MS + 1, 0, 9_000) === true)

// 用假时钟 + 内存版 PluginStorage 驱动真实的 alert()；「对话框页」由测试扮演
const store = new Map()
const shown = []
page.location = { href: 'file:///C:/Users/x/AppData/Roaming/Kingsoft/wps/jsaddons/zotero-in-wps_1.0.0/index.html' }
page.URL = URL
page.wps = {
	PluginStorage: {
		setItem: (k, v) => store.set(k, String(v)),
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		removeItem: (k) => store.delete(k),
	},
	ShowDialog: (url) => { shown.push(url) },
}
// 假时钟与假计时器只定义一次：vm 上下文里「先缺失、后补上」的全局，V8 的内联缓存不会察觉
const clock = { now: 1_000_000, seq: 0, tasks: [] }
const schedule = (cb, delay, period) => { clock.tasks.push({ id: ++clock.seq, cb, at: clock.now + delay, period }); return clock.seq }
page.setInterval = (cb, ms) => schedule(cb, ms, ms)
page.setTimeout = (cb, ms) => schedule(cb, ms, 0)
page.clearInterval = (id) => { const t = clock.tasks.find((x) => x.id === id); if (t) t.dead = true }
page.Date = class extends Date { static now() { return clock.now } }
const resetClock = () => { clock.now = 1_000_000; clock.tasks.length = 0; store.clear(); shown.length = 0 } // seq 不清零：计时器 id 必须保持唯一，否则 clearInterval 会命中上个用例的旧任务
const tick = (ms) => {
	clock.now += ms
	for (const t of [...clock.tasks].sort((x, y) => x.at - y.at)) {
		if (t.dead || t.at > clock.now) continue
		if (t.period) t.at = clock.now + t.period
		else t.dead = true
		t.cb()
	}
}
const drain = () => new Promise((resolve) => setImmediate(resolve))
const PREFIX = 'zotero-wps-dialog.'
const SUFFIX = /\.(result|alive|closed)$/
const specKey = () => [...store.keys()].find((k) => k.startsWith(PREFIX) && !SUFFIX.test(k))
/** 扮演对话框页：报 n 次活（每次都是新心跳值） */
const beat = (key, n) => { for (let i = 0; i < n; i++) { store.set(key + '.alive', `beat-${Math.random()}`); tick(150) } }
/** 把上一个用例遗留的对话框收尾跑完（答复 → 卸载判定 → 清键 → 兑现「下一条可以弹」），否则下一条 alert 会一直排队 */
const settle = async () => { for (let i = 0; i < 60 && (specKey() || clock.tasks.some((t) => !t.dead)); i++) tick(150); tick(SETTLE_MS); await drain() }
check('dialog unloaded: pagehide flag, or no fresh heartbeat for UNLOAD_AFTER_MS',
	dialogUnloaded(9_000, 8_500, '1') === true && dialogUnloaded(9_000, 8_500, null) === false
	&& dialogUnloaded(8_500 + UNLOAD_AFTER_MS, 8_500, null) === false && dialogUnloaded(8_500 + UNLOAD_AFTER_MS + 1, 8_500, null) === true)
check('alert: stores the spec under a fresh id and opens dialog.html with it', await (async () => {
	await settle(); resetClock()
	const pending = Dialog.alert('删除所有域代码？', 2, 3)
	await drain() // alert 先等上一个对话框的「已关闭」承诺（首条即刻兑现）
	tick(0)
	const key = specKey()
	const spec = JSON.parse(store.get(key))
	const ok = shown.at(-1) === `file:///C:/Users/x/AppData/Roaming/Kingsoft/wps/jsaddons/zotero-in-wps_1.0.0/dialog.html?id=${key.slice(PREFIX.length)}`
		&& spec.labels.join() === '是,否,取消' && spec.values.join() === '2,1,0' && spec.cancel === 0 && spec.icon === 2
		&& store.get(key + '.result') === ''
	store.set(key + '.alive', 'a1'); tick(150) // 对话框页报活
	store.set(key + '.result', '2'); tick(150) // 用户点了「是」→ 立刻兑现给 Zotero
	const value = await pending
	return ok && value === 2
})())
check('alert: the answered dialog is watched until its page unloads, then its keys are removed', await (async () => {
	const key = specKey()
	beat(key, 2) // 窗口还在拆：心跳继续，键保留
	const keptWhileClosing = specKey() === key
	store.set(key + '.closed', '1'); tick(150) // pagehide
	const removedAfterUnload = specKey() === undefined
	tick(SETTLE_MS); await drain() // 兑现「下一条提示可以弹了」
	return keptWhileClosing && removedAfterUnload
})())
check('alert: back to back — the next dialog waits for the previous window to unload (+ settle time)', await (async () => {
	await settle(); resetClock()
	const first = Dialog.alert('第一条', 1, 1)
	await drain()
	tick(0)
	const k1 = specKey()
	beat(k1, 1)
	store.set(k1 + '.result', '1'); tick(150) // 用户点「确定」→ 第一条立刻兑现（Zotero 那边不等）
	const v1 = await first
	const second = Dialog.alert('第二条', 1, 1) // Zotero 紧接着弹第二条
	await drain()
	const notShownWhileOpen = shown.length === 1
	beat(k1, 2) // 上一个窗口还在拆：心跳继续，第二个对话框仍然不能弹
	await drain()
	const stillNotShown = shown.length === 1
	store.set(k1 + '.closed', '1'); tick(150) // pagehide
	await drain()
	const notShownBeforeSettle = shown.length === 1
	tick(SETTLE_MS); await drain()
	const shownAfterSettle = shown.length === 2
	const k2 = specKey()
	beat(k2, 1)
	store.set(k2 + '.result', '0'); tick(150)
	const v2 = await second
	return v1 === 1 && notShownWhileOpen && stillNotShown && notShownBeforeSettle && shownAfterSettle && k2 !== k1 && v2 === 0
})())
check('alert: back to back — a silent heartbeat (no pagehide flag) also releases the next dialog', await (async () => {
	await settle(); resetClock()
	const first = Dialog.alert('第一条', 1, 1)
	await drain()
	tick(0)
	const k1 = specKey()
	beat(k1, 1)
	store.set(k1 + '.result', '1'); tick(150)
	await first
	const second = Dialog.alert('第二条', 1, 1)
	await drain()
	let ticks = 0
	while (shown.length === 1 && ticks < 30) { tick(150); await drain(); ticks++ } // 页面不再报活，也没有 pagehide 标记
	const released = shown.length === 2 && ticks * 150 >= UNLOAD_AFTER_MS + SETTLE_MS
	const k2 = specKey()
	if (k2) { beat(k2, 1); store.set(k2 + '.result', '0'); tick(150) }
	return released && await second === 0
})())
check('alert: window closed by the host without a result → cancelled once the heartbeat stops', await (async () => {
	await settle(); resetClock()
	const pending = Dialog.alert('继续吗？', 1, 1)
	await drain()
	tick(0)
	const key = specKey()
	beat(key, 2)
	let settled = false
	pending.then(() => { settled = true })
	tick(GONE_AFTER_MS - 150)
	await Promise.resolve()
	const stillWaiting = !settled
	tick(300) // 超过 GONE_AFTER_MS
	return stillWaiting && await pending === 0 && specKey() === undefined
})())
check('alert: dialog that never shows → cancelled after OPEN_GRACE_MS', await (async () => {
	await settle(); resetClock()
	const pending = Dialog.alert('x', 0, 0)
	await drain()
	tick(0); tick(OPEN_GRACE_MS)
	let settled = false
	pending.then(() => { settled = true })
	await Promise.resolve()
	const stillWaiting = !settled
	tick(150)
	return stillWaiting && await pending === BTN_CLOSED[0]
})())

console.log(`\n${total - failed}/${total} checks passed`)
if (failed) {
	console.error(`${failed} check(s) FAILED`)
	process.exit(1)
}
