// Zotero in WPS 加载项 — 公共命名空间 + HTML → 纯文本/格式片段。
//
// WPS 加载项页面只能用传统 <script> 载入，所有模块挂在 window.ZW 下。citeproc
// 给出的引文/书目/笔记都是 HTML；Zotero 用「HTML 的 textContent」记住每条引文的
// 纯文本，刷新时拿它和文档里的可见文字比对，判断用户有没有手工改过引文。所以
// 写进文档的文字必须与 textContent 逐字一致（换行、空格都不多不少），格式则
// 以字符区间的方式另算。

var ZW = window.ZW = {};

ZW.Html = (function () {
	// 块级元素：前后是段落边界
	const BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote',
		'pre', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'section', 'article', 'aside', 'header',
		'footer', 'figure', 'figcaption', 'dl', 'dt', 'dd', 'hr', 'body', 'html', 'center', 'address']);
	// 不产出可见文字的元素
	const SKIP = new Set(['script', 'style', 'head', 'title', 'meta', 'link', 'noscript', 'template',
		'iframe', 'object', 'svg', 'img']);
	const ITALIC = new Set(['i', 'em', 'cite', 'q', 'var', 'dfn']);
	const BOLD = new Set(['b', 'strong']);
	const STRIKE = new Set(['s', 'strike', 'del']);
	const LINE_BREAK = '\x0b'; // 手动换行符（与 InsertBreak(wdLineBreak) 写入的一致）
	const PARAGRAPH = '\r';

	/** 元素自身的格式（叠加在继承格式之上）。 */
	function ownFormat(tag, el) {
		const fmt = {};
		if (ITALIC.has(tag)) fmt.italic = true;
		if (BOLD.has(tag)) fmt.bold = true;
		if (STRIKE.has(tag)) fmt.strike = true;
		if (tag === 'sup') fmt.sup = true;
		if (tag === 'sub') fmt.sub = true;
		if (tag === 'u') fmt.underline = true;
		if (tag === 'a') {
			const href = el.getAttribute('href');
			if (href) fmt.href = href;
		}
		const style = String(el.getAttribute('style') || '').replace(/\s+/g, '').toLowerCase();
		if (/(?:^|;)font-style:italic/.test(style)) fmt.italic = true;
		if (/(?:^|;)font-weight:(?:bold|[6-9]00)/.test(style)) fmt.bold = true;
		if (/(?:^|;)text-decoration:line-through/.test(style)) fmt.strike = true;
		if (/(?:^|;)text-decoration:underline/.test(style)) fmt.underline = true;
		const color = /(?:^|;)color:#([0-9a-f]{3}|[0-9a-f]{6})(?:;|$)/.exec(style);
		if (color) fmt.color = colorInt(color[1]);
		return fmt;
	}

	/** #rgb / #rrggbb → WPS/Word Font.Color 的整数。该属性按「红在低字节」排列
	 * （wdColorRed = 255、wdColorBlue = 0xFF0000），即 #rrggbb 的字节要倒过来。 */
	function colorInt(hex) {
		let digits = String(hex).replace(/^#/, '');
		if (digits.length === 3) digits = digits.split('').map((c) => c + c).join('');
		const n = parseInt(digits, 16);
		const r = (n >> 16) & 0xff;
		const g = (n >> 8) & 0xff;
		const b = n & 0xff;
		return (r | (g << 8) | (b << 16)) >>> 0;
	}

	/**
	 * 把一棵 DOM 树（已解析的文档或片段）摊平成原子序列：
	 *   {t:'t', text, fmt} 文字   {t:'b'} 段落边界   {t:'br'} 手动换行
	 */
	function flatten(root, options) {
		const atoms = [];
		const walk = (node, fmt) => {
			if (node.nodeType === 3) {
				if (node.nodeValue) atoms.push({ t: 't', text: node.nodeValue, fmt });
				return;
			}
			if (node.nodeType !== 1) return;
			const tag = node.localName.toLowerCase();
			if (SKIP.has(tag)) return;
			if (tag === 'br') {
				if (options.keepBreaks) atoms.push({ t: 'br' });
				return;
			}
			// 既无文字也无换行的块（排版用的空 div 等）不产生段落边界
			if (!String(node.textContent || '').trim() && !node.querySelector('br')) return;
			const cls = String(node.getAttribute('class') || '').split(/\s+/);
			// 书目的 second-field-align：左栏与右栏同处一段，中间补 tabCount 个制表符
			const margin = options.tabCount > 0 && cls.includes('csl-left-margin');
			const block = BLOCK.has(tag) && !margin && !cls.includes('csl-right-inline');
			if (block) atoms.push({ t: 'b' });
			const own = ownFormat(tag, node);
			const next = Object.keys(own).length ? Object.assign({}, fmt, own) : fmt;
			for (const child of node.childNodes) walk(child, next);
			if (margin) atoms.push({ t: 't', text: '\t'.repeat(options.tabCount), fmt: {} });
			if (block) atoms.push({ t: 'b' });
		};
		walk(root, {});
		return atoms;
	}

	/**
	 * 原子序列 → { text, spans }。连续的段落边界折叠成一个 \r，首尾的边界丢弃
	 * （段落标记不能出现在域结果的开头/结尾，否则会被当成域外的段落）。
	 */
	function assemble(atoms) {
		let text = '';
		const spans = [];
		let pendingBreak = false;
		let started = false;
		for (const atom of atoms) {
			if (atom.t === 'b') {
				pendingBreak = started;
				continue;
			}
			const piece = atom.t === 'br' ? LINE_BREAK : atom.text;
			if (!piece) continue;
			// 只含换行的空白文本是排版缩进，不是内容
			if (atom.t === 't' && /[\r\n]/.test(piece) && /^\s*$/.test(piece)) continue;
			if (pendingBreak) {
				text += PARAGRAPH;
				pendingBreak = false;
			}
			if (atom.t === 't' && Object.keys(atom.fmt).length) {
				spans.push({ start: text.length, end: text.length + piece.length, fmt: atom.fmt });
			}
			text += piece;
			started = true;
		}
		return { text, spans };
	}

	/** 从已解析的 DOM 节点编译（测试环境可直接喂自建的节点树）。 */
	function fromNode(root, options = {}) {
		return assemble(flatten(root, {
			keepBreaks: options.keepBreaks === true,
			tabCount: Number(options.tabCount) || 0,
		}));
	}

	/** 从 HTML 字符串编译。 */
	function compile(html, options = {}) {
		const doc = new DOMParser().parseFromString(String(html ?? ''), 'text/html');
		return fromNode(doc.body, options);
	}

	return { compile, fromNode, colorInt, LINE_BREAK, PARAGRAPH };
})();
