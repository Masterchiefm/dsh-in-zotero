// dsh-in-zotero — the "译" button in the reader's text-selection popup.
// Streams a translation from the dsh sidecar's own LLM route and renders it
// inside a section appended to the popup. An "自动" chip next to the button
// toggles auto-translate-on-selection (persisted); when auto mode is on and
// dsh is already warm, the translation starts the moment text is selected.
//
// Layout notes (the reader wraps EVERY append() call in a bordered
// <div class="section"> — that was the "two lines" under the button): we
// append exactly ONE root containing buttons + output and strip the wrapper's
// separator, so no lines are drawn. Long output widens the popup instead of
// stretching it tall: on overflow the section grows (up to the viewport) by
// lifting both its own and the .selection-popup ancestor's max-width.

DSH.Translate = (() => {
	const { log, toast } = DSH.Util;

	// One live translation per reader instance; a genuinely new selection
	// aborts it. The entry carries the selection text so a popup RE-RENDER
	// (Zotero wipes ALL plugin sections and re-dispatches on every scroll /
	// view update while a selection popup is open — the popup's rect updates
	// go through React state) can be told apart from a new selection: a
	// re-render re-attaches the LIVE section (the stream keeps writing into
	// the re-parented node) instead of aborting + restarting the request.
	// The old restart-on-every-render loop is what made the「自动」toggle
	// impossible to click (its DOM kept being replaced between mousedown and
	// click while auto-translate was on) and made the stream flicker/reset.
	const active = new Map(); // readerKey -> { text, section, stop?, cancelled?, width? }

	// Width ladder for the auto-widen behavior (px). START mirrors the CSS
	// default below; the popup's own max-width (198px in reader.css) is lifted
	// alongside so the ladder can actually engage.
	const WIDTH_START = 340;
	const WIDTH_MAX = 640;

	const STYLE = `
.dsh-translate-button {
	display: inline-flex; align-items: center; justify-content: center;
	min-width: 40px; height: 24px; margin: 0 2px; padding: 0 12px;
	border: 1px solid var(--color-accent);
	border-radius: 999px; background: var(--color-accent); color: #fff;
	font-size: 13px; font-weight: 600; line-height: 1; cursor: pointer;
	box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
}
.dsh-translate-button:hover { filter: brightness(1.08); }
.dsh-translate-button:active { filter: brightness(0.92); }
.dsh-translate-button.running { opacity: 0.85; }
.dsh-translate-auto {
	display: inline-flex; align-items: center; gap: 5px;
	height: 24px; margin: 0 2px; padding: 0 8px;
	border: 1px solid var(--fill-tertiary); border-radius: 999px;
	background: transparent; color: var(--fill-secondary);
	font-size: 11.5px; line-height: 1; cursor: pointer; user-select: none;
}
.dsh-translate-auto:hover { background: var(--fill-quinary); }
.dsh-auto-label { flex: none; }
.dsh-auto-track {
	position: relative; width: 24px; height: 13px; border-radius: 7px;
	background: var(--fill-quarternary); flex: none;
	transition: background 0.15s ease;
}
.dsh-auto-track::after {
	content: ''; position: absolute; top: 1.5px; left: 2px;
	width: 10px; height: 10px; border-radius: 50%;
	background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
	transition: left 0.15s ease;
}
.dsh-translate-ask {
	display: inline-flex; align-items: center;
	height: 24px; margin: 0 2px; padding: 0 9px;
	border: 1px solid var(--fill-tertiary); border-radius: 999px;
	background: transparent; color: var(--fill-secondary);
	font-size: 11.5px; font-weight: 600; line-height: 1; cursor: pointer; user-select: none;
}
.dsh-translate-ask:hover { background: var(--fill-quinary); color: var(--fill-primary); }
.dsh-translate-ask:active { filter: brightness(0.92); }
.dsh-translate-ask[disabled] { opacity: 0.6; cursor: default; }
.dsh-translate-auto[aria-pressed="true"] {
	border-color: var(--color-accent); color: var(--fill-primary);
}
.dsh-translate-auto[aria-pressed="true"] .dsh-auto-track { background: var(--color-accent); }
.dsh-translate-auto[aria-pressed="true"] .dsh-auto-track::after { left: 12px; }
.dsh-auto-state {
	min-width: 12px; text-align: center; flex: none;
	color: var(--fill-secondary); font-weight: 600;
}
.dsh-translate-auto[aria-pressed="true"] .dsh-auto-state { color: var(--color-accent); }
.dsh-translate-section {
	max-width: ${WIDTH_START}px; max-height: 280px; overflow-y: auto;
	padding: 2px; margin-top: 5px;
	font-size: 13px; line-height: 1.5; color: var(--fill-primary);
	white-space: pre-wrap; word-break: break-word;
}
.dsh-translate-section .dsh-status { display: flex; align-items: center; min-height: 16px; }
.dsh-translate-section .dsh-status .dsh-waking {
	color: var(--fill-secondary); font-size: 12px; margin-inline-start: 6px;
}
.dsh-translate-section .dsh-error { color: var(--color-red); }
.dsh-translate-section .dsh-busy {
	width: 14px; height: 14px; border-radius: 50%;
	border: 2px solid var(--fill-quinary); border-top-color: var(--fill-secondary);
	animation: dsh-spin 0.8s linear infinite;
}
.dsh-think { margin-bottom: 4px; }
.dsh-think-head {
	display: inline-flex; align-items: center; gap: 5px;
	padding: 0; border: 0; background: transparent;
	color: var(--fill-secondary); font-size: 12px; cursor: pointer;
}
.dsh-think-caret { flex: none; transition: transform 0.15s ease; }
.dsh-think.collapsed .dsh-think-caret { transform: rotate(-90deg); }
.dsh-think-mini {
	width: 10px; height: 10px; border-radius: 50%; flex: none;
	border: 2px solid var(--fill-quinary); border-top-color: var(--fill-secondary);
	animation: dsh-spin 0.8s linear infinite;
}
.dsh-think-body {
	max-height: 120px; overflow-y: auto; margin-top: 3px;
	padding-left: 6px; border-left: 2px solid var(--fill-quarternary);
	color: var(--fill-secondary); font-size: 12px; line-height: 1.45;
	white-space: pre-wrap; word-break: break-word;
}
.dsh-think.collapsed .dsh-think-body { display: none; }
.dsh-no-think { margin-top: 4px; color: var(--fill-secondary); font-size: 11.5px; }
.dsh-actions { margin-top: 6px; }
.dsh-action-btn {
	display: inline-flex; align-items: center;
	height: 22px; padding: 0 10px;
	border: 1px solid var(--color-accent); border-radius: 999px;
	background: transparent; color: var(--color-accent);
	font-size: 12px; font-weight: 600; line-height: 1; cursor: pointer;
}
.dsh-action-btn:hover { background: var(--fill-quinary); }
.dsh-action-btn[disabled] { opacity: 0.55; cursor: default; }
.dsh-action-btn[disabled]:hover { background: transparent; }
.dsh-action-btn.done { color: var(--fill-secondary); border-color: var(--fill-tertiary); }
@keyframes dsh-spin { to { transform: rotate(360deg); } }
`;

	function ensureStyle(doc) {
		if (doc.getElementById('dsh-translate-style')) return;
		const style = doc.createElement('style');
		style.id = 'dsh-translate-style';
		style.textContent = STYLE;
		doc.documentElement.appendChild(style);
	}

	function abortActive(readerKey) {
		const entry = active.get(readerKey);
		if (!entry) return;
		entry.cancelled = true;
		try { entry.stop?.(); } catch (e) { /* already stopped */ }
		active.delete(readerKey);
	}

	/**
	 * The renderTextSelectionPopup listener body.
	 * @param {{reader: object, doc: Document, params: {annotation: {text: string}}, append: Function}} event
	 */
	function onRenderTextSelectionPopup(event) {
		const { reader, doc, params, append } = event;
		if (!DSH.Util.prefGet('translateEnabled', true)) return;
		const text = params?.annotation?.text;
		if (!text || !text.trim()) return;
		const readerKey = reader?._tabID ?? reader?.tabID ?? reader?.itemID ?? 'default';
		const prev = active.get(readerKey);
		// Same selection rendered again (the popup got wiped by a scroll/view
		// update)? Resume: keep the live section. Anything else is new.
		const resumed = !!(prev && prev.text === text && prev.section);
		if (!resumed) abortActive(readerKey);

		ensureStyle(doc);
		const entry = resumed ? prev : { text, section: null, stop: null, cancelled: false, width: WIDTH_START };
		if (!resumed) active.set(readerKey, entry);

		// Single root for buttons + output: the reader wraps each append() in
		// its own bordered ".section", so appending twice drew two separators.
		const root = doc.createElement('div');
		root.className = 'dsh-translate-root';

		const section = resumed ? prev.section : doc.createElement('div');
		if (resumed) {
			// The stream (if still running) keeps writing into this element.
			section.style.display = 'block';
		}
		else {
			section.className = 'dsh-translate-section';
			section.style.display = 'none';
			entry.section = section;
		}

		const button = doc.createElement('button');
		button.className = 'dsh-translate-button';
		button.title = 'DSH 翻译（流式）';
		button.textContent = '译';

		// Auto-translate toggle switch: persisted, applies to every future
		// selection. Shows an explicit 开/关 state next to the lever.
		const auto = doc.createElement('button');
		auto.className = 'dsh-translate-auto';
		auto.title = '自动翻译：开启后划选文字立即翻译（dsh 未运行时会自动唤起）';
		const autoLabel = doc.createElement('span');
		autoLabel.className = 'dsh-auto-label';
		autoLabel.textContent = '自动';
		const autoTrack = doc.createElement('span');
		autoTrack.className = 'dsh-auto-track';
		const autoState = doc.createElement('span');
		autoState.className = 'dsh-auto-state';
		const paintAuto = () => {
			const on = DSH.Util.prefGet('translateAuto', false);
			auto.setAttribute('aria-pressed', on ? 'true' : 'false');
			autoState.textContent = on ? '开' : '关';
		};
		paintAuto();
		auto.append(autoLabel, autoTrack, autoState);
		auto.addEventListener('click', () => {
			const on = !DSH.Util.prefGet('translateAuto', false);
			DSH.Util.prefSet('translateAuto', on);
			paintAuto();
			if (on && !section.textContent) run();
		});

		// 「问 AI」：把所选文字送进本文绑定会话的输入框（不发送）——问题由
		// 用户自己补全后手动发送。走 SessionWindow 的 reader 绑定：无绑定则
		// 静默新建并绑定（与标签跟随同一语义），面板同时弹出显示该会话。
		const ask = doc.createElement('button');
		ask.className = 'dsh-translate-ask';
		ask.title = '把这段话送进本文的 DSH 会话输入框（不发送，问题由你补全后自己发送）';
		ask.textContent = '问AI';
		ask.addEventListener('click', () => {
			if (ask.disabled) return;
			ask.disabled = true;
			ask.textContent = '…';
			void (async () => {
				try {
					const delivered = await DSH.SessionWindow.open('reader', reader.itemID, { askText: text });
					if (!DSH.Sidecar.state.bridgeOk) {
						toast('DSH 问AI', '外部 dsh 实例无桥接，已打开会话；所选文字无法自动填入，请手动粘贴');
					}
					else if (delivered === false) {
						toast('DSH 问AI', '已打开会话，但输入框未自动填入（可重试一次）');
					}
				}
				catch (e) {
					log('ask button failed', e?.message ?? e);
					toast('DSH 问AI', `打开会话失败：${e?.message ?? e}`);
				}
				finally {
					ask.disabled = false;
					ask.textContent = '问AI';
				}
			})();
		});

		// --- auto-widen -----------------------------------------------------
		// reader.css caps .selection-popup at 198px, so long translations used
		// to pile into a tall narrow column. Track the section width and grow
		// it (together with the popup's cap) whenever the content overflows
		// the height limit — the text reflows wider instead of taller.
		let width = resumed && Number(prev.width) > 0 ? prev.width : WIDTH_START;
		let fitPending = false;
		const popupEl = () => {
			try { return section.closest('.selection-popup'); }
			catch (e) { return null; }
		};
		const applyWidth = (w) => {
			width = w;
			entry.width = w; // survives popup re-renders (resume path)
			section.style.maxWidth = `${w}px`;
			// 20px covers .selection-popup's own padding (8×2) + rounding.
			const popup = popupEl();
			if (popup) popup.style.maxWidth = `${w + 20}px`;
		};
		const fitWidth = () => {
			if (section.scrollHeight <= section.clientHeight + 1) return;
			const vw = doc.documentElement?.clientWidth || WIDTH_MAX;
			const cap = Math.max(WIDTH_START, Math.min(WIDTH_MAX, vw - 16));
			while (width < cap && section.scrollHeight > section.clientHeight + 1) {
				applyWidth(Math.min(cap, width + 100));
			}
		};
		const scheduleFit = () => {
			if (fitPending || section.style.display === 'none') return;
			fitPending = true;
			const raf = doc.defaultView?.requestAnimationFrame?.bind(doc.defaultView);
			if (!raf) {
				fitPending = false;
				try { fitWidth(); } catch (e) { /* transient layout */ }
				return;
			}
			raf(() => {
				fitPending = false;
				try { fitWidth(); } catch (e) { /* transient layout */ }
			});
		};

		// --- collapsible thinking --------------------------------------------
		let think = null; // { box, label, body, mini }
		const ensureThink = () => {
			if (think) return think;
			const box = doc.createElement('div');
			box.className = 'dsh-think';
			const head = doc.createElement('button');
			head.type = 'button';
			head.className = 'dsh-think-head';
			head.title = '点击展开/收起思考内容';
			const mini = doc.createElement('span');
			mini.className = 'dsh-think-mini';
			const caret = doc.createElement('span');
			caret.className = 'dsh-think-caret';
			caret.textContent = '▾';
			const label = doc.createElement('span');
			label.className = 'dsh-think-label';
			label.textContent = '思考中…';
			head.append(mini, caret, label);
			const body = doc.createElement('div');
			body.className = 'dsh-think-body';
			head.addEventListener('click', () => box.classList.toggle('collapsed'));
			box.append(head, body);
			section.appendChild(box);
			think = { box, label, body, mini };
			return think;
		};
		// "思考结束" = the first answer token: collapse automatically (the
		// header stays as a one-line toggle for re-reading).
		const collapseThink = () => {
			if (!think) return;
			think.box.classList.add('collapsed');
			think.label.textContent = '已深度思考';
			try { think.mini.remove(); } catch (e) { /* already gone */ }
		};
		const appendThink = (t) => {
			const el = ensureThink();
			el.body.textContent += t ?? '';
			el.body.scrollTop = el.body.scrollHeight;
		};

		const run = () => {
			// 译 click (or auto-fire) on a section that may already stream:
			// stop the live request first, then reset. `gen` supersedes a
			// start() that is still mid-ensureStarted.
			const gen = (entry.gen = (entry.gen ?? 0) + 1);
			try { entry.stop?.(); } catch (e) { /* already stopped */ }
			entry.stop = null;
			section.style.display = 'block';
			button.classList.add('running');
			section.textContent = '';
			think = null;
			// No "connecting" text — just a quiet spinner until the first token.
			const status = doc.createElement('div');
			status.className = 'dsh-status';
			const spinner = doc.createElement('div');
			spinner.className = 'dsh-busy';
			status.appendChild(spinner);
			section.appendChild(status);

			let answerEl = null;
			let actionsEl = null;
			let answerText = '';
			let sawThinking = false;
			const thinkingRequested = !!DSH.Util.prefGet('translateThinking', false);
			// '' (or unset) = inherit dsh's current model selection; otherwise a
			// 'provider/model' id chosen in the settings pane.
			const translateModel = String(DSH.Util.prefGet('translateModel', '') || '').trim();
			const renderAnswer = () => {
				if (!answerEl) {
					collapseThink();
					answerEl = doc.createElement('div');
					answerEl.className = 'dsh-answer';
					section.appendChild(answerEl);
					status.remove();
				}
			};
			// 「添加到评论」：给选段落下划线批注，译文写进批注评论。
			const showActions = () => {
				if (actionsEl || !answerText.trim()) return;
				actionsEl = doc.createElement('div');
				actionsEl.className = 'dsh-actions';
				const addBtn = doc.createElement('button');
				addBtn.type = 'button';
				addBtn.className = 'dsh-action-btn';
				addBtn.title = '在 PDF 中为所选文字添加下划线批注，并把译文写入批注评论';
				addBtn.textContent = '添加到评论';
				addBtn.addEventListener('click', async () => {
					if (addBtn.disabled) return;
					addBtn.disabled = true;
					addBtn.textContent = '保存中…';
					try {
						await DSH.Bridge.annotateReaderText({
							reader,
							text,
							comment: answerText.trim(),
							type: 'underline',
						});
						if (!doc.contains(section)) return; // popup dismissed
						addBtn.textContent = '已添加到评论 ✓';
						addBtn.classList.add('done');
					}
					catch (e) {
						log('add-to-comment failed', e?.message ?? String(e));
						if (!doc.contains(section)) return;
						addBtn.disabled = false;
						addBtn.textContent = '添加到评论';
						toast('DSH 翻译', `添加失败：${e?.message ?? e}`);
					}
				});
				actionsEl.appendChild(addBtn);
				section.appendChild(actionsEl);
				scheduleFit();
			};

			const start = async () => {
				try {
					if (!DSH.Sidecar.isReady()) {
						// Cold start: tell the user WHY nothing streams yet (the
						// sidecar may be installing/booting for up to a minute),
						// and that the wait is a first-load-only cost.
						const waking = doc.createElement('div');
						waking.className = 'dsh-waking';
						waking.textContent = DSH.Sidecar.withColdHint('正在唤起 dsh 服务…');
						status.appendChild(waking);
						try {
							await DSH.Sidecar.ensureStarted({
								onStatus: (s) => {
									if (s && doc.contains(waking)) waking.textContent = s;
								},
							});
						}
						finally {
							try { waking.remove(); } catch (e) { /* popup gone */ }
						}
					}
				}
				catch (e) {
					status.remove();
					const err = doc.createElement('div');
					err.className = 'dsh-error';
					err.textContent = `dsh 启动失败：${e.message}`;
					section.appendChild(err);
					return;
				}
				// Superseded (re-translate) or cancelled (new selection) while
				// the sidecar was starting? Bail before creating the request.
				if (entry.gen !== gen || entry.cancelled || !doc.contains(section)) return;
				const stop = DSH.Sidecar.translateStream(
					text,
					(evt) => {
						if (!doc.contains(section)) {
							// The popup was dismissed (or a new selection rebuilt
							// it) — stop streaming, but only tear down the entry
							// if it is still the live one for this reader.
							if (active.get(readerKey) === entry) abortActive(readerKey);
							return;
						}
						if (evt.type === 'thinking') {
							sawThinking = true;
							appendThink(evt.text ?? '');
							scheduleFit();
						}
						else if (evt.type === 'answer') {
							renderAnswer();
							answerText += evt.text ?? '';
							answerEl.textContent = answerText;
							scheduleFit();
						}
						else if (evt.type === 'done') {
							renderAnswer();
							button.classList.remove('running');
							if (!answerEl.textContent) answerEl.textContent = '(模型未返回内容)';
							// 深度思考开关开着但模型没思考（不支持/未触发）——
							// 顺手说明，免得用户以为功能丢了。
							if (thinkingRequested && !sawThinking && answerText.trim()) {
								const hint = doc.createElement('div');
								hint.className = 'dsh-no-think';
								hint.textContent = '（当前模型未返回思考内容）';
								section.appendChild(hint);
							}
							showActions();
							scheduleFit();
						}
						else if (evt.type === 'error') {
							status.remove();
							button.classList.remove('running');
							const err = doc.createElement('div');
							err.className = 'dsh-error';
							err.textContent = `翻译失败：${evt.message ?? ''}`;
							section.appendChild(err);
						}
					},
					{ thinking: thinkingRequested, model: translateModel }
				);
				if (entry.gen !== gen) {
					// Another run() superseded this one while it was starting.
					try { stop(); } catch (e) { /* already stopped */ }
					return;
				}
				entry.stop = stop;
				if (entry.cancelled) {
					try { stop(); } catch (e) { /* already stopped */ }
				}
			};
			void start();
		};

		button.addEventListener('click', run);
		const row = doc.createElement('div');
		row.style.display = 'inline-flex';
		row.style.alignItems = 'center';
		row.appendChild(button);
		row.appendChild(auto);
		row.appendChild(ask);
		root.appendChild(row);
		root.appendChild(section);
		append(root);
		// The reader's wrapper ("div.section") draws a border-top separator —
		// the remaining one of the "two lines". Strip it; spacing comes from
		// the section's own margin.
		const wrap = root.parentNode;
		if (wrap?.classList?.contains('section')) {
			wrap.style.borderTop = '0';
			wrap.style.paddingTop = '0';
			wrap.style.paddingBottom = '0';
		}
		if (resumed) {
			// React rebuilt the .selection-popup ancestor — re-apply the width
			// ladder to the NEW popup and re-fit; the live (or finished)
			// translation section above keeps its content.
			applyWidth(width);
			scheduleFit();
		}
		else if (DSH.Util.prefGet('translateAuto', false)) {
			// Auto mode fires immediately on every new selection — including a
			// cold start. run()/start() boot the sidecar via ensureStarted()
			// when needed (with an inline "正在唤起 dsh 服务…" hint). Re-renders
			// of the same selection are handled by the resume path above and
			// never restart the request.
			run();
		}
	}

	function register() {
		Zotero.Reader.registerEventListener(
			'renderTextSelectionPopup',
			(event) => {
				try {
					onRenderTextSelectionPopup(event);
				}
				catch (e) {
					log('translate popup render failed', e);
				}
			},
			ctx.ID
		);
	}

	return { register };
})();
