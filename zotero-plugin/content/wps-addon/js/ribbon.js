// Zotero in WPS 加载项 — 功能区（「Zotero」选项卡）入口。
//
// 按钮与 Word 版 Zotero 选项卡一一对应。所有点击都交给 ZW.Protocol.run：它异步
// 等待 Zotero（引文选择、文档首选项都是 Zotero 自己的窗口），期间 WPS 保持响应。
// WPS 在加载 ribbon.xml 时按名字查找这些全局函数（OnAddinLoad / OnAction / GetImage）。

function OnAddinLoad(ribbonUI) {
	try {
		if (typeof wps !== 'object' || !wps) return true;
		if (typeof wps.ribbonUI !== 'object' || !wps.ribbonUI) wps.ribbonUI = ribbonUI;
	}
	catch (e) { /* 拿不到 ribbonUI 只影响界面刷新，不影响功能 */ }
	return true;
}

// control.Id → Zotero 集成命令（名称即 Zotero.Integration.Interface 上的方法名）
const ZW_COMMANDS = {
	btnAddEditCitation: 'addEditCitation',
	btnAddEditBibliography: 'addEditBibliography',
	btnAddNote: 'addNote',
	btnAddAnnotation: 'addAnnotation',
	btnDocPrefs: 'setDocPrefs',
	btnRefresh: 'refresh',
	btnUnlink: 'removeCodes',
};

function OnAction(control) {
	const id = control && control.Id;
	if (id === 'btnAbout') {
		void ZW.Dialog.info(aboutText());
		return true;
	}
	const command = ZW_COMMANDS[id];
	if (command) void ZW.Protocol.run(command);
	return true;
}

function aboutText() {
	const config = window.ZOTERO_WPS_CONFIG || {};
	return 'Zotero 引用（WPS 文字版）· dsh-in-zotero\n\n'
		+ '加载项版本 ' + (config.addonVersion || '?') + (config.pluginVersion ? ' · 插件版本 ' + config.pluginVersion : '') + '\n\n'
		+ '在 WPS 文字里插入/编辑引文、参考文献表，与 Word 版 Zotero 插件读写同一种文档格式，\n'
		+ '同一份文档可以在 Word 与 WPS 之间接着写。引文样式、条目数据都来自你正在运行的 Zotero。\n\n'
		+ '遇到问题：在 Zotero 的「设置 → dsh-in-zotero → WPS 文字引用」里点「一键修复 WPS Zotero 引用」。';
}

function GetImage(control) {
	const id = control && control.Id;
	const images = {
		btnAddEditCitation: 'images/citation.svg',
		btnAddEditBibliography: 'images/bibliography.svg',
		btnAddNote: 'images/note.svg',
		btnAddAnnotation: 'images/annotation.svg',
		btnDocPrefs: 'images/prefs.svg',
		btnRefresh: 'images/refresh.svg',
		btnUnlink: 'images/unlink.svg',
		btnAbout: 'images/about.svg',
	};
	return images[id] || 'images/zotero.svg';
}
