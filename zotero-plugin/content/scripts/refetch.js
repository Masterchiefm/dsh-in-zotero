// dsh-in-zotero — the "AI重新获取元数据" context-menu action: hands the
// selected items to the dsh agent, ONE fresh session per item (task histories
// never share a conversation); each agent re-reads the attachment, searches
// online, and writes every field back through the bridge (Zotero's own APIs).

DSH.Refetch = (() => {
	const { log, toast } = DSH.Util;

	const MENU_ID = 'dsh-in-zotero-refetch-menu';

	async function dispatch(items) {
		// Two kinds of targets: regular items (metadata rewritten in place)
		// and standalone attachments (no parent item — the agent identifies
		// the work, creates a proper parent item, and pulls the attachment
		// into it via zotero_add's adoptAttachmentIDs).
		const targets = items
			.map(item => {
				if (item?.isRegularItem?.()) {
					return {
						id: item.id,
						key: item.key,
						title: item.getDisplayTitle?.() ?? '',
						itemType: Zotero.ItemTypes.getName(item.itemTypeID),
						doi: String(item.getField('DOI', false, true) ?? ''),
						attachmentID: (() => {
							try { return (item.getAttachments() ?? [])[0] ?? null; }
							catch (e) { return null; }
						})(),
					};
				}
				if (item?.isAttachment?.() && !item.parentItemID) {
					return {
						id: item.id,
						key: item.key,
						title: item.getDisplayTitle?.() ?? item.attachmentFilename ?? '',
						itemType: 'attachment',
						doi: '',
						attachmentID: item.id,
						standalone: true,
					};
				}
				return null;
			})
			.filter(Boolean);
		if (targets.length === 0) {
			toast('AI 重新获取元数据', '选中的条目中没有文献条目或未识别的独立附件');
			return;
		}

		const progress = toast('AI 重新获取元数据', DSH.Sidecar.withColdHint('正在启动 dsh…'));
		try {
			await DSH.Sidecar.ensureStarted({ onStatus: (s) => progress.update(s) });
			const result = await DSH.Sidecar.plugin('task.refetch', { items: targets });
			progress.done(`已派出 ${result.count ?? result.items?.length ?? targets.length} 个独立任务（每条文献一个新会话，可在 DSH 会话列表查看）`);
			// Surface the first running agent; the rest sit in the session list.
			const first = result.items?.[0]?.sessionId ?? result.sessionId;
			if (first) {
				void DSH.SessionWindow.openOnSession(first, { title: result.items?.[0]?.title }).catch((e) => log('open session window failed', e));
			}
		}
		catch (e) {
			log('refetch dispatch failed', e);
			progress.error(`失败：${e.message}`);
		}
	}

	function onCommand() {
		try {
			const pane = Zotero.getActiveZoteroPane();
			const items = pane?.getSelectedItems?.() ?? [];
			void dispatch(items);
		}
		catch (e) {
			log('refetch command failed', e);
		}
	}

	function ensureMenuItem(win) {
		const menu = win.document.getElementById('zotero-itemmenu');
		if (!menu || win.document.getElementById(MENU_ID)) return;
		const separator = win.document.createXULElement('menuseparator');
		separator.id = MENU_ID + '-separator';
		const item = win.document.createXULElement('menuitem');
		item.id = MENU_ID;
		item.setAttribute('label', 'AI重新获取元数据（DSH）');
		item.setAttribute('class', 'menuitem-iconic');
		item.setAttribute('style', `list-style-image: url(chrome://dsh-in-zotero/content/icons/icon.svg)`);
		item.addEventListener('command', onCommand);
		menu.appendChild(separator);
		menu.appendChild(item);
		menu.addEventListener('popupshowing', () => {
			try {
				const pane = win.ZoteroPane;
				const items = pane?.getSelectedItems?.() ?? [];
				const hasTarget = items.some(i => i?.isRegularItem?.()
					|| (i?.isAttachment?.() && !i.parentItemID));
				item.hidden = !hasTarget;
				separator.hidden = !hasTarget;
			}
			catch (e) { /* leave visible */ }
		}, { once: false });
	}

	return { ensureMenuItem, dispatch };
})();
