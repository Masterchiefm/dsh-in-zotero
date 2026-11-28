// dsh-in-zotero — the Zotero bridge: local HTTP endpoints on Zotero's own
// server (port 23119) that the dsh sidecar's agent tools call. EVERY write
// goes through Zotero's official APIs (item.setField / saveTx / Attachments.*),
// so the Zotero database is never opened or locked by this plugin.

DSH.Bridge = (() => {
	const { log } = DSH.Util;
	const PREFIX = '/dsh-bridge/';
	const TOKEN_HEADER = 'x-dsh-in-zotero-token';

	function token() {
		return DSH.Sidecar.bridgeToken();
	}

	// ---------------------------------------------------------------- helpers

	function fail(code, message) {
		const error = new Error(message);
		error.code = code;
		return error;
	}

	function userLibraryID() {
		return Zotero.Libraries.userLibraryID;
	}

	async function getItem(id, { mustExist = true } = {}) {
		const numeric = Number(id);
		if (!Number.isInteger(numeric) || numeric <= 0) throw fail('zotero/invalid-id', `无效的条目 id: ${id}`);
		const item = Zotero.Items.get(numeric);
		if (mustExist && (!item || !item.id)) throw fail('zotero/no-item', `找不到条目 id ${numeric}`);
		return item;
	}

	function creatorRow(creator) {
		return {
			creatorType: creator.creatorType,
			firstName: creator.firstName ?? '',
			lastName: creator.lastName ?? '',
			fieldMode: creator.fieldMode === 1 ? 1 : 0,
		};
	}

	/** Compact summary row used by search results and listings. */
	function summaryRow(item) {
		const creators = (item.getCreators?.() ?? []).map(creatorRow);
		const firstAuthor = creators.find(c => c.creatorType === 'author') ?? creators[0];
		return {
			id: item.id,
			key: item.key,
			itemType: Zotero.ItemTypes.getName(item.itemTypeID),
			title: item.getDisplayTitle?.() ?? '',
			creator: firstAuthor ? (firstAuthor.fieldMode === 1
				? firstAuthor.lastName
				: `${firstAuthor.lastName}, ${firstAuthor.firstName}`.replace(/^, /, '').trim()) : '',
			year: String(item.getField('date', false, true) ?? '').slice(0, 4),
			hasAttachment: !!(item.isRegularItem?.() && item.getAttachments?.().length),
		};
	}

	function attachmentInfo(att) {
		let path = null;
		try {
			path = att.getFilePath?.() ?? null; // sync variant; async resolved below when needed
		}
		catch (e) { path = null; }
		return {
			id: att.id,
			key: att.key,
			title: att.getField('title') || att.attachmentFilename || '',
			contentType: att.attachmentContentType ?? '',
			linkMode: att.attachmentLinkMode,
			linkModeName: ['importedFile', 'importedUrl', 'linkedFile', 'linkedUrl', 'embeddedImage'][att.attachmentLinkMode] ?? String(att.attachmentLinkMode),
			path,
			url: att.getField('url') || '',
		};
	}

	function detailedItem(item) {
		const fields = {};
		try {
			for (const field of item.getUsedFields?.(true) ?? []) {
				const value = item.getField(field, false, true);
				if (value !== false && value !== '' && value !== null && value !== undefined) fields[field] = String(value);
			}
		}
		catch (e) {
			log('getUsedFields failed', e);
		}
		const attachments = [];
		const notes = [];
		if (item.isRegularItem?.()) {
			for (const childID of item.getAttachments()) {
				const child = Zotero.Items.get(childID);
				if (child?.isAttachment()) attachments.push(attachmentInfo(child));
			}
			for (const noteID of item.getNotes()) {
				const note = Zotero.Items.get(noteID);
				if (note) notes.push({ id: note.id, key: note.key, date: note.getField('dateAdded'), text: (note.note ?? '').slice(0, 500) });
			}
		}
		else if (item.isAttachment()) {
			attachments.push(attachmentInfo(item));
		}
		else if (item.isNote()) {
			notes.push({ id: item.id, key: item.key, date: item.getField('dateAdded'), text: (item.note ?? '').slice(0, 500) });
		}
		const parentID = item.parentItemID ?? null;
		return {
			id: item.id,
			key: item.key,
			libraryID: item.libraryID,
			itemType: Zotero.ItemTypes.getName(item.itemTypeID),
			title: item.getDisplayTitle?.() ?? '',
			creators: (item.getCreators?.() ?? []).map(creatorRow),
			fields,
			tags: (item.getTags?.() ?? []).map(t => t.tag),
			collections: (item.getCollections?.() ?? []),
			parentID,
			attachments,
			notes,
			dateAdded: item.getField('dateAdded'),
			dateModified: item.getField('dateModified'),
		};
	}

	// ---------------------------------------------------------------- ops

	async function opStatus() {
		// recursive=true: count EVERY collection, not just top-level ones (the
		// non-recursive form filters on !parentKey — see opCollections).
		const collections = Zotero.Collections.getByLibrary(userLibraryID(), true, false) ?? [];
		let itemCount = 0;
		try {
			const s = new Zotero.Search();
			s.addCondition('libraryID', 'is', userLibraryID());
			s.addCondition('noChildren', 'true');
			itemCount = (await s.search()).length;
		}
		catch (e) { /* keep 0 */ }
		return {
			ok: true,
			zoteroVersion: Zotero.version,
			serverPort: DSH.Util.httpServerPort(), // raw getter throws when server is off
			items: itemCount,
			collections: collections.length,
		};
	}

	async function opSearch(payload = {}) {
		const query = String(payload.query ?? '').trim();
		const collectionID = Number.isInteger(payload.collectionID) ? payload.collectionID : null;
		const tag = String(payload.tag ?? '').trim();
		const limit = Math.min(Math.max(Number(payload.limit) || 50, 1), 200);
		const libraryID = payload.libraryID === 'all' ? null : (Number.isInteger(payload.libraryID) ? payload.libraryID : userLibraryID());

		let candidates = [];
		const useSearch = query !== '' && !collectionID && !tag;
		if (useSearch) {
			try {
				const s = new Zotero.Search();
				if (libraryID !== null) s.addCondition('libraryID', 'is', libraryID);
				s.addCondition('quicksearch-everything', 'contains', query);
				const ids = await s.search();
				candidates = ids.map(id => Zotero.Items.get(id)).filter(Boolean);
			}
			catch (e) {
				log('Zotero.Search failed, falling back to scan', e);
				candidates = [];
			}
		}
		if (candidates.length === 0) {
			// Full scan fallback (also the path for collection/tag filters).
			const libraries = libraryID === null
				? (Zotero.Libraries.getAll().map(l => l.libraryID))
				: [libraryID];
			for (const lib of libraries) {
				try {
					candidates.push(...(await Zotero.Items.getAll(lib, false, false, false)));
				}
				catch (e) {
					log(`Items.getAll(${lib}) failed`, e);
				}
			}
		}

		const needle = query.toLowerCase();
		const rows = [];
		const seen = new Set();
		for (const item of candidates) {
			if (!item?.id || seen.has(item.id)) continue;
			seen.add(item.id);
			if (collectionID !== null && !(item.getCollections?.() ?? []).includes(collectionID)) continue;
			if (tag && !(item.getTags?.() ?? []).some(t => t.tag === tag)) continue;
			if (needle) {
				const hay = [
					item.getDisplayTitle?.() ?? '',
					(item.getCreators?.() ?? []).map(c => `${c.firstName} ${c.lastName}`).join(' '),
					String(item.getField('DOI', false, true) ?? ''),
					String(item.getField('url', false, true) ?? ''),
					(item.getTags?.() ?? []).map(t => t.tag).join(' '),
				].join(' ').toLowerCase();
				if (!hay.includes(needle)) continue;
			}
			rows.push(summaryRow(item));
			if (rows.length >= limit) break;
		}
		return {
			ok: true,
			items: rows,
			hint: rows.length === 0
				? '没有匹配结果。可换用关键词变体重试（同义词、英文、单复数、可能的手误），或用 query="" 配合 collectionID/tag 浏览。'
				: '',
		};
	}

	async function opItem(payload = {}) {
		const item = await getItem(payload.id);
		const data = detailedItem(item);
		// Resolve real attachment paths asynchronously (getFilePath is async).
		for (const att of data.attachments) {
			try {
				const child = Zotero.Items.get(att.id);
				att.path = (await child?.getFilePathAsync?.()) ?? null;
			}
			catch (e) { att.path = att.path ?? null; }
		}
		if (item.isRegularItem?.()) {
			try {
				const best = await item.getBestAttachment();
				data.bestAttachmentID = best?.id ?? null;
			}
			catch (e) {
				data.bestAttachmentID = null;
			}
		}
		return { ok: true, item: data };
	}

	async function opCollections() {
		const libraryID = userLibraryID();
		// recursive=true is what makes subcollections appear at all: the
		// non-recursive form of getByLibrary returns TOP-LEVEL collections
		// only (it filters on !parentKey), which used to hide every nested
		// collection from the agent. The recursive walk yields parents before
		// their descendants, so both views below come out in tree order.
		const all = Zotero.Collections.getByLibrary(libraryID, true, false) ?? [];
		const byID = new Map(all.map((c) => [c.id, c]));
		const childCollections = new Map();
		const itemCount = new Map();
		for (const c of all) {
			if (c.parentID) childCollections.set(c.parentID, (childCollections.get(c.parentID) ?? 0) + 1);
			try {
				itemCount.set(c.id, c.getChildItems(true).length);
			}
			catch (e) { itemCount.set(c.id, 0); }
		}
		const nameOf = (c) => String(c.name ?? '');
		// Full path ("父 / 子 / 孙") + 0-based depth, computed from the parent
		// chain rather than Zotero's optional .level expando.
		const pathOf = (c) => {
			const parts = [nameOf(c)];
			let parent = c.parentID ? byID.get(c.parentID) : null;
			for (let guard = 0; parent && guard < 32; guard++) {
				parts.unshift(nameOf(parent));
				parent = parent.parentID ? byID.get(parent.parentID) : null;
			}
			return { path: parts.join(' / '), level: parts.length - 1 };
		};
		const rows = all.map((c) => {
			const { path, level } = pathOf(c);
			return {
				id: c.id,
				key: c.key,
				name: c.name,
				parentID: c.parentID ?? null,
				path,
				level,
				subcollections: childCollections.get(c.id) ?? 0,
				items: itemCount.get(c.id) ?? 0,
			};
		});
		// Same data as a nested tree — the agent sees the full hierarchy in
		// one shot instead of reconstructing it from parentIDs.
		const treeOf = (parentID) => all
			.filter((c) => (c.parentID || null) === parentID)
			.map((c) => ({
				id: c.id,
				name: nameOf(c),
				items: itemCount.get(c.id) ?? 0,
				children: treeOf(c.id),
			}));
		return { ok: true, collections: rows, tree: treeOf(null) };
	}

	async function opRead(payload = {}) {
		let item = await getItem(payload.id);
		if (item.isRegularItem?.()) {
			const best = await item.getBestAttachment();
			if (!best) throw fail('zotero/no-attachment', `条目「${item.getDisplayTitle()}」没有可用附件`);
			item = best;
		}
		if (!item.isAttachment()) throw fail('zotero/not-attachment', '该条目不是附件，无法读取全文');
		const path = await item.getFilePathAsync();
		if (!path) {
			return {
				ok: true,
				kind: 'url',
				url: item.getField('url') || '',
				note: '该附件没有本地文件（链接型 URL 附件），请用 url。',
			};
		}

		let text = '';
		let source = '';
		try {
			const cacheFile = Zotero.FullText.getItemCacheFile(item);
			if (cacheFile?.path && await IOUtils.exists(cacheFile.path)) {
				text = await IOUtils.readUTF8(cacheFile.path);
				source = 'zotero-ft-cache';
			}
		}
		catch (e) {
			log('cache read failed', e);
		}
		if (!text) {
			const isPDF = (item.attachmentContentType ?? '').includes('pdf') || /\.pdf$/i.test(path);
			if (isPDF) {
				try {
					// PDFWorker.getFullText() resolves to { text, extractedPages,
					// totalPages } — NOT a string. Assigning the whole object left
					// text.slice/toLowerCase throwing "[zotero/error] … is not a
					// function" on every PDF whose .zotero-ft-cache wasn't built yet.
					const result = await Zotero.PDFWorker.getFullText(item.id);
					text = typeof result?.text === 'string' ? result.text : '';
					source = 'pdf-worker';
				}
				catch (e) {
					log('PDFWorker failed', e);
					throw fail('zotero/extract-failed', `PDF 文本提取失败（${e?.message ?? e}）。文件真实路径：${path}`);
				}
			}
			else if (/\.(txt|md|json|csv|html?|xml)$/i.test(path)) {
				text = await IOUtils.readUTF8(path);
				source = 'file';
			}
			else {
				return { ok: true, kind: 'binary', path, note: '该文件类型无文本层，仅返回真实路径。' };
			}
		}

		// Belt and braces: every source above must yield a string, but a
		// non-string here used to explode as "text.slice is not a function".
		if (typeof text !== 'string') text = text ? String(text) : '';
		const maxChars = Math.min(Math.max(Number(payload.maxChars) || 60000, 500), 400000);
		let offset = Math.max(Number(payload.offset) || 0, 0);
		const search = String(payload.search ?? '').trim();
		// Scanned PDFs (no text layer) extract to an empty string — say so
		// instead of returning a silent empty payload the agent would retry.
		const emptyNote = text ? undefined : '全文为空：该文件可能没有文本层（扫描件），或文本提取尚未完成。';
		if (search) {
			// Locate up to 5 context windows around matches.
			const windows = [];
			const lower = text.toLowerCase();
			const needle = search.toLowerCase();
			let index = lower.indexOf(needle);
			while (index >= 0 && windows.length < 5) {
				const start = Math.max(0, index - 400);
				windows.push(`…${text.slice(start, Math.min(text.length, index + needle.length + 800))}…`);
				index = lower.indexOf(needle, index + needle.length);
			}
			return {
				ok: true,
				kind: 'text',
				path,
				source,
				total: text.length,
				matches: windows.length,
				text: windows.join('\n———\n') || '(未找到匹配)',
				note: emptyNote,
			};
		}
		const slice = text.slice(offset, offset + maxChars);
		return {
			ok: true,
			kind: 'text',
			path,
			source,
			total: text.length,
			offset,
			nextOffset: offset + slice.length < text.length ? offset + slice.length : null,
			text: slice,
			note: emptyNote,
		};
	}

	async function opAnnotations(payload = {}) {
		let item = await getItem(payload.id);
		if (item.isRegularItem?.()) {
			const best = await item.getBestAttachment();
			if (!best) return { ok: true, annotations: [] };
			item = best;
		}
		// getAnnotations() throws without childItems loaded and returns ITEM
		// OBJECTS unless asIDs=true — load explicitly and take ids.
		try {
			await item.loadDataType('childItems');
		}
		catch (e) { /* item without childItems support */ }
		const annotations = [];
		const annotationIDs = item.getAnnotations ? item.getAnnotations(false, true) : [];
		for (const id of annotationIDs ?? []) {
			const a = Zotero.Items.get(id);
			if (!a) continue;
			annotations.push({
				id: a.id,
				type: a.annotationType ?? a.getField('annotationType'),
				text: a.annotationText ?? '',
				comment: a.annotationComment ?? '',
				color: a.annotationColor ?? '',
				page: a.annotationPageLabel ?? '',
				date: a.getField('dateAdded'),
			});
		}
		return { ok: true, annotations };
	}

	function applyCreators(item, creators) {
		if (!Array.isArray(creators)) throw fail('zotero/invalid', 'creators 必须是数组');
		const mapped = creators.map((c) => {
			const row = {
				creatorType: String(c?.creatorType ?? 'author'),
				firstName: String(c?.firstName ?? ''),
				lastName: String(c?.lastName ?? ''),
			};
			if (c?.fieldMode === 1) {
				row.fieldMode = 1;
				row.firstName = '';
			}
			return row;
		});
		item.setCreators(mapped);
	}

	function applyFields(item, fields, { validate = true } = {}) {
		for (const [name, value] of Object.entries(fields ?? {})) {
			if (value === null) {
				item.setField(name, '');
				continue;
			}
			item.setField(name, String(value));
		}
	}

	async function opUpdate(payload = {}) {
		const item = await getItem(payload.id);
		if (!item.isRegularItem()) throw fail('zotero/not-regular', '只能修改普通条目（非附件/笔记）');

		if (payload.itemType && Zotero.ItemTypes.getID(payload.itemType)
			&& payload.itemType !== Zotero.ItemTypes.getName(item.itemTypeID)) {
			// setType keeps fields that map to the same base field (like the UI).
			item.setType(Zotero.ItemTypes.getID(payload.itemType));
		}
		if (payload.fields && typeof payload.fields === 'object') applyFields(item, payload.fields);
		if (payload.creators !== undefined) applyCreators(item, payload.creators);
		if (Array.isArray(payload.tags)) {
			item.setTags(payload.tags.filter(t => typeof t === 'string' && t.trim() !== '').map(t => ({ tag: t })));
		}
		if (Array.isArray(payload.addCollections)) {
			for (const cid of payload.addCollections) {
				const collection = Zotero.Collections.get(Number(cid));
				if (!collection?.id) throw fail('zotero/no-collection', `找不到分类 id ${cid}`);
				item.addToCollection(collection.id);
			}
		}
		if (Array.isArray(payload.removeCollections)) {
			for (const cid of payload.removeCollections) {
				const collection = Zotero.Collections.get(Number(cid));
				if (collection?.id) item.removeFromCollection(collection.id);
			}
		}
		await item.saveTx();
		return { ok: true, item: summaryRow(item) };
	}

	async function opAdd(payload = {}) {
		const typeName = String(payload.itemType ?? 'journalArticle');
		if (!Zotero.ItemTypes.getID(typeName)) throw fail('zotero/bad-type', `未知条目类型 ${typeName}`);
		// Pre-flight the adoptable attachments (the "PDF dragged in, no
		// metadata yet" case) BEFORE creating anything — a bad id must not
		// leave a half-created item behind. Adoption re-parents the existing
		// attachment instead of re-importing the file, and the new item
		// inherits the attachment's collections (mirroring Zotero's own
		// drag-a-PDF-then-retrieve-metadata behavior).
		const adoptees = [];
		if (Array.isArray(payload.adoptAttachmentIDs) && payload.adoptAttachmentIDs.length) {
			for (const aid of payload.adoptAttachmentIDs) {
				const att = await getItem(aid);
				if (!att.isAttachment()) throw fail('zotero/not-attachment', `id ${aid} 不是附件，无法挂接`);
				const attName = att.getField('title') || att.attachmentFilename || att.id;
				if (att.parentItemID) throw fail('zotero/has-parent', `附件「${attName}」已属于某个条目，不能重复挂接`);
				if (att.deleted) throw fail('zotero/trashed', `附件「${attName}」在回收站，请先恢复`);
				adoptees.push(att);
			}
		}
		const item = new Zotero.Item(typeName);
		const libraryID = Number.isInteger(payload.libraryID) ? payload.libraryID : userLibraryID();
		item.libraryID = libraryID;
		applyFields(item, payload.fields ?? {});
		if (payload.creators !== undefined) applyCreators(item, payload.creators);
		if (Array.isArray(payload.tags)) {
			item.setTags(payload.tags.filter(t => typeof t === 'string' && t.trim() !== '').map(t => ({ tag: t })));
		}
		if (Array.isArray(payload.collectionIDs)) {
			for (const cid of payload.collectionIDs) item.addToCollection(Number(cid));
		}
		const id = await item.saveTx();
		const saved = Zotero.Items.get(id);
		const adopted = [];
		const inherited = new Set();
		for (const att of adoptees) {
			// The collection membership moves from the attachment to the new
			// parent (children don't live in collections) — same as Zotero's
			// own retrieve-metadata-for-dragged-PDF behavior.
			const attCollections = att.getCollections() ?? [];
			for (const cid of attCollections) inherited.add(cid);
			att.parentKey = saved.key;
			for (const cid of attCollections) att.removeFromCollection(cid);
			await att.saveTx();
			adopted.push(attachmentInfo(att));
		}
		if (inherited.size) {
			for (const cid of inherited) saved.addToCollection(cid);
			await saved.saveTx();
		}
		return {
			ok: true,
			item: summaryRow(saved),
			...(adopted.length ? { adoptedAttachments: adopted } : {}),
		};
	}

	async function opAttach(payload = {}) {
		// standalone:true imports the file/link as a top-level attachment (the
		// "先把 PDF 收进库，之后再用 add+adoptAttachmentIDs 识别建条目" flow).
		const standalone = payload.standalone === true;
		const parent = standalone ? null : await getItem(payload.id);
		if (parent && !parent.isRegularItem()) throw fail('zotero/not-regular', '只能给普通条目添加附件');
		const libraryID = parent ? parent.libraryID
			: (Number.isInteger(payload.libraryID) ? payload.libraryID : userLibraryID());
		let att;
		if (payload.url) {
			att = await Zotero.Attachments.linkFromURL({
				url: String(payload.url),
				title: String(payload.title ?? payload.url),
				...(parent ? { parentItemID: parent.id } : {}),
				libraryID,
			});
		}
		else {
			if (!payload.path) throw fail('zotero/invalid', '需要 path（本地文件）或 url');
			if (!(await IOUtils.exists(String(payload.path)))) {
				throw fail('zotero/no-file', `文件不存在: ${payload.path}`);
			}
			att = await Zotero.Attachments.importFromFile({
				file: String(payload.path),
				...(parent ? { parentItemID: parent.id } : {}),
				libraryID,
				filename: payload.filename ? String(payload.filename) : undefined,
			});
		}
		if (standalone && Array.isArray(payload.collectionIDs) && payload.collectionIDs.length) {
			for (const cid of payload.collectionIDs) att.addToCollection(Number(cid));
			await att.saveTx();
		}
		return { ok: true, attachment: { ...attachmentInfo(att), path: await att.getFilePathAsync() } };
	}

	async function opCollection(payload = {}) {
		const action = String(payload.action ?? 'create');
		if (action === 'create') {
			const name = String(payload.name ?? '').trim();
			if (!name) throw fail('zotero/invalid', 'create 需要 name');
			const collection = new Zotero.Collection();
			collection.libraryID = Number.isInteger(payload.libraryID) ? payload.libraryID : userLibraryID();
			collection.name = name;
			if (Number.isInteger(payload.parentID)) {
				const parent = Zotero.Collections.get(Number(payload.parentID));
				if (!parent?.id) throw fail('zotero/no-collection', `找不到父分类 id ${payload.parentID}`);
				collection.parentID = parent.id;
			}
			await collection.saveTx();
			return { ok: true, collection: { id: collection.id, key: collection.key, name } };
		}
		const collection = Zotero.Collections.get(Number(payload.id));
		if (!collection?.id) throw fail('zotero/no-collection', `找不到分类 id ${payload.id}`);
		if (action === 'rename') {
			collection.name = String(payload.name ?? collection.name);
			await collection.saveTx();
			return { ok: true, collection: { id: collection.id, name: collection.name } };
		}
		if (action === 'trash') {
			collection.deleted = true;
			await collection.saveTx();
			return { ok: true, trashed: true };
		}
		throw fail('zotero/invalid', `未知 action: ${action}`);
	}

	async function opTrash(payload = {}) {
		const item = await getItem(payload.id);
		const action = String(payload.action ?? 'trash');
		if (action === 'restore') {
			item.deleted = false;
			await item.saveTx();
			return { ok: true, restored: true };
		}
		if (action === 'delete') {
			item.deleted = true;
			await item.eraseTx();
			return { ok: true, deleted: true };
		}
		item.deleted = true;
		await item.saveTx();
		return { ok: true, trashed: true };
	}

	async function opNote(payload = {}) {
		const text = String(payload.text ?? '');
		if (payload.id) {
			// Update an existing note.
			const note = await getItem(payload.id);
			if (!note.isNote()) throw fail('zotero/not-note', 'id 指向的不是笔记');
			note.setNote(text);
			await note.saveTx();
			return { ok: true, noteID: note.id };
		}
		let parentItemID = null;
		let libraryID = Number.isInteger(payload.libraryID) ? payload.libraryID : userLibraryID();
		if (payload.parentID) {
			const parent = await getItem(payload.parentID);
			parentItemID = parent.id;
			libraryID = parent.libraryID;
		}
		const note = new Zotero.Item('note');
		note.libraryID = libraryID;
		note.setNote(text);
		if (parentItemID) note.parentID = parentItemID;
		const id = await note.saveTx();
		return { ok: true, noteID: id };
	}

	function opItemTypes() {
		const rows = [];
		for (const typeData of Zotero.ItemTypes.getTypes()) {
			const fieldNames = (Zotero.ItemFields.getItemTypeFields(typeData.id) ?? [])
				.map(fid => Zotero.ItemFields.getName(fid))
				.filter(Boolean);
			const creatorTypes = (Zotero.CreatorTypes.getTypesForItemType(typeData.id) ?? [])
				.map(ct => ct.name);
			rows.push({ itemType: typeData.name, fields: fieldNames, creatorTypes });
		}
		return { ok: true, itemTypes: rows };
	}

	async function opOpen(payload = {}) {		const item = await getItem(payload.id);
		let target = item;
		if (item.isRegularItem?.()) {
			const best = await item.getBestAttachment();
			if (!best) throw fail('zotero/no-attachment', '该条目没有附件');
			target = best;
		}
		if (payload.action === 'reveal') {
			const path = await target.getFilePathAsync?.();
			if (!path) throw fail('zotero/no-file', '没有本地文件可显示');
			Zotero.File.reveal(path);
			return { ok: true, revealed: path };
		}
		const path = await target.getFilePathAsync?.();
		if (path) {
			Zotero.launchFile(path);
			return { ok: true, opened: path };
		}
		const url = target.getField('url') || (item.isRegularItem?.() ? String(item.getField('url', false, true) ?? '') : '');
		if (url) {
			Zotero.launchURL(url);
			return { ok: true, opened: url };
		}
		throw fail('zotero/no-file', '既无本地文件也无 URL');
	}

	/** Locate an item in the literature list and highlight it: bring the
	 * library tab forward (the selection lives only there), wait for the
	 * just-created row to reach the current view, then let the collection
	 * tree's own selectItem do the reveal — it selects in the current view,
	 * falls back to the trash when the item is trashed, and to the library
	 * root when no view shows it. Locating an attachment highlights its
	 * parent item (that's what the list shows). */
	async function opLocate(payload = {}) {
		const item = await getItem(payload.id);
		let target = item;
		if (item.isAttachment?.() && item.parentItemID) {
			target = Zotero.Items.get(item.parentItemID) ?? item;
		}
		const pane = Zotero.getActiveZoteroPane();
		const tree = pane?.collectionTree ?? pane?.collectionsView;
		if (!tree || typeof tree.selectItem !== 'function') {
			throw fail('zotero/no-window', '找不到活动的 Zotero 文献列表窗口');
		}
		if (payload.focus !== false) {
			try {
				const win = pane.document?.defaultView;
				if (win?.Zotero_Tabs && win.Zotero_Tabs.selectedID !== 'zotero-pane') {
					win.Zotero_Tabs.select('zotero-pane');
				}
			}
			catch (e) {
				log('locate tab focus failed', e?.message ?? e);
			}
		}
		// A freshly created item reaches the visible view through the
		// Notifier's async refresh — poll for the row first so selectItem's
		// "not found → switch to library root" fallback doesn't fire while
		// the item is simply not flushed to the view yet.
		for (let i = 0; i < 12; i++) {
			if (!pane.itemsView || pane.itemsView._rowMap?.[target.id] !== undefined) break;
			await Zotero.Promise.delay(250);
		}
		const found = await tree.selectItem(target.id);
		return {
			ok: true,
			found: found !== false,
			item: summaryRow(target),
			...(item.id !== target.id ? { parentID: target.id } : {}),
		};
	}

	// ------------------------------------------------- reader integration ------
	//
	// Search / locate / annotate against the OPEN Zotero PDF reader. The
	// reader's internal view (resource://zotero/reader) keeps a per-page
	// character model (`_primaryView._pdfPages[i].chars`: char + inlineRect in
	// PDF page coords, y-up, scale 1) — the same model its own selection→
	// annotation path uses, so rects derived from it drop straight into
	// `Zotero.Annotations.saveFromJSON` and live-update in the open reader
	// via its Notifier observer.

	/** X-ray-safe peek into the reader's internal PDF view (may be absent). */
	function readerView(reader) {
		try {
			return reader?._internalReader?._primaryView ?? null;
		}
		catch (e) {
			return null;
		}
	}

	/** Find the open reader for an attachment id; optionally open it and wait
	 * for the internal reader + primary view to come up. */
	async function ensureReader(attachmentID, { open = false } = {}) {
		const find = () => (Zotero.Reader._readers ?? []).find(r => r.itemID === attachmentID && !r._isTabClosed) ?? null;
		let reader = find();
		if (!reader && open) {
			try {
				await Zotero.Reader.open(attachmentID);
			}
			catch (e) {
				log(`reader open failed for ${attachmentID}`, e?.message ?? e);
			}
			for (let i = 0; i < 80 && !find(); i++) await Zotero.Promise.delay(250);
			reader = find();
		}
		if (!reader) return null;
		for (let i = 0; i < 80 && !readerView(reader); i++) await Zotero.Promise.delay(250);
		if (!readerView(reader)) throw fail('zotero/reader-not-ready', '阅读器尚未初始化完成，请稍后重试');
		return reader;
	}

	/** Normalized page text (whitespace collapsed) with a back-map from each
	 * text position to its char index — makes matching robust against the
	 * spaceAfter/lineBreakAfter splitting and paragraph double spaces. */
	function pageTextModel(chars) {
		let text = '';
		const idx = [];
		for (let i = 0; i < chars.length; i++) {
			const ch = chars[i];
			if (ch?.ignorable) continue;
			const c = String(ch?.c ?? '');
			if (/\s/.test(c)) {
				if (!text.endsWith(' ')) {
					text += ' ';
					idx.push(i);
				}
			}
			else {
				text += c;
				idx.push(i);
			}
			if (ch?.spaceAfter || ch?.lineBreakAfter || ch?.paragraphBreakAfter) {
				if (!text.endsWith(' ')) {
					text += ' ';
					idx.push(i);
				}
			}
		}
		return { text, idx };
	}

	/** Replicates the reader's getRectsFromChars: union rects per text line. */
	function rectsFromChars(slice) {
		const rects = [];
		let cur = null;
		for (const ch of slice) {
			const r = ch?.inlineRect;
			if (!r) continue;
			if (!cur) cur = [r[0], r[1], r[2], r[3]];
			else cur = [Math.min(cur[0], r[0]), Math.min(cur[1], r[1]), Math.max(cur[2], r[2]), Math.max(cur[3], r[3])];
			if (ch.lineBreakAfter) {
				rects.push(cur);
				cur = null;
			}
		}
		if (cur) rects.push(cur);
		return rects;
	}

	/** Replicates the reader's getTextFromChars (originals joined, spaces
	 * inserted at breaks). */
	function textFromChars(slice) {
		let out = '';
		for (const ch of slice) {
			if (ch?.ignorable) continue;
			out += String(ch?.c ?? '');
			if (ch?.spaceAfter || ch?.lineBreakAfter) out += ' ';
			if (ch?.paragraphBreakAfter) out += ' ';
		}
		return out.trim();
	}

	/** Approximate replica of the reader's getSortIndex (sidebar ordering
	 * only): pageIndex | closest-char offset of the first rect | distance of
	 * the topmost rect from the page top. */
	function sortIndexFor(pageData, pageIndex, rects) {
		let offset = 0;
		let top = 0;
		const chars = pageData?.chars;
		if (chars?.length && rects?.length) {
			const rect = rects[0];
			let bestDist = Infinity;
			for (let i = 0; i < chars.length; i++) {
				const r = chars[i]?.inlineRect;
				if (!r) continue;
				const dx = Math.max(0, Math.max(r[0], rect[0]) - Math.min(r[2], rect[2]));
				const dy = Math.max(0, Math.max(r[1], rect[1]) - Math.min(r[3], rect[3]));
				const d = dx + dy;
				if (d < bestDist) {
					bestDist = d;
					offset = i;
					if (d === 0) break;
				}
			}
			const viewBox = pageData.viewBox ?? [0, 0, 0, 0];
			const pageHeight = (viewBox[3] ?? 0) - (viewBox[1] ?? 0);
			const bottom = rects.reduce((m, r) => Math.max(m, Number(r[3]) || 0), 0);
			top = Math.max(0, pageHeight - bottom);
		}
		return `${String(pageIndex).slice(0, 5).padStart(5, '0')}|${String(offset).slice(0, 6).padStart(6, '0')}|${String(Math.floor(top)).slice(0, 5).padStart(5, '0')}`;
	}

	function pageLabelFor(view, pageIndex) {
		try {
			const labels = view?._options?.pageLabels;
			return (Array.isArray(labels) && labels[pageIndex]) || String(pageIndex + 1);
		}
		catch (e) {
			return String(pageIndex + 1);
		}
	}

	async function pageCount(view) {
		// The reader iframe (resource://) is privileged — no X-ray barrier, so
		// the page's PDFViewerApplication is reachable as a plain property.
		// (pdf_view has no _pagesCount getter — that one lives on SDTView.)
		try {
			const num = view?._iframeWindow?.PDFViewerApplication?.pdfDocument?.numPages;
			if (typeof num === 'number' && num > 0) return num;
		}
		catch (e) { /* fall through */ }
		try {
			if (typeof view?._pagesCount === 'number' && view._pagesCount > 0) return view._pagesCount;
		}
		catch (e) { /* fall through */ }
		return 0;
	}

	/** Case-insensitive whitespace-collapsed search across the PDF's char
	 * model. Returns hits with page info, original text, context and rects —
	 * everything locate/annotate need. */
	async function findInReader(view, { pageIndex = null, query, limit = 5, context = 40 }) {
		const raw = String(query ?? '');
		const needle = raw.replace(/\s+/g, ' ').trim().toLowerCase();
		if (!needle) throw fail('zotero/invalid', 'query 不能为空');
		// The document may still be initializing right after an auto-open —
		// wait for the page count before scanning.
		let total = 0;
		for (let i = 0; i < 40 && !(total = await pageCount(view)); i++) {
			await Zotero.Promise.delay(500);
		}
		if (!total) throw fail('zotero/reader-not-ready', '无法确定 PDF 页数（阅读器未就绪）');
		const hits = [];
		const from = pageIndex === null ? 0 : Math.max(0, Math.min(pageIndex, total - 1));
		const to = pageIndex === null ? total : from + 1;
		for (let p = from; p < to && hits.length < limit; p++) {
			await view._ensureBasicPageData(p);
			const pageData = view._pdfPages[p];
			const chars = pageData?.chars;
			if (!chars?.length) continue;
			const model = pageTextModel(chars);
			let start = model.text.toLowerCase().indexOf(needle);
			while (start >= 0 && hits.length < limit) {
				const end = start + needle.length;
				const charFrom = model.idx[start];
				const charTo = model.idx[end - 1];
				if (charFrom !== undefined && charTo !== undefined) {
					const slice = [];
					for (let i = charFrom; i <= charTo; i++) slice.push(chars[i]);
					const ctxStart = Math.max(0, start - context);
					const ctxEnd = Math.min(model.text.length, end + context);
					hits.push({
						pageIndex: p,
						page: pageLabelFor(view, p),
						text: textFromChars(slice),
						context: model.text.slice(ctxStart, ctxEnd),
						rects: rectsFromChars(slice),
					});
				}
				start = model.text.toLowerCase().indexOf(needle, end);
			}
		}
		return hits;
	}

	async function resolveReaderTarget(payloadId) {
		let item = await getItem(payloadId);
		if (item.isRegularItem?.()) {
			const best = await item.getBestAttachment();
			if (!best) throw fail('zotero/no-attachment', `条目「${item.getDisplayTitle()}」没有可用附件`);
			item = best;
		}
		if (!item.isAttachment()) throw fail('zotero/not-attachment', '该条目不是附件，无法在阅读器中操作');
		return item;
	}

	/** Map any requested color onto Zotero's annotation palette (the save
	 * path rejects everything else): exact match wins, otherwise the closest
	 * palette entry by RGB distance; unparsable → default yellow. */
	function colorOr(payloadColor) {
		const palette = (Zotero.Annotations?.COLORS ?? [['', '#ffd400']]).map(([, hex]) => hex);
		const c = String(payloadColor ?? '').trim().toLowerCase();
		if (palette.includes(c)) return c;
		const parse = (hex) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
		if (/^#[0-9a-f]{6}$/.test(c)) {
			const [r, g, b] = parse(c);
			let best = palette[0];
			let bestD = Infinity;
			for (const hex of palette) {
				const [r2, g2, b2] = parse(hex);
				const d = (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2;
				if (d < bestD) {
					bestD = d;
					best = hex;
				}
			}
			return best;
		}
		return palette[0];
	}

	/** Create a highlight/underline annotation from matched chars. */
	async function createTextAnnotation(attachment, view, hit, { type, color, comment }) {
		const json = {
			key: Zotero.Utilities.generateObjectKey(),
			type: type === 'underline' ? 'underline' : 'highlight',
			position: { pageIndex: hit.pageIndex, rects: hit.rects },
			text: hit.text,
			comment: String(comment ?? ''),
			color: colorOr(color),
			pageLabel: hit.page,
			sortIndex: sortIndexFor(view._pdfPages[hit.pageIndex], hit.pageIndex, hit.rects),
		};
		const saved = await Zotero.Annotations.saveFromJSON(attachment, json);
		return saved?.key ?? json.key;
	}

	/** Mark `text` in the open reader and attach `comment` to the annotation
	 * (the translate popup's「添加到评论」). Locates the text through the same
	 * char-model search the reader tools use — first on the page the reader
	 * currently shows (the selection is usually in view), then document-wide.
	 * Returns the saved annotation key; throws when the text can't be found. */
	async function annotateReaderText({ reader, text, comment, type = 'underline', color }) {
		const attachment = Zotero.Items.get(reader?.itemID);
		if (!attachment?.isAttachment?.()) throw new Error('找不到当前文献的 PDF 附件');
		const view = readerView(reader);
		if (!view) throw new Error('阅读器尚未初始化完成');
		const needle = String(text ?? '').trim();
		if (!needle) throw new Error('没有可标记的原文');
		let hit = null;
		try {
			const current = view._iframeWindow?.PDFViewerApplication?.pdfViewer?.currentPageNumber;
			if (typeof current === 'number' && current >= 1) {
				[hit] = await findInReader(view, { pageIndex: current - 1, query: needle, limit: 1 });
			}
		}
		catch (e) { /* fall through to document-wide search */ }
		if (!hit) [hit] = await findInReader(view, { query: needle, limit: 1 });
		if (!hit) throw new Error('在 PDF 中找不到所选原文（扫描件或文本层异常时无法标记）');
		return createTextAnnotation(attachment, view, hit, {
			type,
			color,
			comment: String(comment ?? ''),
		});
	}

	async function opReaderSearch(payload = {}) {
		const attachment = await resolveReaderTarget(payload.id);
		const reader = await ensureReader(attachment.id);
		if (!reader) {
			return {
				ok: true,
				open: false,
				note: '该 PDF 未在 Zotero 阅读器中打开。请让用户先打开它，或改用 zotero_read 检索全文（无页码信息）。',
			};
		}
		const view = readerView(reader);
		const limit = Math.min(Math.max(Number(payload.limit) || 5, 1), 20);
		const hits = await findInReader(view, { query: payload.query, limit });
		return {
			ok: true,
			open: true,
			attachmentID: attachment.id,
			matches: hits.length,
			hits,
			hint: hits.length ? '用 zotero_reader_locate {id, pageIndex, text, mark, color, comment} 跳转并标记命中处' : '未找到；换更短的原文片段重试（跨行的词也按原文顺序给出）',
		};
	}

	async function opReaderLocate(payload = {}) {
		const attachment = await resolveReaderTarget(payload.id);
		const reader = await ensureReader(attachment.id, { open: payload.openReader !== false });
		if (!reader) return { ok: true, open: false, note: '该 PDF 未打开，且本次调用未允许自动打开' };
		const view = readerView(reader);
		if (!Number.isInteger(Number(payload.pageIndex))) throw fail('zotero/invalid', '需要 pageIndex（来自 zotero_reader_search）');
		const pageIndex = Number(payload.pageIndex);
		// Resolve the precise target: text match on the page → rects, else page top.
		let rects = null;
		let hitText = null;
		let pageLabel = pageLabelFor(view, pageIndex);
		if (payload.text) {
			const [hit] = await findInReader(view, { pageIndex, query: payload.text, limit: 1 });
			if (!hit) throw fail('zotero/no-match', `页 ${pageLabel}（pageIndex ${pageIndex}）上找不到「${String(payload.text).slice(0, 80)}」；先用 zotero_reader_search 重新定位`);
			rects = hit.rects;
			hitText = hit.text;
		}
		else {
			await view._ensureBasicPageData(pageIndex);
		}
		// Jump: page-only → scrollToPage; with rects → base navigate + spotlight flash.
		if (rects) {
			await reader.navigate({ position: { pageIndex, rects } });
		}
		else {
			await reader.navigate({ pageIndex });
		}
		const result = {
			ok: true,
			open: true,
			pageIndex,
			page: pageLabel,
			jumped: true,
		};
		if (payload.mark === 'highlight' || payload.mark === 'underline') {
			if (!rects) throw fail('zotero/no-match', 'mark 需要配合 text 使用（要知道标在哪一段）');
			const key = await createTextAnnotation(attachment, view, { pageIndex, page: pageLabel, text: hitText, rects }, {
				type: payload.mark,
				color: payload.color,
				comment: payload.comment,
			});
			result.annotationKey = key;
			result.marked = payload.mark;
		}
		return result;
	}

	async function opReaderAnnotate(payload = {}) {
		const type = payload.type === 'underline' ? 'underline' : 'highlight';
		const attachment = await resolveReaderTarget(payload.id);
		const reader = await ensureReader(attachment.id, { open: payload.openReader !== false });
		if (!reader) return { ok: true, open: false, note: '该 PDF 未打开，且本次调用未允许自动打开' };
		const view = readerView(reader);
		if (!Number.isInteger(Number(payload.pageIndex))) throw fail('zotero/invalid', '需要 pageIndex（来自 zotero_reader_search）');
		const [hit] = await findInReader(view, { pageIndex: Number(payload.pageIndex), query: payload.text, limit: 1 });
		if (!hit) {
			const label = pageLabelFor(view, Number(payload.pageIndex));
			throw fail('zotero/no-match', `页 ${label}（pageIndex ${payload.pageIndex}）上找不到「${String(payload.text ?? '').slice(0, 80)}」；先用 zotero_reader_search 重新定位`);
		}
		const key = await createTextAnnotation(attachment, view, hit, {
			type,
			color: payload.color,
			comment: payload.comment,
		});
		return { ok: true, annotationKey: key, type, page: hit.page, text: hit.text };
	}

	async function opNotes(payload = {}) {
		const item = await getItem(payload.id);
		let noteItems = [];
		if (item.isNote?.()) noteItems = [item];
		else if (item.isRegularItem?.() || item.isAttachment?.()) {
			noteItems = (item.getNotes?.() ?? []).map(id => Zotero.Items.get(id)).filter(Boolean);
		}
		const maxChars = 20000;
		const notes = noteItems.map((n) => {
			const text = String(n.note ?? '');
			return {
				id: n.id,
				key: n.key,
				parentID: n.parentItemID ?? null,
				dateModified: n.getField?.('dateModified') ?? '',
				truncated: text.length > maxChars,
				text: text.slice(0, maxChars),
			};
		});
		return { ok: true, count: notes.length, notes };
	}

	// ---------------------------------------------------------------- endpoint plumbing

	/** Test/diagnostic trigger: open the session surface like the wake buttons
	 * do. `host` optionally forces 'panel' or 'tab'. */
	async function opDebugOpen(payload = {}) {
		const mode = payload.mode === 'reader' ? 'reader' : 'list';
		if (payload.host === 'hide') {
			// Walks the exact same path as the panel's × button — hide only.
			try { DSH.SessionWindow.setHost(null); }
			catch (e) { DSH.Util.log('debug setHost failed', e); }
			return { ok: true, triggered: true, hidden: true };
		}
		if (payload.host === 'tab' || payload.host === 'panel') {
			try { DSH.SessionWindow.setHost(payload.host); }
			catch (e) { DSH.Util.log('debug setHost failed', e); }
		}
		void DSH.UI.openSessionWindow(mode, Number.isInteger(payload.itemID) ? payload.itemID : null);
		return { ok: true, triggered: true };
	}

	/** dsh source detection internals (candidates + registry sweep + asar
	 * engine probe + node lookup) — the remote diagnosis tool for
	 * "检测不到 dsh" reports on other machines. */
	async function opDebugDetect() {
		try {
			return { ok: true, ...(await DSH.Sidecar.detectionReport()) };
		}
		catch (e) {
			return { ok: false, error: `${e?.message ?? e}` };
		}
	}

	/** Test/diagnostic state of the session surface (panel + optional tab). */
	async function opDebugState() {
		const s = DSH.SessionWindow.state;
		const browser = s.browser;
		const out = {
			ok: true,
			sidecar: DSH.Sidecar.getPhase(),
			dshMode: DSH.Sidecar.dshMode(),
			attached: !!DSH.Sidecar.state.attached,
			bridgeOk: DSH.Sidecar.state.bridgeOk,
			resolvedMode: DSH.Sidecar.state.resolvedMode || '',
			// Zotero's HTTP server: the tools' callback channel (null port =
			// not listening — every zotero_* tool would fail).
			httpServer: Zotero.DSHinZotero.httpServerStatus(),
			desktopPath: DSH.Sidecar.state.desktopPath || '',
			apiBase: DSH.Sidecar.state.apiBase || '',
			host: s.host,
			panelVisible: s.panel ? s.panel.root.getAttribute('hidden') !== 'true' : false,
			tabID: s.tab?.id ?? null,
			current: s.current ?? null,
			browserSrc: browser?.getAttribute('src') ?? null,
		};
		try {
			// Computed display — the ground truth for "did it actually hide"
			// (author display:flex used to override the UA [hidden] rule).
			out.panelDisplay = s.panel
				? String(Zotero.getMainWindow()?.getComputedStyle?.(s.panel.root)?.display ?? '')
				: null;
		}
		catch (e) { out.panelDisplay = 'ERR ' + (e?.message ?? e); }
		try {
			// Strip layout ground truth: button order, per-button cursor (the
			// drag cursor must not leak onto buttons), and the label currently
			// shown by the session selector (must be a title, never an id).
			const win = Zotero.getMainWindow();
			if (s.panel && win) {
				const buttons = [...s.panel.strip.root.querySelectorAll('toolbarbutton')];
				out.panelStrip = {
					buttons: buttons.map(b => ({
						label: b.getAttribute('label') || '',
						class: (b.getAttribute('class') || '').split(' ').find(c => c !== 'dsh-strip-button') || '',
					})),
					cursors: buttons.map(b => win.getComputedStyle(b).cursor),
					selectorLabel: String(s.panel.strip.selector.label ?? ''),
					hostIcon: (() => {
						const btn = s.panel.strip.root.querySelector('.dsh-host-switch');
						if (!btn) return null;
						const cs = win.getComputedStyle(btn);
						return {
							listStyleImage: cs.listStyleImage?.slice(0, 120) ?? '',
							width: Math.round(btn.getBoundingClientRect().width),
						};
					})(),
				};
			}
		}
		catch (e) { out.panelStrip = { error: String(e?.message ?? e) }; }
		out.currentURI = browser?.currentURI?.spec ?? null;
		out.isRemote = browser ? !!browser.isRemoteBrowser : null;
		out.remoteType = browser?.remoteType ?? null;
		out.browserReady = browser ? browser.getAttribute('remote') : null;
		out.contentURL = out.currentURI;
		try {
			const ui = await DSH.Sidecar.plugin('ui.state', {}, { timeoutMs: 10_000 });
			out.ui = { at: ui?.at ?? 0, ageMs: Date.now() - Number(ui?.at ?? 0), sessionCount: Array.isArray(ui?.sessionIds) ? ui.sessionIds.length : -1, lastNav: ui?.lastNav ?? null };
		}
		catch (e) {
			out.uiError = String(e?.message ?? e);
		}
		return out;
	}

	/** Test/diagnostic: navigate the embedded browser to an arbitrary URL. */
	async function opDebugNav(payload = {}) {
		const s = DSH.SessionWindow.state;
		if (!s.browser) return { ok: false, error: 'no browser' };
		const url = String(payload.url ?? '');
		if (payload.remote === true) {
			try {
				s.browser.setAttribute('maychangeremoteness', 'true');
				s.browser.setAttribute('remote', 'true');
			} catch (e) { /* keep */ }
		}
		s.browser.setAttribute('src', url);
		try {
			s.browser.fixupAndLoadURIString(url, {
				triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
			});
		}
		catch (e) {
			try {
				s.browser.webNavigation.loadURI(url, Components.interfaces.nsIWebNavigation.LOAD_FLAGS_NONE, null, null, null);
			}
			catch (e2) {
				return { ok: false, error: String(e2?.message ?? e2) };
			}
		}
		const before = s.browser.currentURI?.spec;
		await new Promise(r => setTimeout(r, Number(payload.waitMs ?? 4000)));
		let contentURL = null;
		try { contentURL = s.browser.contentWindow?.location?.href ?? null; } catch (e) { contentURL = 'ERR ' + e.message; }
		return { ok: true, before, currentURI: s.browser.currentURI?.spec, contentURL };
	}

	/** Test/diagnostic: fresh REMOTE browser, navigate, report, remove. */
	async function opDebugNavRemote(payload = {}) {
		const s = DSH.SessionWindow.state;
		const win = Zotero.getMainWindow();
		if (!win || !s.tabID) return { ok: false, error: 'no tab' };
		const container = win.document.getElementById(s.tabID);
		if (!container) return { ok: false, error: 'no container' };
		const b = win.document.createXULElement('browser');
		b.setAttribute('flex', '1');
		b.setAttribute('type', 'content');
		b.setAttribute('remote', 'true');
		b.setAttribute('maychangeremoteness', 'true');
		b.style.visibility = 'hidden';
		b.style.height = '10px';
		container.appendChild(b);
		const url = String(payload.url ?? '');
		b.setAttribute('src', url);
		try {
			b.fixupAndLoadURIString(url, {
				triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
			});
		}
		catch (e) {
			container.removeChild(b);
			return { ok: false, error: 'load call: ' + String(e?.message ?? e) };
		}
		await new Promise(r => setTimeout(r, Number(payload.waitMs ?? 8000)));
		const out = {
			ok: true,
			currentURI: b.currentURI?.spec ?? null,
			isRemote: !!b.isRemoteBrowser,
			remoteType: b.remoteType ?? null,
		};
		try { out.contentURL = b.contentWindow?.location?.href ?? '(remote - no direct access)'; } catch (e) { out.contentURL = '(remote)'; }
		container.removeChild(b);
		return out;
	}

	/** Test/diagnostic: open a reader tab for an item's best attachment. */
	async function opDebugOpenReader(payload = {}) {
		const item = Zotero.Items.get(Number(payload.itemID));
		if (!item?.id) return { ok: false, error: 'no item' };
		const attachment = item.isAttachment() ? item : (await item.getBestAttachment?.());
		if (!attachment) return { ok: false, error: 'no attachment' };
		await Zotero.Reader.open(attachment.id, undefined, { title: item.getDisplayTitle?.() ?? '' });
		return { ok: true, attachmentID: attachment.id };
	}

	/** Test/diagnostic: inspect reader internals (our toolbar button, popup wiring). */
	async function opDebugReader(payload = {}) {
		const readers = Zotero.Reader._readers ?? [];
		const reader = readers[0];
		if (!reader) return { ok: false, error: 'no reader open', count: readers.length };
		const win = reader._iframeWindow;
		const doc = win?.document;
		const out = {
			ok: true,
			itemID: reader.itemID,
			hasDoc: !!doc,
			toolbarButton: doc ? !!doc.querySelector('.dsh-reader-button') : false,
			translateStyle: doc ? !!doc.getElementById('dsh-reader-button-style') : false,
			appearanceButton: doc ? !!doc.getElementById('appearance') : false,
		};
		if (payload.dispatchPopup === true && doc) {
			// Dispatch straight to the registered plugin listeners (the same
			// handlers Zotero's reader event bridge calls); append lands on
			// document.body inside a reader-like ".section" wrapper so the
			// whole listener path (including the wrapper-separator cleanup)
			// runs end-to-end.
			const text = String(payload.text ?? 'The seed sequence of the crRNA guides target recognition.');
			Zotero.Reader._dispatchEvent({
				type: 'renderTextSelectionPopup',
				doc,
				reader,
				append: (...nodes) => {
					for (const n of nodes) {
						const wrapper = doc.createElement('div');
						wrapper.className = 'section';
						wrapper.appendChild(n);
						doc.body.appendChild(wrapper);
					}
				},
				params: { annotation: { text } },
			});
			await new Promise(r => setTimeout(r, 400));
			out.translateButton = !!doc.querySelector('.dsh-translate-button');
			out.translateSection = !!doc.querySelector('.dsh-translate-section');
			const wrap = doc.querySelector('.dsh-translate-root')?.parentNode;
			// style.borderTop normalizes '0' to '0px' on read.
			out.wrapperSeparatorCleared = wrap?.classList?.contains('section')
				? (wrap.style.borderTop === '0' || wrap.style.borderTop === '0px')
				: null;
			const autoSwitch = doc.querySelector('.dsh-translate-auto');
			out.autoSwitch = autoSwitch ? {
				pressed: autoSwitch.getAttribute('aria-pressed'),
				stateText: autoSwitch.querySelector('.dsh-auto-state')?.textContent ?? null,
				track: !!autoSwitch.querySelector('.dsh-auto-track'),
			} : null;
			// 「自动」开关真实点击回路：渲染 → click → 回读 pref 原始形态
			// （类型/双分支用户值）。验证「打开了关不掉」类报告的关键证据。
			if (autoSwitch && payload.clickAuto === true) {
				const prefFacts = () => {
					const read = (name) => {
						try {
							const full = `extensions.zotero.dsh-in-zotero.${name}`;
							const legacy = `dsh-in-zotero.${name}`;
							const branch = Services.prefs;
							const type = { 32: 'int', 64: 'string', 128: 'bool' }[branch.getPrefType(full)] ?? 'none';
							let value = null;
							try { value = Zotero.Prefs.get(full, true) ?? null; } catch (e) { value = `ERR ${e.message}`; }
							return { type, value, hasUser: branch.prefHasUserValue(full), legacyHasUser: branch.prefHasUserValue(legacy), legacyValue: branch.prefHasUserValue(legacy) ? Zotero.Prefs.get(legacy, true) : null };
						}
						catch (e) {
							return { error: String(e?.message ?? e) };
						}
					};
					return read('translateAuto');
				};
				out.autoBefore = { pressed: out.autoSwitch.pressed, pref: prefFacts() };
				// ① pref roundtrip exactly as the toggle handler does it —
				// separates "pref layer broken" from "listener never ran".
				const p1 = DSH.Util.prefGet('translateAuto', false);
				DSH.Util.prefSet('translateAuto', !p1);
				const p2 = DSH.Util.prefGet('translateAuto', false);
				DSH.Util.prefSet('translateAuto', p1);
				const p3 = DSH.Util.prefGet('translateAuto', false);
				out.prefRoundtrip = { p1, p2, p3, restored: p3 === p1 };
				// ② event delivery + element identity dissection.
				let probeFired = false;
				autoSwitch.addEventListener('click', () => { probeFired = true; }, { once: true });
				let clickThrew = false;
				try { autoSwitch.click(); }
				catch (e) { clickThrew = String(e?.message ?? e); }
				await new Promise(r => setTimeout(r, Number(payload.waitMs ?? 300)));
				const after = doc.querySelector('.dsh-translate-auto');
				out.autoAfter = {
					probeFired,
					clickThrew,
					sameElement: after === autoSwitch,
					totalAutoButtons: doc.querySelectorAll('.dsh-translate-auto').length,
					pressedSameRef: autoSwitch.getAttribute('aria-pressed'),
					pressedRequeried: after?.getAttribute('aria-pressed') ?? null,
					stateText: after?.querySelector('.dsh-auto-state')?.textContent ?? null,
					pref: prefFacts(),
					rawBool: (() => { try { return Services.prefs.getBoolPref('extensions.zotero.dsh-in-zotero.translateAuto'); } catch (e) { return `ERR ${e?.message ?? e}`; } })(),
				};
				// ④ atomic-level dissection: raw Gecko write/read, neutral pref
				// roundtrip, and Zotero.Prefs source (monkey-patch check).
				if (payload.atomic === true) {
					const full = 'extensions.zotero.dsh-in-zotero.translateAuto';
					const neutral = 'extensions.zotero.dsh-in-zotero.__atomic_probe';
					let atomic = {};
					try {
						Services.prefs.setBoolPref(full, false);
						atomic.rawAfterSet = Services.prefs.getBoolPref(full);
						atomic.hasUserAfterSet = Services.prefs.prefHasUserValue(full);
						atomic.zprefsGet = Zotero.Prefs.get(full, true);
						// neutral roundtrip through both layers
						Services.prefs.setBoolPref(neutral, false);
						atomic.neutralRaw = Services.prefs.getBoolPref(neutral);
						Zotero.Prefs.set(neutral, false, true);
						atomic.neutralZget = Zotero.Prefs.get(neutral, true);
						Services.prefs.clearUserPref(neutral);
						// double-name check (inverted global flag would land here)
						const dbl = 'extensions.zotero.' + full;
						atomic.doubleNameHasUser = Services.prefs.prefHasUserValue(dbl);
						// monkey-patch check
						atomic.getSrc = String(Zotero.Prefs.get).slice(0, 400);
						atomic.setSrc = String(Zotero.Prefs.set).slice(0, 400);
						// restore the user's value
						Services.prefs.setBoolPref(full, true);
						atomic.restored = Services.prefs.getBoolPref(full);
					}
					catch (e) {
						atomic.error = String(e?.message ?? e);
					}
					out.atomic = atomic;
				}
				// Toggle back so the probe leaves the user's setting as it was.
				if (payload.restore !== false) {
					const again = doc.querySelector('.dsh-translate-auto');
					again?.click();
					await new Promise(r => setTimeout(r, Number(payload.waitMs ?? 300)));
					const restored = doc.querySelector('.dsh-translate-auto');
					out.autoRestored = { pressed: restored?.getAttribute('aria-pressed') ?? null };
				}
			}
			// 「问 AI」端到端：真实点击问AI按钮 → 等绑定会话打开 + composer
			// 预填 → 回读 surface 当前会话与 ui.state 的 lastAsk 回执。
			if (out.translateButton && payload.clickAsk === true) {
				const askBtn = doc.querySelector('.dsh-translate-ask');
				out.askButton = !!askBtn;
				if (askBtn) {
					askBtn.click();
					await new Promise(r => setTimeout(r, Number(payload.askWaitMs ?? 12000)));
					try {
						const s = DSH.SessionWindow.state;
						out.askSurface = {
							host: s.host,
							current: s.current ? { mode: s.current.mode, itemID: s.current.itemID, sessionId: s.current.sessionId } : null,
						};
					}
					catch (e) {
						out.askSurface = { error: String(e?.message ?? e) };
					}
					try {
						const ui = await DSH.Sidecar.plugin('ui.state', {}, { timeoutMs: 10_000 });
						out.askUi = { lastAsk: ui?.lastAsk ?? null, lastNav: ui?.lastNav ?? null };
					}
					catch (e) {
						out.askUi = { error: String(e?.message ?? e) };
					}
				}
			}
			if (out.translateButton && payload.clickTranslate === true) {
				const btn = doc.querySelector('.dsh-translate-button');
				// When the auto switch fired on render, the stream is already
				// running — clicking again would double-stream the same section.
				out.autoRun = btn.classList.contains('running');
				if (!out.autoRun) btn.click();
				await new Promise(r => setTimeout(r, Number(payload.waitMs ?? 12000)));
				const section = doc.querySelector('.dsh-translate-section');
				out.translateText = section ? (section.textContent ?? '').slice(0, 400) : null;
				out.thinkHead = section?.querySelector('.dsh-think-head')?.textContent?.slice(0, 40) ?? null;
				out.thinkCollapsed = section?.querySelector('.dsh-think')?.classList?.contains('collapsed') ?? null;
				// 「添加到评论」：流结束后出现；可选择真实点击（走完整的
				// annotateReaderText → findInReader → saveFromJSON 落库链）。
				const addBtn = section?.querySelector('.dsh-action-btn');
				out.addActionButton = !!addBtn;
				if (addBtn && payload.clickAddComment === true) {
					addBtn.click();
					await new Promise(r => setTimeout(r, Number(payload.addWaitMs ?? 8000)));
					out.addCommentButtonText = addBtn.textContent ?? null;
				}
			}
		}
		return out;
	}

	/** Test/diagnostic: cleanup snapshot + headless uninstall driver. Without
	 * payload → info; {target:'runtime'|'custom'} → perform the removal the
	 * settings pane's buttons would (token-guarded like every debug op). */
	async function opDebugCleanup(payload = {}) {
		const target = String(payload?.target ?? '');
		if (!target) return { ok: true, ...(await DSH.Sidecar.cleanupInfo()) };
		if (target === 'runtime') return { ok: true, ...(await DSH.Sidecar.removeBundledRuntime()) };
		if (target === 'custom') return { ok: true, ...(await DSH.Sidecar.removeCustomDir()) };
		return { ok: false, error: `unknown cleanup target: ${target}` };
	}

	/** Test/diagnostic: open the settings window on our pane and inspect what
	 * actually rendered (fragment parse failures show up as an empty pane). */
	async function opDebugPrefs(payload = {}) {
		try { DSH.UI.openSettings(); } catch (e) { /* still inspect below */ }
		await new Promise(r => setTimeout(r, Number(payload.waitMs ?? 3000)));
		const wm = Components.classes['@mozilla.org/appshell/window-mediator;1']
			.getService(Components.interfaces.nsIWindowMediator);
		const win = wm.getMostRecentWindow('zotero:pref');
		if (!win) return { ok: false, error: 'prefs window not found' };
		const doc = win.document;
		const menu = doc.getElementById('dsh-mode-menu');
		const out = {
			ok: true,
			navItem: !!doc.querySelector('#dsh-in-zotero, richlistitem[value="dsh-in-zotero"]'),
			modeMenu: !!menu,
			menuItems: menu ? menu.querySelectorAll('menuitem').length : 0,
			restartButton: !!doc.getElementById('dsh-restart-button'),
			customBoxHidden: doc.getElementById('dsh-custom-box')?.hidden ?? null,
			attachBoxHidden: doc.getElementById('dsh-attach-box')?.hidden ?? null,
			nodeBoxHidden: doc.getElementById('dsh-node-box')?.hidden ?? null,
			menuValue: menu?.value ?? null,
			hintCount: doc.querySelectorAll('.dsh-hint').length,
			modelMenu: !!doc.getElementById('dsh-translate-model'),
			modelItems: doc.getElementById('dsh-translate-model-popup')
				? doc.getElementById('dsh-translate-model-popup').querySelectorAll('menuitem').length
				: 0,
			modelHint: doc.getElementById('dsh-translate-model-hint')?.textContent?.slice(0, 120) ?? null,
			desktopBox: !!doc.getElementById('dsh-desktop-dir'),
			customPick: !!doc.getElementById('dsh-custom-pick'),
			desktopPick: !!doc.getElementById('dsh-desktop-pick'),
			installButton: !!doc.getElementById('dsh-install-bundled'),
			installRefresh: !!doc.getElementById('dsh-install-refresh'),
			installStatus: doc.getElementById('dsh-install-status')?.textContent?.slice(0, 120) ?? null,
			installDisabled: doc.getElementById('dsh-install-bundled')?.disabled ?? null,
			pickerReady: win.__dshPickerReady ?? null,
		};
		return out;
	}

	/** Test/diagnostic: run the context-menu AI refetch on given items. */
	async function opDebugRefetch(payload = {}) {
		const items = (Array.isArray(payload.items) ? payload.items : [payload.items])
			.map(id => Zotero.Items.get(Number(id)))
			.filter(item => item?.id && item.isRegularItem());
		if (items.length === 0) return { ok: false, error: 'no regular items' };
		// Same entry the context-menu command uses.
		const pane = Zotero.getActiveZoteroPane();
		void items;
		setTimeout(() => {
			try {
				// call the module's dispatch through the UI module
				DSH.Refetch.dispatch(Zotero.Items.get(items.map(i => i.id)));
			}
			catch (e) {
				DSH.Util.log('debug refetch failed', e);
			}
		}, 10);
		return { ok: true, count: items.length, ids: items.map(i => i.id) };
	}

	/** Test/diagnostic: run the GitHub update check on demand. payload:
	 * { install?: bool, forceVersion?: 'x.y.z' (fake the installed version),
	 *   timeoutMs?: number }. */
	async function opDebugUpdate(payload = {}) {
		const result = await DSH.Update.check({
			install: payload.install === true,
			forceVersion: payload.forceVersion ?? null,
		});
		return result;
	}

	/** Test/diagnostic: Zotero HTTP server prerequisite (the sidecar's tools
	 * call back over it). payload { enable?: bool } performs the one-click
	 * enable (pref + Zotero.Server.init(), live effect); otherwise read-only
	 * status. */
	async function opDebugHttpServer(payload = {}) {
		if (payload.enable === true) {
			const port = await Zotero.DSHinZotero.enableHttpServer();
			return { ok: true, enabled: port != null, port };
		}
		return { ok: true, ...Zotero.DSHinZotero.httpServerStatus() };
	}

	// --- WPS 文字引用加载项 ------------------------------------------------------

	/** 状态 → 给人看的一句话（设置面板与 agent 工具共用）。 */
	function wpsStatusText(status) {
		if (!status.wps) return '没有检测到 WPS 文字。';
		if (status.healthy) return `WPS 文字引用加载项工作正常（WPS ${status.wps.version || ''}，加载项 v${status.addon.version}）。`;
		return `WPS 文字引用需要修复：${status.issues.join('；')}。`;
	}

	/** 修复之后用户要做的事（文案只讲动作，不讲内部文件）。 */
	function wpsNextSteps(changed) {
		return [
			'完全退出 WPS（关掉所有 WPS 窗口），然后重新打开',
			changed ? '打开文档时 WPS 会弹一次「加载项“zotero-in-wps”首次加载，是否信任？」（升级后是「已经被修改，是否继续加载？」）——点「确定」' : null,
			'在 WPS 文字里打开一个文档，功能区里会出现「Zotero」选项卡：添加/编辑引文、添加/编辑书目、文档首选项、刷新等',
			'插引文时弹出的选择窗口属于 Zotero，操作期间保持 Zotero 在运行',
		].filter(Boolean);
	}

	async function opWpsStatus() {
		const status = await DSH.WPS.status();
		return { ...status, message: wpsStatusText(status) };
	}

	/** 一键修复：安装/更新加载项并重写登记；内容已正确时不动文件（不触发 WPS 的
	 * 「已修改」确认）。payload { force?: bool } 强制重写。修不了时抛带原因的错误
	 * （没装 WPS、文件写不进去），agent 工具和设置面板拿到的都是同一句话。 */
	async function opWpsFix(payload = {}) {
		const result = await DSH.WPS.install({ force: payload.force === true });
		if (!result.ok) throw fail(result.code ?? 'zotero/wps-repair-failed', result.message);
		if (result.changed) result.message += ' 重启 WPS 后生效。';
		result.nextSteps = wpsNextSteps(result.changed);
		return result;
	}

	async function opWpsUninstall() {
		const result = await DSH.WPS.uninstall();
		result.nextSteps = ['重启 WPS 后「Zotero」选项卡消失'];
		return result;
	}

	/** Test/diagnostic for the WPS add-in. payload { action: 'status' (default) |
	 * 'install' | 'uninstall', force?: bool } — same code paths as the settings
	 * pane's button and the agent tool. */
	async function opDebugWps(payload = {}) {
		const action = String(payload.action ?? 'status');
		if (action === 'install') return { ok: true, ...await DSH.WPS.install({ force: payload.force === true }) };
		if (action === 'uninstall') return { ok: true, ...await DSH.WPS.uninstall() };
		return { ok: true, ...await DSH.WPS.status() };
	}

	const OPS = {
		status: opStatus,
		search: opSearch,
		item: opItem,
		collections: opCollections,
		read: opRead,
		annotations: opAnnotations,
		update: opUpdate,
		add: opAdd,
		attach: opAttach,
		collection: opCollection,
		trash: opTrash,
		note: opNote,
		itemtypes: opItemTypes,
		open: opOpen,
		locate: opLocate,
		'reader.search': opReaderSearch,
		'reader.locate': opReaderLocate,
		'reader.annotate': opReaderAnnotate,
		notes: opNotes,
		'wps.status': opWpsStatus,
		'wps.fix': opWpsFix,
		'wps.uninstall': opWpsUninstall,
		'debug.open': opDebugOpen,
		'debug.state': opDebugState,
		'debug.detect': opDebugDetect,
		'debug.nav': opDebugNav,
		'debug.navremote': opDebugNavRemote,
		'debug.openreader': opDebugOpenReader,
		'debug.reader': opDebugReader,
		'debug.prefs': opDebugPrefs,
		'debug.cleanup': opDebugCleanup,
		'debug.refetch': opDebugRefetch,
		'debug.update': opDebugUpdate,
		'debug.httpserver': opDebugHttpServer,
		'debug.wps': opDebugWps,
	};

	function register() {
		unregister();
		for (const [name, handler] of Object.entries(OPS)) {
			const endpoint = function () {};
			endpoint.prototype = {
				supportedMethods: ['POST'],
				supportedDataTypes: ['application/json'],
				// Single-parameter init: return [status, contentType, body] (or a promise).
				init: async ({ headers, data }) => {
					const provided = headers?.[TOKEN_HEADER];
					if (!provided || provided !== token()) {
						Zotero.debug('dsh-in-zotero: bridge call with bad token');
						return [403, 'application/json', JSON.stringify({ ok: false, error: { code: 'zotero/bad-token', message: 'invalid bridge token' } })];
					}
					try {
						const result = await handler((data && typeof data === 'object') ? data : {});
						return [200, 'application/json', JSON.stringify(result)];
					}
					catch (e) {
						const status = e?.code === 'zotero/invalid-id' || e?.code === 'zotero/no-item' ? 404 : 400;
						log(`bridge op ${name} failed`, e?.message ?? e);
						return [status, 'application/json', JSON.stringify({
							ok: false,
							error: { code: e?.code ?? 'zotero/error', message: e?.message ?? String(e) },
						})];
					}
				},
			};
			Zotero.Server.Endpoints[PREFIX + name] = endpoint;
		}
		// DSH.Util.httpServerPort(), not Zotero.Server?.port — the getter throws
		// while the server is off (registration itself is port-independent).
		log(`bridge endpoints registered (${Object.keys(OPS).length} ops) on port ${DSH.Util.httpServerPort() ?? 'n/a'}`);
	}

	function unregister() {
		for (const name of Object.keys(OPS)) {
			delete Zotero.Server.Endpoints[PREFIX + name];
		}
	}

	return { register, unregister, OPS, annotateReaderText };
})();
