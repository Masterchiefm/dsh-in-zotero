// The zotero_* agent tools. Every operation (except online lookup) is a call
// into the Zotero bridge (Zotero's own HTTP server → its own APIs), so the
// Zotero database is only ever touched by Zotero itself. Tool shapes follow
// dsh-zot-library's library_* tools, with numeric Zotero ids as handles.

import { call } from './zoteroClient.js'
import {
  detectIdentifiers, lookupDoi, lookupArxiv, lookupIsbn, lookupPmid,
  searchCrossref, titleScore, openAlexAbstract,
} from './metadata.js'

/** Strip values the harness's lossless-JSON tool-output check rejects. */
function lossless(value) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    return null
  }
  if (Array.isArray(value)) return value.map(lossless)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      out[key] = lossless(item)
    }
    return out
  }
  return value
}

function makeTool({ name, description, properties = {}, required = [], timeoutMs, execute }) {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
    output: {
      // 引擎强制的 JSON Schema 子集拒绝未知 type 值；「仅注解」schema 是它
      // 表达任意 JSON 的方式。（此前 `{ type: 'json' }` 让每个 register() 都
      // 抛错 —— 20 个 zotero_* 工具一个都到不了 agent，即 "unknown tool"
      // 报错的根源。）
      schema: { description: '工具执行结果（JSON 对象）' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    ...(timeoutMs ? { timeoutMs } : {}),
    async execute(args = {}, exec = null) {
      const signal = exec?.signal
      try {
        const result = await execute(args, signal)
        return lossless(result)
      }
      catch (error) {
        const message = String(error?.message ?? error)
        throw Object.assign(new Error(`[${error?.code ?? 'zotero/bridge-error'}] ${message}`), {
          code: error?.code,
        })
      }
    },
  }
}

/**
 * Build the tool set.
 * @param {object} [options]
 * @param {object} [options.logger]
 */
export function createTools({ logger = console } = {}) {
  return [
    makeTool({
      name: 'zotero_status',
      description: '检查与用户正在运行的 Zotero 的连接并返回文库概况（条目数、分类数、Zotero 版本）。调用任何其他 zotero_* 工具报错「无法连接 Zotero」时，先用它确认连通性，并把结果如实告知用户。',
      properties: {},
      async execute() {
        return call('status', {}, { timeoutMs: 15_000 })
      },
    }),
    makeTool({
      name: 'zotero_search',
      description: '按元数据检索文献条目（标题、作者、标签、DOI、期刊等），返回 {id,key,itemType,title,creator,year,hasAttachment} 摘要列表。后续 zotero_item / zotero_update 等用返回的数字 id。留空 query 可配合 collectionID/tag 浏览。无结果时换关键词变体重试（同义词、英文、单复数、可能的手误）。',
      properties: {
        query: { type: 'string', description: '自由文本检索词（中英文均可）；留空返回全部（受 limit 限制）' },
        collectionID: { type: 'number', description: '限定分类 id（来自 zotero_collections）' },
        tag: { type: 'string', description: '限定单个标签名' },
        limit: { type: 'number', description: '最多返回条数，默认 50，上限 200' },
      },
      async execute(args) {
        return call('search', args, { timeoutMs: 60_000 })
      },
    }),
    makeTool({
      name: 'zotero_item',
      description: '读取一个条目的完整信息：全部字段、作者、标签、所属分类（id 列表）、子附件（含本地真实路径 path）、子笔记、父条目。回答文献细节问题或准备修改前先用它核对现状。',
      properties: {
        id: { type: 'number', description: '条目数字 id（来自 zotero_search / zotero_item 的 parentID）', },
      },
      required: ['id'],
      async execute(args) {
        return call('item', { id: args.id })
      },
    }),
    makeTool({
      name: 'zotero_collections',
      description: '列出用户文库的全部分类（含所有层级的子分类），一次看清嵌套结构：collections 平铺清单每行含 id、名称、完整路径 path（「父 / 子 / 孙」）、parentID、level（顶层为 0）、直接子分类数、条目数，父分类排在子孙前；tree 是同一份数据的嵌套树。整理归类前先看它，再决定新建或复用分类；后续引用分类一律用行里的数字 id。',
      properties: {},
      async execute() {
        return call('collections', {}, { timeoutMs: 30_000 })
      },
    }),
    makeTool({
      name: 'zotero_read',
      description: '读取条目全文文本（优先 Zotero 自带的全文缓存，其次 Zotero 的 PDF 文本提取）。返回真实文件路径 path 与分页文本；给 search 参数时返回最多 5 处匹配上下文而非通读。回答具体数值/方法细节前先用 search 定位；从 PDF 里找 DOI/标识符时用 search:"doi.org" 或 offset:0 + maxChars:6000 读首页。二进制文件只返回 path，需要时用系统工具直接读该文件。',
      properties: {
        id: { type: 'number', description: '条目 id（普通条目自动取最佳附件；也可直接给附件 id）' },
        search: { type: 'string', description: '在全文中检索的关键词，命中处前后各取一段上下文' },
        offset: { type: 'number', description: '分页读取的起始字符偏移（配合返回的 nextOffset）' },
        maxChars: { type: 'number', description: '本次最多返回的字符数，默认 60000' },
      },
      required: ['id'],
      timeoutMs: 120_000,
      async execute(args) {
        return call('read', args, { timeoutMs: 120_000 })
      },
    }),
    makeTool({
      name: 'zotero_identify',
      description: '一步识别条目的权威元数据（更新/补全/重取元数据任务的首选第一步，不要用 zotero_read + zotero_lookup 手工拼凑其内部流程）。id 也可以直接给**独立附件**的 id（拖进库还没识别的 PDF 等）——它会读该附件的首页文本来识别。内部流程：读条目现状与附件首页文本 → 从 DOI/URL/文本提取 DOI、arXiv、ISBN、PMID → 按强度依次联网解析（Crossref → doi.org → OpenAlex 摘要补全 → arXiv → PubMed）→ 与条目现有标题交叉比对打分。命中时返回 draft（普通条目可直接拆成 zotero_update 的 itemType/fields/creators；独立附件则交给 zotero_add 新建条目并挂接）与 titleMatch（≥0.6 视为同源）；未命中标识符时按题名返回 candidates 列表（含 titleMatch 与 score，择优用 zotero_lookup 复核）。',
      properties: {
        id: { type: 'number', description: '条目数字 id，或独立附件的 id（来自 zotero_search / zotero_item / 任务描述）' },
        text: { type: 'string', description: '可选：已掌握的文本片段（如文件名、标题行），作为额外语料参与标识符提取' },
      },
      required: ['id'],
      timeoutMs: 150_000,
      async execute(args) {
        const detail = await call('item', { id: args.id }, { timeoutMs: 60_000 })
        const item = detail?.item ?? {}
        const fields = item.fields ?? {}
        const current = {
          id: args.id,
          title: item.title ?? fields.title ?? '',
          itemType: item.itemType ?? '',
          existingDOI: fields.DOI ?? '',
        }
        // Attachment first page: where PDFs carry their DOI / arXiv stamp.
        let firstPage = ''
        try {
          const page = await call('read', { id: args.id, offset: 0, maxChars: 8000 }, { timeoutMs: 90_000 })
          firstPage = page?.kind === 'text' ? String(page.text ?? '') : ''
        }
        catch {
          // No attachment (or unreadable) — title-only search still applies.
        }
        const haystack = [fields.DOI, fields.url, fields.archiveID, args.text, firstPage]
          .filter(Boolean).join('\n')
        const detected = detectIdentifiers(haystack)
        const attempts = []
        const attempt = async (label, run) => {
          attempts.push(label)
          try { return await run() } catch { return undefined }
        }
        let draft
        if (fields.DOI) draft = await attempt(`field-doi:${fields.DOI}`, () => lookupDoi(String(fields.DOI)))
        if (!draft && detected.doi) draft = await attempt(`doi:${detected.doi}`, () => lookupDoi(detected.doi))
        if (!draft && detected.arxiv) draft = await attempt(`arxiv:${detected.arxiv}`, () => lookupArxiv(detected.arxiv))
        if (!draft && detected.isbn) draft = await attempt(`isbn:${detected.isbn}`, () => lookupIsbn(detected.isbn))
        if (!draft && detected.pmid) draft = await attempt(`pmid:${detected.pmid}`, () => lookupPmid(detected.pmid))
        const round2 = value => Math.round(value * 100) / 100
        const withScore = (entry) => ({ ...entry, titleMatch: round2(titleScore(current.title, entry?.fields?.title ?? '')) })
        const evidence = {
          detectedIdentifiers: detected,
          firstPageChars: firstPage.length,
          attempts,
        }
        if (draft) {
          const scored = withScore(draft)
          if (!scored.fields.abstractNote && scored.fields.DOI) {
            const abstract = await openAlexAbstract(scored.fields.DOI)
            if (abstract) scored.fields.abstractNote = abstract
          }
          return {
            ok: true,
            found: true,
            current,
            evidence,
            draft: scored,
            note: scored.titleMatch >= 0.6
              ? '标题同源，核对作者/年份后可直接交给 zotero_update 写回'
              : '标题相似度低：先人工确认是否同一文献，再决定写回',
          }
        }
        const query = String(current.title || args.text || '')
        const candidates = query.length >= 6 ? await searchCrossref(query, { rows: 5 }) : []
        const ranked = candidates.map(withScore)
        if (ranked[0] && !ranked[0].fields.abstractNote && ranked[0].fields.DOI) {
          const abstract = await openAlexAbstract(ranked[0].fields.DOI)
          if (abstract) ranked[0].fields.abstractNote = abstract
        }
        return {
          ok: true,
          found: ranked.length > 0,
          current,
          evidence,
          candidates: ranked,
          hint: ranked.length > 0
            ? '未解析出标识符；candidates 为题名检索结果，选 titleMatch ≥ 0.8 且作者/年份吻合者（可用 zotero_lookup 复核）'
            : '未解析出标识符且题名检索无结果；可尝试 zotero_lookup 换题名变体重试，或用 web 搜索',
        }
      },
    }),
    makeTool({
      name: 'zotero_annotations',
      description: '读取用户在条目附件上做的批注（高亮/下划线/笔记，含文本、评论、颜色、页码）。',
      properties: {
        id: { type: 'number', description: '条目 id（自动取最佳附件）或附件 id' },
      },
      required: ['id'],
      async execute(args) {
        return call('annotations', { id: args.id })
      },
    }),
    makeTool({
      name: 'zotero_reader_search',
      description: '在用户当前打开的 Zotero PDF 阅读器里检索文本，返回每一处命中的页码（page/pageIndex）、命中原文 text 与上下文片段（坐标系与阅读器一致，可直接用于跳转/标记）。用户问「某段/某内容在哪里」时先用它找位置。query 用文中原词片段（大小写不敏感，跨行断词也按原文顺序给出）；阅读器未打开时返回 open:false（可改用 zotero_read，但无页码）。',
      properties: {
        id: { type: 'number', description: '条目 id（自动取最佳附件）或附件 id；须与当前打开的 PDF 相同' },
        query: { type: 'string', description: '要检索的原文片段（不要用改写或总结，用文中原词）' },
        limit: { type: 'number', description: '最多返回命中数，默认 5，上限 20' },
      },
      required: ['id', 'query'],
      timeoutMs: 120_000,
      async execute(args) {
        return call('reader.search', args, { timeoutMs: 120_000 })
      },
    }),
    makeTool({
      name: 'zotero_reader_locate',
      description: '在 Zotero 阅读器中跳转到指定位置并标出来给用户看：滚动到目标并闪光高亮；mark:"highlight"/"underline" 时同时创建真实批注（可用 color、comment），用户立刻能在 PDF 里看到。用户问「在哪/带我去看/标出来」时用：先 zotero_reader_search 找到命中，再本工具传其 pageIndex+text。PDF 未打开会自动打开该附件。',
      properties: {
        id: { type: 'number', description: '条目 id（自动取最佳附件）或附件 id' },
        pageIndex: { type: 'number', description: '0 起始的页序号（来自 zotero_reader_search 的 hits[].pageIndex）' },
        text: { type: 'string', description: '要精确定位/标记的原文片段（来自 search 的 text）；省略则只跳到该页页首' },
        mark: { type: 'string', enum: ['highlight', 'underline'], description: '跳转后在原文上创建的批注类型；省略则只闪光定位、不落批注' },
        color: { type: 'string', description: '颜色会吸附到 Zotero 批注色板最近色：黄#ffd400 红#ff6666 绿#5fb236 蓝#2ea8e5 紫#a28ae5 品红#e56eee 橙#f19837 灰#aaaaaa；默认黄' },
        comment: { type: 'string', description: '批注评论（说明为什么标这里，用户可见）' },
      },
      required: ['id', 'pageIndex'],
      timeoutMs: 120_000,
      async execute(args) {
        return call('reader.locate', args, { timeoutMs: 120_000 })
      },
    }),
    makeTool({
      name: 'zotero_reader_annotate',
      description: '在当前打开的 PDF 上创建真实批注：高亮或下划线指定原文片段，可带评论与颜色（不动位置、不跳转）。给某句话加高亮/划线/评论时用；「跳转并标出来」用 zotero_reader_locate；修改或删除已有批注目前不支持。',
      properties: {
        id: { type: 'number', description: '条目 id（自动取最佳附件）或附件 id' },
        pageIndex: { type: 'number', description: '0 起始的页序号（来自 zotero_reader_search）' },
        text: { type: 'string', description: '要标记的原文片段（来自 search 的 text）' },
        type: { type: 'string', enum: ['highlight', 'underline'], description: '默认 highlight' },
        color: { type: 'string', description: '颜色会吸附到 Zotero 批注色板最近色：黄#ffd400 红#ff6666 绿#5fb236 蓝#2ea8e5 紫#a28ae5 品红#e56eee 橙#f19837 灰#aaaaaa；默认黄' },
        comment: { type: 'string', description: '批注评论' },
      },
      required: ['id', 'pageIndex', 'text'],
      timeoutMs: 120_000,
      async execute(args) {
        return call('reader.annotate', args, { timeoutMs: 120_000 })
      },
    }),
    makeTool({
      name: 'zotero_update',
      description: '修改已有条目：设置或清除字段（fields 值为 null 即清除）、整体替换作者/标签、加入或移出分类、更换条目类型。更新元数据（题名/作者/年份/期刊/DOI 等）时同步维护：shortTitle 写中文 10~20 字的重点概括（关注点/方法/结论要点，不是标题翻译）；abstractNote 保持忠实的原文摘要（缺失时可用 zotero_read 读全文提炼，拿不到就留空，不要编造）。所有写入都由 Zotero 自己的接口完成（可撤销、可同步），不会绕过或阻塞 Zotero。',
      properties: {
        id: { type: 'number', description: '条目数字 id' },
        itemType: { type: 'string', description: '新条目类型（合法值见 zotero_itemtypes），如 journalArticle / preprint / conferencePaper' },
        fields: { type: 'object', description: '字段名 → 值；值为 null 表示清除该字段' },
        creators: { type: 'array', items: { type: 'object' }, description: '替换后的作者列表：[{firstName,lastName,creatorType}]，机构作者用 {fieldMode:1,lastName:机构名}' },
        tags: { type: 'array', items: { type: 'string' }, description: '替换后的标签列表' },
        addCollections: { type: 'array', items: { type: 'number' }, description: '要加入的分类 id 列表' },
        removeCollections: { type: 'array', items: { type: 'number' }, description: '要移出的分类 id 列表' },
      },
      required: ['id'],
      timeoutMs: 120_000,
      async execute(args) {
        return call('update', args, { timeoutMs: 120_000 })
      },
    }),
    makeTool({
      name: 'zotero_add',
      description: '新建条目。字段名用 Zotero 标准名（title、publicationTitle、date、DOI、abstractNote…，合法值见 zotero_itemtypes）。**DOI 与 url 字段就是条目的「链接」**——入库类任务务必带上，即使拿不到 PDF，条目加链接也是完整的交付物。shortTitle 写中文 10~20 字的重点概括；abstractNote 原样带入检索到的原文摘要。adoptAttachmentIDs 把库里已有的**独立附件**（无父条目的 PDF 等）挂到新条目名下——「为没信息的附件识别建条目」就用它，一次调用完成建条目+挂接，绝不要再用 zotero_attach 重新导入同一文件（会复制出第二份）；新条目自动继承附件原在的分类。建好后用 zotero_locate {id} 在列表里定位高亮给用户看，还可用 zotero_update 的 addCollections 归类、用 zotero_attach 挂其他文件。',
      properties: {
        itemType: { type: 'string', description: '条目类型，如 journalArticle' },
        fields: { type: 'object', description: '字段名 → 值' },
        creators: { type: 'array', items: { type: 'object' }, description: '作者列表' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签列表' },
        collectionIDs: { type: 'array', items: { type: 'number' }, description: '要加入的分类 id 列表' },
        adoptAttachmentIDs: { type: 'array', items: { type: 'number' }, description: '要挂到新条目名下的独立附件 id 列表（附件必须当前没有父条目）' },
      },
      required: ['itemType'],
      timeoutMs: 60_000,
      async execute(args) {
        return call('add', args, { timeoutMs: 60_000 })
      },
    }),
    makeTool({
      name: 'zotero_attach',
      description: '添加附件：path 为本地文件绝对路径（经 Zotero 导入并复制进其存储目录）或 url 为网页链接附件，默认挂到 id 指定的父条目上；standalone:true 时不挂父条目、作为独立附件先入库（「先收下这个 PDF，之后再识别建条目」的场景，之后用 zotero_add 的 adoptAttachmentIDs 挂到正式条目）。用户要求「把某 PDF 关联到这条文献」时用默认模式。',
      properties: {
        id: { type: 'number', description: '父条目数字 id（standalone 模式省略）' },
        path: { type: 'string', description: '本地文件绝对路径；给了 path 就忽略 url' },
        url: { type: 'string', description: '网页链接（http/https）' },
        title: { type: 'string', description: '链接附件的标题，默认用 URL' },
        standalone: { type: 'boolean', description: 'true 时不挂父条目，作为独立附件入库' },
      },
      timeoutMs: 180_000,
      async execute(args) {
        return call('attach', args, { timeoutMs: 180_000 })
      },
    }),
    makeTool({
      name: 'zotero_collection',
      description: '管理分类（collections）：create 新建（可指定父分类）、rename 重命名、trash 移入回收站。整理文库、按主题归类时配合 zotero_update 的 addCollections/removeCollections 移动条目。',
      properties: {
        action: { type: 'string', enum: ['create', 'rename', 'trash'], description: '默认 create' },
        name: { type: 'string', description: '分类名（create/rename 必需）' },
        id: { type: 'number', description: '分类 id（rename/trash 必需，来自 zotero_collections）' },
        parentID: { type: 'number', description: '父分类 id（create 可选）' },
      },
      async execute(args) {
        return call('collection', args, { timeoutMs: 60_000 })
      },
    }),
    makeTool({
      name: 'zotero_trash',
      description: '把条目移入回收站 / 恢复 / 彻底删除（action = trash | restore | delete）。删除是可撤销的（Zotero 回收站）；彻底删除前必须先向用户确认。',
      properties: {
        id: { type: 'number', description: '条目数字 id' },
        action: { type: 'string', enum: ['trash', 'restore', 'delete'], description: '默认 trash' },
      },
      required: ['id'],
      async execute(args) {
        return call('trash', args, { timeoutMs: 60_000 })
      },
    }),
    makeTool({
      name: 'zotero_note',
      description: '创建或更新笔记：给 parentID 建子笔记（不传 id），或改写 id 指向的现有笔记全文（支持 HTML）。注意是整篇替换：改写前先 zotero_notes 读出原文，在原文基础上改，避免丢内容。',
      properties: {
        id: { type: 'number', description: '现有笔记的 id（更新模式）' },
        parentID: { type: 'number', description: '父条目 id（创建子笔记）' },
        text: { type: 'string', description: '笔记内容（HTML 或纯文本）' },
      },
      required: ['text'],
      async execute(args) {
        return call('note', args, { timeoutMs: 60_000 })
      },
    }),
    makeTool({
      name: 'zotero_notes',
      description: '读取条目（或指定笔记 id）的全部笔记全文（HTML，单篇超 2 万字截断）。先 zotero_item 看笔记列表拿 id，再用本工具读全文；新增/改写用 zotero_note。',
      properties: {
        id: { type: 'number', description: '条目 id（读其全部子笔记）或笔记 id（读这一篇）' },
      },
      required: ['id'],
      async execute(args) {
        return call('notes', { id: args.id }, { timeoutMs: 60_000 })
      },
    }),
    makeTool({
      name: 'zotero_itemtypes',
      description: '列出全部 Zotero 条目类型及其合法字段与作者类型。zotero_update / zotero_add 报「字段无效」或要更换 itemType 前，用它核对字段名。',
      properties: {},
      async execute() {
        return call('itemtypes', {}, { timeoutMs: 30_000 })
      },
    }),
    makeTool({
      name: 'zotero_lookup',
      description: '联网检索文献元数据（不写入文库）：identifier 支持 DOI / ISBN / arXiv id / PMID；query 用题名做 Crossref 书目检索并按标题相似度排序。返回可直接交给 zotero_add 的 {itemType, fields, creators, tags} 草稿。',
      properties: {
        identifier: { type: 'string', description: 'DOI（10.…/…）、ISBN、arXiv id（如 2401.12345）、PMID' },
        query: { type: 'string', description: '题名 / 书目检索词（与 identifier 二选一）' },
      },
      timeoutMs: 90_000,
      async execute(args) {
        if (args.identifier) {
          const value = String(args.identifier).trim()
          const doi = /\b(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)\b/i.exec(value)?.[1]
          const arxiv = /(?:arxiv[:\s./]*)(\d{4}\.\d{4,5})(?:v\d+)?/i.exec(value)?.[1]
          const isbn = /\b(97[89]\d{10}|\d{9}[\dX])\b/.exec(value.replace(/[-\s]/g, ''))?.[1]
          const pmid = /\b(?:pmid[:\s]*|pubmed[:\s\/]*id[:\s]*)(\d{5,9})\b/i.exec(value)?.[1]
          const draft = doi ? await lookupDoi(doi.replace(/[.,;]+$/, ''))
            : arxiv ? await lookupArxiv(arxiv)
              : isbn ? await lookupIsbn(isbn)
                : pmid ? await lookupPmid(pmid)
                  : /^\d{5,9}$/.test(value) ? await lookupPmid(value)
                    : undefined
          if (draft) return { ok: true, found: true, draft }
          return { ok: true, found: false, hint: '未命中，可改用 query 按题名检索。' }
        }
        if (args.query) {
          const cleaned = queryFromFileName(String(args.query))
          const candidates = await searchCrossref(cleaned, { rows: 5 })
          const ranked = candidates
            .map(draft => ({ draft, score: titleScore(cleaned, draft.fields.title) }))
            .sort((a, b) => b.score - a.score)
          return {
            ok: true,
            found: ranked.length > 0,
            candidates: ranked.map(({ draft, score }) => ({ score, draft })),
          }
        }
        throw Object.assign(new Error('需要 identifier 或 query 之一'), { code: 'zotero/invalid' })
      },
    }),
    makeTool({
      name: 'zotero_open',
      description: '在系统中打开条目的最佳附件（action=open）或在资源管理器中显示文件（action=reveal）。无本地文件时打开其 URL/DOI 链接。',
      properties: {
        id: { type: 'number', description: '条目或附件 id' },
        action: { type: 'string', enum: ['open', 'reveal'], description: '默认 open' },
      },
      required: ['id'],
      async execute(args) {
        return call('open', args, { timeoutMs: 30_000 })
      },
    }),
    makeTool({
      name: 'zotero_locate',
      description: '在 Zotero 文献列表中定位并高亮一个条目：自动切到能显示它的视图（当前分类，必要时回退库根或回收站），选中并滚动到该条目，用户立刻能在列表里看到。新建条目后用它把结果亮给用户看；用户问「某文献在库里哪里」时也用它。给附件 id 时定位其父条目。',
      properties: {
        id: { type: 'number', description: '条目数字 id（附件 id 会定位到其父条目）' },
        focus: { type: 'boolean', description: '默认 true：把文献列表标签页带到前台；false 时仅后台选中（用户当前停在别处时不打扰）' },
      },
      required: ['id'],
      timeoutMs: 30_000,
      async execute(args) {
        return call('locate', args, { timeoutMs: 30_000 })
      },
    }),
  ]
}
