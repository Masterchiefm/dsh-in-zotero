// Zotero in WPS 加载项 — WPS 文档操作层：实现 Zotero HTTP 集成协议里「文字处理器
// 一端」的 Document.* / Field.* 命令。
//
// 域的落盘形态与 MS Word 版插件完全一致，所以同一份文档可以在 Word 和 WPS 之间
// 接着编辑：
//   引文  ADDIN ZOTERO_ITEM CSL_CITATION {…}
//   书目  ADDIN ZOTERO_BIBL {…} CSL_BIBLIOGRAPHY
//   占位  ADDIN ZOTERO_TEMP
// 文档数据存自定义文档属性 ZOTERO_PREF_1..N（每块 ≤255 字符，同 Word 版）。
// 协议线上（Zotero ↔ 加载项）的域代码不带「 ADDIN ZOTERO_」前缀，fieldType 记作
// Http（Zotero 的 HTTP agent 只认这个值），落盘时再换回 Field。
//
// WPS JS API 的两个实测特性决定了这里的写法：
//   1. API 对象每次取都是新代理，不能长期持有、也不能用 === 比较——一律「要用时
//      再按位置取」。位置用「容器 + 序号」表示：容器是正文或第 k 个脚注/尾注，
//      序号是该容器 Fields 集合里的 1 起序号（Zotero 在一次事务里靠 id 认域，
//      所以每次增删域之后都要把后面域的序号顺延）。
//   2. 字符位置把域的内部结构也算在内：一个域占 [Code.Start-1 … Result.End+1]——
//      首尾各一个不可见的域标记符，中间依次是域代码（Code）与域结果（Result）。
//      所以「域从哪开始」取 Code.Start-1；两条域之间什么都没有时，后一条的
//      Code.Start 等于前一条的 Result.End+2。子区间格式化要用 SetRange
//      （doc.Range 只作用于正文故事区，在脚注里会指到别的字符上）。

