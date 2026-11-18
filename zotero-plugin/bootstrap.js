/* dsh-in-zotero bootstrap — standard Zotero 7+ bootstrapped-plugin shape
 * (modeled on Zotero's official make-it-red sample and the installed
 * aiassistant plugin on this machine).
 *
 * Registers chrome://dsh-in-zotero/content/ and loads the plugin body into a
 * sandboxed sub-script context, then forwards main-window load/unload hooks.
 */

var chromeHandle;

function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
	await Zotero.initializationPromise;

	// String 'rootURI' introduced in Zotero 7
	if (!rootURI) {
		rootURI = resourceURI.spec;
	}

	var aomStartup = Components.classes[
		"@mozilla.org/addons/addon-manager-startup;1"
	].getService(Components.interfaces.amIAddonManagerStartup);
	var manifestURI = Services.io.newURI(rootURI + "manifest.json");
	chromeHandle = aomStartup.registerChrome(manifestURI, [
		["content", "dsh-in-zotero", rootURI + "content/"],
	]);

	// Global variables for plugin code.
	const ctx = {
		rootURI,
		ID: id,
		VERSION: version,
	};
	ctx._globalThis = ctx;
	ctx.ctx = ctx; // subscripts see the target's properties as globals, not the binding

	// Load modules in dependency order into the shared plugin scope.
	const scripts = [
		'content/scripts/util.js',
		'content/scripts/sidecar.js',
		'content/scripts/bridge.js',
		'content/scripts/translate.js',
		'content/scripts/refetch.js',
		'content/scripts/sessionWindow.js',
		'content/scripts/update.js',
		'content/scripts/index.js',
	];
	for (const script of scripts) {
		Services.scriptloader.loadSubScript(`chrome://dsh-in-zotero/${script}`, ctx);
	}
	Zotero.DSHinZotero.hooks.onStartup();
}

async function onMainWindowLoad({ window }, reason) {
	Zotero.DSHinZotero?.hooks.onMainWindowLoad(window);
}

async function onMainWindowUnload({ window }, reason) {
	Zotero.DSHinZotero?.hooks.onMainWindowUnload(window);
}

function shutdown({ id, version, resourceURI, rootURI }, reason) {
	if (reason === APP_SHUTDOWN) {
		return;
	}

	if (typeof Zotero === "undefined") {
		Zotero = Components.classes[
			"@zotero.org/Zotero;1"
		].getService(Components.interfaces.nsISupports).wrappedJSObject;
	}
	Zotero.DSHinZotero?.hooks.onShutdown();

	Cc["@mozilla.org/intl/stringbundle;1"]
		.getService(Components.interfaces.nsIStringBundleService)
		.flushBundles();

	for (const script of [
		'content/scripts/index.js',
		'content/scripts/update.js',
		'content/scripts/sessionWindow.js',
		'content/scripts/refetch.js',
		'content/scripts/translate.js',
		'content/scripts/bridge.js',
		'content/scripts/sidecar.js',
		'content/scripts/util.js',
	]) {
		Services.scriptloader.unload(`chrome://dsh-in-zotero/${script}`);
	}

	if (chromeHandle) {
		chromeHandle.destruct();
		chromeHandle = null;
	}
}