ZW.Doc = (function () {
	// WPS 的 wd* 枚举值（与 wps.Enum 同值；写死数值以免各版本枚举表有出入）
	const WD = {
		fieldAddin: 81, storyMain: 1, storyFootnotes: 2, storyEndnotes: 3,
		propString: 4, styleParagraph: 1, tabLeft: 0, lineSingle: 0, lineMultiple: 5,
	};
	const CODE_MARK = 'ADDIN ZOTERO_';
	const CODE_PREFIX = ' ' + CODE_MARK;
	const TEMP_CODE = 'TEMP';
	const PROP_NAME = 'ZOTERO_PREF';
	const PROP_CHUNK = 255;
	const BIB_STYLE = 'Bibliography';
	const PLACEHOLDER_URL = 'https://www.zotero.org/?';
	const PROCESSOR = 'WPS 文字';
	const MAX_FORMAT_CHARS = 400; // 域在正文与脚注之间搬家时逐字读格式的上限

	let tx = null; // 当前事务的域登记表

	function fail(message) {
		return new Error(message);
	}

	// ---------------------------------------------------------------- 文档与容器

	function app() {
		return window.Application;
	}

	function activeDocument() {
		try {
			const doc = app().ActiveDocument;
			return doc ? doc : null;
		}
		catch (e) {
			return null; // 没有打开的文档
		}
	}

	/** 文档的身份：已保存的用完整路径；未保存的文档 WPS 让 FullName 等于文档名。 */
	function documentId(doc) {
		return String(doc.FullName || doc.Name);
	}

	function cur() {
		const want = tx ? tx.docId : '';
		if (want) {
			const docs = app().Documents;
			for (let i = docs.Count; i >= 1; i--) {
				const d = docs.Item(i);
				if (documentId(d) === want) return d;
			}
		}
		const doc = activeDocument();
		if (!doc) throw fail('WPS 文字里没有打开的文档。');
		return doc;
	}

	// 容器 id：'main'（正文）| 'fn:k'（第 k 个脚注）| 'en:k'（第 k 个尾注）
	function noteIndex(c) {
		return c === 'main' ? 0 : Number(c.slice(c.indexOf(':') + 1));
	}

	function noteKind(c) {
		return c.slice(0, c.indexOf(':'));
	}

	function notes(doc, kind) {
		return kind === 'en' ? doc.Endnotes : doc.Footnotes;
	}

	/** 容器的 Fields 集合。 */
	function containerFields(doc, c) {
		if (c === 'main') return doc.Fields;
		return notes(doc, noteKind(c)).Item(noteIndex(c)).Range.Fields;
	}

	/** 容器所在故事区的一个 Range 锚点：SetRange 之后仍在同一故事区。 */
	function anchor(doc, c, start, end) {
		const r = c === 'main' ? doc.Range(0, 0) : notes(doc, noteKind(c)).Item(noteIndex(c)).Range;
		r.SetRange(start, end);
		return r;
	}

	/** 容器故事区上的 Hyperlinks 集合。 */
	function containerLinks(doc, c) {
		if (c === 'main') return doc.Hyperlinks;
		return notes(doc, noteKind(c)).Item(noteIndex(c)).Range.Hyperlinks;
	}

	/** 选区所在的容器；不在正文/脚注/尾注（页眉、文本框、批注等）时返回 null。 */
	function selectionContainer(doc, sel) {
		const story = sel.StoryType;
		if (story === WD.storyMain) return 'main';
		if (story !== WD.storyFootnotes && story !== WD.storyEndnotes) return null;
		const kind = story === WD.storyFootnotes ? 'fn' : 'en';
		const list = notes(doc, kind);
		const pos = sel.Start;
		for (let i = 1; i <= list.Count; i++) {
			const r = list.Item(i).Range;
			if (pos >= r.Start && pos <= r.End) return kind + ':' + i;
		}
		return null;
	}

	// ---------------------------------------------------------------- 域代码与属性

	/** 落盘的域代码 → 协议形态；不是 Zotero 域返回 null。 */
	function toWire(stored) {
		const s = String(stored ?? '').replace(/^\s+|\s+$/g, '');
		return s.indexOf(CODE_MARK) === 0 ? s.slice(CODE_MARK.length) : null;
	}

	function toStored(wire) {
		return CODE_PREFIX + wire + ' ';
	}

	/** 读全部 ZOTERO_PREF_* 属性块，按编号拼接。 */
	function readDocumentData(doc) {
		const props = doc.CustomDocumentProperties;
		const chunks = [];
		for (let i = 1; i <= props.Count; i++) {
			const p = props.Item(i);
			const name = String(p.Name);
			if (name.indexOf(PROP_NAME) !== 0) continue;
			const suffix = name.slice(PROP_NAME.length);
			// Word 版写 ZOTERO_PREF_1..N；无编号的裸 ZOTERO_PREF 当作第 1 块
			const m = /^_(\d+)$/.exec(suffix);
			const index = m ? Number(m[1]) : suffix === '' ? 1 : -1;
			if (index < 0) continue;
			chunks.push({ index, value: String(p.Value ?? '') });
		}
		chunks.sort((a, b) => a.index - b.index);
		return chunks.map((chunk) => chunk.value).join('');
	}

	/** 先删旧块再写：WPS 对同名属性重复 Add 不报错，内容却不可预期。 */
	function writeDocumentData(doc, data) {
		const props = doc.CustomDocumentProperties;
		for (let i = props.Count; i > 0; i--) {
			const p = props.Item(i);
			const name = String(p.Name);
			if (name === PROP_NAME || name.indexOf(PROP_NAME + '_') === 0) p.Delete();
		}
		const value = String(data ?? '');
		const count = Math.max(1, Math.ceil(value.length / PROP_CHUNK));
		for (let i = 0; i < count; i++) {
			props.Add(PROP_NAME + '_' + (i + 1), false, WD.propString, value.substr(i * PROP_CHUNK, PROP_CHUNK));
		}
	}

	// 文档数据里的 fieldType：落盘 Field（Word 版的写法）↔ 线上 Http（HTTP agent 的要求）。
	// 新数据是 JSON（dataVersion 4），旧数据是 XML，两种都处理。
	function swapFieldType(data, from, to) {
		const s = String(data ?? '');
		if (s.replace(/^\s+/, '').charAt(0) === '{') {
			try {
				const o = JSON.parse(s);
				if (o && o.prefs && o.prefs.fieldType === from) o.prefs.fieldType = to;
				return JSON.stringify(o);
			}
			catch (e) {
				return s;
			}
		}
		return s.replace(new RegExp('(<pref\\s+name="fieldType"\\s+value=")' + from + '(")'), '$1' + to + '$2');
	}

	// ---------------------------------------------------------------- 域登记表
	//
	// tx.containers[c] 是容器 c 里**全部**域的有序表（下标 i ↔ Fields.Item(i+1)），
	// 每项 { id, wire, text }：Zotero 域有 id，其他域 id 为 null；wire/text 是协议
	// 形态的域代码与可见文字的快照。
	// tx.fields[id] = { c, i } 记下每个 Zotero 域现在的位置。

	function begin() {
		tx = { docId: '', containers: {}, fields: {}, seq: 0, bibStyle: null, lastDeleted: null, placeholders: null };
	}

	function end() {
		tx = null;
	}

	function dropContainer(c) {
		for (const entry of tx.containers[c] || []) {
			if (entry.id) delete tx.fields[entry.id];
		}
		delete tx.containers[c];
	}

	function remember(c, list) {
		tx.containers[c] = list;
		for (let i = 0; i < list.length; i++) {
			if (list[i].id) tx.fields[list[i].id] = { c, i: i + 1 };
		}
	}

	/** 现读容器里的全部域。同位置上已有的 id 原样沿用——Zotero 在一次事务里靠 id 认域。 */
	function scanContainer(doc, c) {
		const fields = containerFields(doc, c);
		const old = tx.containers[c];
		const list = [];
		for (let i = 1; i <= fields.Count; i++) {
			const f = fields.Item(i);
			const wire = toWire(f.Code.Text);
			list.push(wire === null ? { id: null, wire: null, text: '' } : { id: null, wire, text: String(f.Result.Text ?? '') });
		}
		if (old && old.length !== list.length) {
			dropContainer(c); // 数量对不上：结构被别处改过，这一容器重新编号
		}
		else if (old) {
			for (let i = 0; i < list.length; i++) {
				if (old[i].id && list[i].wire !== null) list[i].id = old[i].id;
			}
		}
		// 新发现的 Zotero 域在这里领 id（Zotero 以后全靠 id 引用它们）
		for (const entry of list) {
			if (entry.wire !== null && !entry.id) entry.id = 'f' + (++tx.seq);
		}
		remember(c, list);
	}

	/** 协议要求的域顺序：正文 → 各脚注 → 各尾注。 */
	function orderedContainers() {
		const out = [];
		const rank = (c) => {
			if (c === 'main') return [0, 0];
			return [c.indexOf('fn') === 0 ? 1 : 2, noteIndex(c)];
		};
		for (const c of Object.keys(tx.containers)) out.push(c);
		out.sort((a, b) => {
			const ra = rank(a);
			const rb = rank(b);
			return ra[0] !== rb[0] ? ra[0] - rb[0] : ra[1] - rb[1];
		});
		return out;
	}

	/** 现读全部容器（正文、每个脚注、每个尾注）并返回全部 Zotero 域的协议描述。 */
	function scanAll(doc) {
		const wanted = ['main'];
		for (let i = 1; i <= doc.Footnotes.Count; i++) wanted.push('fn:' + i);
		for (let i = 1; i <= doc.Endnotes.Count; i++) wanted.push('en:' + i);
		for (const c of Object.keys(tx.containers)) {
			if (wanted.indexOf(c) < 0) dropContainer(c);
		}
		for (const c of wanted) scanContainer(doc, c);
		const out = [];
		for (const c of orderedContainers()) {
			tx.containers[c].forEach((entry, i) => {
				if (entry.id) out.push(describe(doc, c, entry, i + 1));
			});
		}
		return out;
	}

	/** 协议里的域描述（见 scanAll 的快照；相邻判断只在正文里做）。 */
	function describe(doc, c, entry, i) {
		const adjacentPair = c === 'main' && isItem(entry.wire);
		let adjacent = false;
		if (adjacentPair) {
			const next = tx.containers.main[i]; // 数组下标 i 即第 i+1 个域
			if (next && next.id && isItem(next.wire)) {
				// 紧挨着（中间没有任何字符）：后一条域的起始标记符紧跟着前一条域的结束标记符
			adjacent = containerFields(doc, 'main').Item(i + 1).Code.Start === containerFields(doc, 'main').Item(i).Result.End + 2;
			}
		}
		return {
			id: entry.id,
			code: entry.wire,
			text: entry.text,
			noteIndex: noteIndex(c),
			adjacent,
		};
	}

	function isItem(wire) {
		return typeof wire === 'string' && (wire.indexOf('ITEM') === 0 || wire.indexOf('CITATION') === 0);
	}

	/** 新建域在容器里的序号（1 起）：按 Code.Start 二分，全部现读，不依赖缓存里的位置。 */
	function positionOf(doc, c, start) {
		const fields = containerFields(doc, c);
		const count = fields.Count;
		let lo = 1;
		let hi = count;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (fields.Item(mid).Code.Start < start) lo = mid + 1;
			else hi = mid;
		}
		if (lo <= count && fields.Item(lo).Code.Start === start) return lo;
		for (let i = 1; i <= count; i++) {
			if (fields.Item(i).Code.Start === start) return i; // 起点重合的退化情况
		}
		return Math.min(lo, count + 1);
	}

	/** 把新建的域登记到容器的 index 位置（后面各域的序号顺延）。 */
	function register(c, index, wire, id) {
		const list = tx.containers[c];
		const entry = { id: id || 'f' + (++tx.seq), wire, text: '' };
		list.splice(index - 1, 0, entry);
		remember(c, list);
		return entry.id;
	}

	function unregister(id) {
		const e = tx.fields[id];
		if (!e) return;
		tx.containers[e.c].splice(e.i - 1, 1);
		delete tx.fields[id];
		remember(e.c, tx.containers[e.c]);
	}

	/** 新建/删除一个注之后，排在它后面的同类注编号整体平移。 */
	function shiftNotes(kind, from, delta) {
		const keys = Object.keys(tx.containers)
			.filter((c) => c.indexOf(kind + ':') === 0 && noteIndex(c) >= from)
			.sort((a, b) => noteIndex(b) - noteIndex(a));
		for (const c of keys) {
			if (delta < 0 && c === kind + ':' + from) {
				dropContainer(c);
				continue;
			}
			const moved = kind + ':' + (noteIndex(c) + delta);
			tx.containers[moved] = tx.containers[c];
			delete tx.containers[c];
			remember(moved, tx.containers[moved]);
		}
	}

	function entryOf(id) {
		const e = tx.fields[id];
		if (!e) throw fail('找不到域 ' + id);
		return tx.containers[e.c][e.i - 1];
	}

	/** 按登记的位置现取域对象。 */
	function locate(id) {
		const e = tx.fields[id];
		if (!e) throw fail('找不到域 ' + id);
		return containerFields(cur(), e.c).Item(e.i);
	}

	// ---------------------------------------------------------------- 富文本写入

	function applyFont(r, fmt) {
		if (fmt.italic) r.Font.Italic = true;
		if (fmt.bold) r.Font.Bold = true;
		if (fmt.sup) r.Font.Superscript = true;
		if (fmt.sub) r.Font.Subscript = true;
		if (fmt.strike) r.Font.StrikeThrough = true;
		if (fmt.underline) r.Font.Underline = true;
		if (fmt.color !== undefined) {
			try {
				r.Font.Color = fmt.color;
			}
			catch (e) { /* 个别版本不接受数值字色：保住文字，放弃颜色 */ }
		}
	}

	/** 把 { text, spans } 的格式片段写到以 base 为起点、c 故事区里的文字上。 */
	function paint(doc, c, base, spans, rangeOf) {
		const links = [];
		for (const span of spans) {
			const r = rangeOf(base + span.start, base + span.end);
			applyFont(r, span.fmt);
			if (span.fmt.href) links.push(span);
		}
		for (const span of links) {
			containerLinks(doc, c).Add(rangeOf(base + span.start, base + span.end), span.fmt.href);
		}
	}

	/** 写域结果：先清掉旧结果残留在首字符上的格式，再按片段上格式。 */
	function writeResult(doc, f, compiled, c) {
		f.Result.Text = compiled.text;
		const base = f.Result.Start;
		const whole = f.Result;
		whole.Font.Italic = false;
		whole.Font.Bold = false;
		whole.Font.Superscript = false;
		whole.Font.Subscript = false;
		whole.Font.StrikeThrough = false;
		whole.Font.Underline = false;
		paint(doc, c, base, compiled.spans, (a, b) => {
			const r = f.Result;
			r.SetRange(a, b);
			return r;
		});
	}

	/** 书目段落格式（参数单位是 twips）。段落套 Bibliography 样式，与 Word 版一致。 */
	function applyBibliographyStyle(doc, f, style) {
		const pt = (twips) => (Number(twips) || 0) / 20;
		let styleObj = null;
		try {
			styleObj = doc.Styles.Item(BIB_STYLE);
		}
		catch (e) {
			styleObj = null;
		}
		if (!styleObj) {
			try {
				styleObj = doc.Styles.Add(BIB_STYLE, WD.styleParagraph);
			}
			catch (e) {
				styleObj = null;
			}
		}
		if (styleObj) {
			try {
				f.Result.Style = styleObj;
			}
			catch (e) { /* 套不上样式不影响内容 */ }
		}
		const pf = f.Result.Paragraphs.Format;
		pf.FirstLineIndent = pt(style.firstLineIndent);
		pf.LeftIndent = pt(style.indent);
		pf.SpaceAfter = pt(style.entrySpacing);
		// lineSpacing = 240 × 倍数（240 即单倍）。按倍数设置而不是「固定值」：
		// 固定值会把小四/四号字的中文行距压扁。
		const multiple = (Number(style.lineSpacing) || 0) / 240;
		if (multiple > 0 && Math.abs(multiple - 1) < 0.01) {
			pf.LineSpacingRule = WD.lineSingle;
		}
		else if (multiple > 0) {
			pf.LineSpacingRule = WD.lineMultiple;
			pf.LineSpacing = 12 * multiple;
		}
		pf.TabStops.ClearAll();
		for (const stop of Array.isArray(style.tabStops) ? style.tabStops : []) {
			pf.TabStops.Add(pt(stop), WD.tabLeft);
		}
	}

	/** 逐字读域结果的字符格式，合并成片段（把域在正文与脚注之间搬家时用）。 */
	function readSpans(f) {
		const text = String(f.Result.Text ?? '');
		const base = f.Result.Start;
		const spans = [];
		let current = null;
		const n = Math.min(text.length, MAX_FORMAT_CHARS);
		for (let i = 0; i < n; i++) {
			const r = f.Result;
			r.SetRange(base + i, base + i + 1);
			const fmt = {};
			if (r.Font.Italic) fmt.italic = true;
			if (r.Font.Bold) fmt.bold = true;
			if (r.Font.Superscript) fmt.sup = true;
			if (r.Font.Subscript) fmt.sub = true;
			const key = JSON.stringify(fmt);
			if (current && current.key === key) current.end = i + 1;
			else {
				current = { key, start: i, end: i + 1, fmt };
				spans.push(current);
			}
		}
		return {
			text,
			spans: spans.filter((s) => s.key !== '{}').map(({ start, end, fmt }) => ({ start, end, fmt })),
		};
	}

	/** 新建一个空域，返回 { field, container, index }（index 是它在容器 Fields 里的序号）。 */
	function createField(doc, c, range) {
		const field = doc.Fields.Add(range, WD.fieldAddin, '', false);
		if (!field) throw fail('无法在当前位置插入域。');
		const index = positionOf(doc, c, field.Code.Start);
		return { field, container: c, index };
	}

	// ---------------------------------------------------------------- 命令实现

	function appInfo() {
		const doc = activeDocument();
		if (!doc) throw fail('WPS 文字里没有打开的文档，请先打开或新建一个文档。');
		tx.docId = documentId(doc);
		return {
			documentID: tx.docId,
			outputFormat: 'html',
			supportedNotes: ['footnotes', 'endnotes'],
			supportsImportExport: false,
			supportsTextInsertion: true,
			supportsCitationMerging: true,
			processorName: PROCESSOR,
		};
	}

	function cmdInsertField(noteType) {
		const doc = cur();
		const sel = doc.ActiveWindow.Selection;
		let c = selectionContainer(doc, sel);
		if (!c) throw fail('无法在此处插入引文：请把光标放到正文、脚注或尾注里。');
		if (!tx.containers[c]) scanContainer(doc, c);
		let created;
		if (noteType > 0 && c === 'main') {
			// 引注类样式：先建脚注/尾注，再把域放进新注里
			const kind = noteType === 2 ? 'en' : 'fn';
			const note = notes(doc, kind).Add(sel.Range);
			if (!note) throw fail('无法在此处插入' + (kind === 'fn' ? '脚注' : '尾注') + '，请换一个位置。');
			shiftNotes(kind, note.Index, 1);
			c = kind + ':' + note.Index;
			remember(c, []);
			created = createField(doc, c, note.Range);
		}
		else {
			created = createField(doc, c, sel.Range);
		}
		created.field.Code.Text = toStored(TEMP_CODE);
		created.field.Result.Text = '{Citation}';
		const id = register(created.container, created.index, TEMP_CODE);
		entryOf(id).text = '{Citation}';
		return describe(doc, created.container, entryOf(id), tx.fields[id].i);
	}

	function cmdCursorInField() {
		const doc = cur();
		const sel = doc.ActiveWindow.Selection;
		const c = selectionContainer(doc, sel);
		if (!c) return null;
		if (!tx.containers[c]) scanContainer(doc, c);
		const pos = sel.Start;
		for (let i = 0; i < tx.containers[c].length; i++) {
			const entry = tx.containers[c][i];
			if (!entry.id) continue;
			const f = containerFields(doc, c).Item(i + 1);
			// 光标落在域的起始标记符到结束标记符之后（含两端紧贴处）都算「在域内」——
			// 紧贴着引文点「添加引文」是编辑它，与 Word 版一致
			if (pos >= f.Code.Start - 1 && pos <= f.Result.End + 1) return describe(doc, c, entry, i + 1);
		}
		return null;
	}

	function cmdCanInsertField() {
		const doc = activeDocument();
		if (!doc || doc.ReadOnly) return false;
		const protection = doc.ProtectionType;
		if (protection !== undefined && protection !== null && protection !== -1) return false;
		const story = doc.ActiveWindow.Selection.StoryType;
		return story === WD.storyMain || story === WD.storyFootnotes || story === WD.storyEndnotes;
	}

	function cmdSetCode(id, code) {
		const wire = String(code ?? '');
		const f = locate(id);
		f.Code.Text = toStored(wire);
		entryOf(id).wire = wire;
	}

	function cmdSetText(doc, id, html) {
		const f = locate(id);
		const c = tx.fields[id].c;
		const isBib = entryOf(id).wire.indexOf('BIBL') === 0;
		const style = isBib ? tx.bibStyle : null;
		writeResult(doc, f, ZW.Html.compile(html, { tabCount: style ? style.tabStopsCount : 0 }), c);
		if (isBib && style) applyBibliographyStyle(doc, f, style);
	}

	function cmdDelete(doc, id) {
		const f = locate(id);
		// 删域之后，紧随其后的文字落到原起始标记符的位置——笔记就该写在这里
		tx.lastDeleted = { c: tx.fields[id].c, pos: Math.max(0, f.Code.Start - 1) };
		f.Delete();
		unregister(id);
	}

	function cmdInsertText(doc, html) {
		const at = tx.lastDeleted;
		if (!at) throw fail('没有可用的插入位置。');
		const compiled = ZW.Html.compile(html, { keepBreaks: true });
		anchor(doc, at.c, at.pos, at.pos).InsertBefore(compiled.text);
		paint(doc, at.c, at.pos, compiled.spans, (a, b) => anchor(doc, at.c, a, b));
		// 记下笔记里的引文占位链接的位置：convertPlaceholdersToFields 要原位换成域
		tx.placeholders = {};
		for (const span of compiled.spans) {
			if (span.fmt.href && span.fmt.href.indexOf(PLACEHOLDER_URL) === 0) {
				const pid = span.fmt.href.slice(PLACEHOLDER_URL.length);
				tx.placeholders[pid] = {
					c: at.c,
					start: at.pos + span.start,
					end: at.pos + span.end,
					text: compiled.text.slice(span.start, span.end),
				};
			}
		}
	}

	/** 摘掉一个超链接（地址精确匹配），文字保留。 */
	function removeLink(doc, c, address) {
		const links = containerLinks(doc, c);
		for (let i = links.Count; i >= 1; i--) {
			if (String(links.Item(i).Address) === address) {
				links.Item(i).Delete();
				return;
			}
		}
	}

	function cmdConvertPlaceholders(doc, placeholderIDs, noteType) {
		const out = [];
		for (const raw of Array.isArray(placeholderIDs) ? placeholderIDs : []) {
			const pid = String(raw);
			const p = tx.placeholders && tx.placeholders[pid];
			if (!p) throw fail('找不到引文占位链接 ' + pid + '。');
			removeLink(doc, p.c, PLACEHOLDER_URL + pid);
			let c = p.c;
			let created;
			if (noteType > 0 && c === 'main') {
				// 占位在正文里而样式要求引注：原位换成脚注/尾注，域放进新注
				anchor(doc, 'main', p.start, p.end).Delete();
				const kind = noteType === 2 ? 'en' : 'fn';
				const note = notes(doc, kind).Add(anchor(doc, 'main', p.start, p.start));
				if (!note) throw fail('无法在此处插入脚注/尾注。');
				shiftNotes(kind, note.Index, 1);
				c = kind + ':' + note.Index;
				remember(c, []);
				created = createField(doc, c, note.Range);
			}
			else {
				created = createField(doc, c, anchor(doc, c, p.start, p.end)); // 域覆盖占位文字
			}
			created.field.Code.Text = toStored(TEMP_CODE);
			created.field.Result.Text = p.text;
			const id = register(created.container, created.index, TEMP_CODE);
			entryOf(id).text = p.text;
			out.push(describe(doc, created.container, entryOf(id), tx.fields[id].i));
		}
		return out;
	}

	/** 把一个域在正文与脚注/尾注之间搬家（切换引注样式时调用）。沿用原来的 id。 */
	function moveField(doc, id, target) {
		const e = tx.fields[id];
		if (!e) throw fail('找不到域 ' + id);
		const srcKind = e.c === 'main' ? 'main' : noteKind(e.c);
		const dstKind = target === 0 ? 'main' : target === 1 ? 'fn' : 'en';
		if (srcKind === dstKind) return;
		const f = locate(id);
		const wire = entryOf(id).wire;
		const compiled = readSpans(f);
		let pos;
		let keepNote = false;
		if (srcKind === 'main') {
			pos = Math.max(0, f.Code.Start - 1); // 删域之后这个位置就是原域所在
		}
		else {
			const note = notes(doc, srcKind).Item(noteIndex(e.c));
			pos = note.Reference.Start; // 正文里的注号位置
			// 注里除了这条域还有别的文字时保留注本身，只把域挪走
			const rest = String(note.Range.Text ?? '').replace(compiled.text, '').replace(/[\x01\x02\r]/g, '');
			keepNote = rest.trim() !== '';
		}
		f.Delete();
		unregister(id);
		if (srcKind !== 'main' && !keepNote) {
			notes(doc, srcKind).Item(noteIndex(e.c)).Delete();
			shiftNotes(srcKind, noteIndex(e.c), -1);
		}
		let created;
		if (dstKind === 'main') {
			created = createField(doc, 'main', anchor(doc, 'main', pos, pos));
		}
		else {
			const note = notes(doc, dstKind).Add(anchor(doc, 'main', pos, pos));
			if (!note) throw fail('无法在此处插入脚注/尾注。');
			shiftNotes(dstKind, note.Index, 1);
			const c = dstKind + ':' + note.Index;
			remember(c, []);
			created = createField(doc, c, note.Range);
		}
		created.field.Code.Text = toStored(wire);
		register(created.container, created.index, wire, id);
		entryOf(id).text = compiled.text;
		writeResult(doc, created.field, compiled, created.container);
	}

	// ---------------------------------------------------------------- 分发
	//
	// 命令参数（协议 arguments 去掉首尾后的业务参数）：
	//   Document.* : [documentID, …业务参数]
	//   Field.*    : [documentID, fieldID, …业务参数]

	function dispatch(method, args) {
		const a = Array.isArray(args) ? args : [];
		if (method === 'Application.getActiveDocument') return appInfo();
		if (method === 'Document.getDocumentData') return swapFieldType(readDocumentData(cur()), 'Field', 'Http');
		if (method === 'Document.setDocumentData') return void writeDocumentData(cur(), swapFieldType(a[1], 'Http', 'Field'));
		if (method === 'Document.displayAlert') return ZW.Dialog.alert(a[1], a[2], a[3]); // 异步：等用户点按钮
		if (method === 'Document.activate') return void cur().Activate();
		if (method === 'Document.canInsertField') return cmdCanInsertField();
		if (method === 'Document.cursorInField') return cmdCursorInField();
		if (method === 'Document.insertField') return cmdInsertField(Number(a[2]) || 0);
		if (method === 'Document.getFields') return scanAll(cur());
		if (method === 'Document.setBibliographyStyle') {
			tx.bibStyle = {
				firstLineIndent: Number(a[1]) || 0,
				indent: Number(a[2]) || 0,
				lineSpacing: Number(a[3]) || 0,
				entrySpacing: Number(a[4]) || 0,
				tabStops: Array.isArray(a[5]) ? a[5].slice() : [],
				tabStopsCount: Number(a[6]) || 0,
			};
			return undefined;
		}
		if (method === 'Document.insertText') return void cmdInsertText(cur(), a[1]);
		if (method === 'Document.convert') return void moveFields(a[1], a[3]);
		if (method === 'Document.convertPlaceholdersToFields') return cmdConvertPlaceholders(cur(), a[1], Number(a[2]) || 0);
		if (method === 'Field.setCode') return void cmdSetCode(String(a[1]), a[2]);
		if (method === 'Field.setText') return void cmdSetText(cur(), String(a[1]), a[2]);
		if (method === 'Field.delete') return void cmdDelete(cur(), String(a[1]));
		if (method === 'Field.removeCode') {
			// 域变成纯文本，从 Fields 集合里消失
			const id = String(a[1]);
			const f = locate(id);
			f.Unlink();
			unregister(id);
			return undefined;
		}
		if (method === 'Field.select') {
			locate(String(a[1])).Result.Select();
			return undefined;
		}
		if (method === 'Document.importDocument' || method === 'Document.exportDocument') {
			throw fail('这份文档是由其他文字处理软件导出的 Zotero 文档，WPS 版加载项不支持导入/导出，请在 Word 里完成这一步。');
		}
		throw fail('WPS 版 Zotero 加载项不支持的操作：' + method);
	}

	/** Document.convert：fields 与 noteTypes 一一对应（Zotero 按文档序给出）。 */
	function moveFields(fieldIDs, noteTypes) {
		const ids = Array.isArray(fieldIDs) ? fieldIDs : [];
		const targets = Array.isArray(noteTypes) ? noteTypes : [];
		// 逆序处理：先动后面的域，前面域的位置就不受影响
		const doc = cur();
		for (let n = ids.length - 1; n >= 0; n--) {
			moveField(doc, String(ids[n]), Number(targets[n]) || 0);
		}
	}

	return {
		begin,
		end,
		dispatch,
		activeDocument,
		documentId,
		_internals: { toWire, toStored, swapFieldType }, // 供离线测试使用
	};
})();
