var ZoteroManagementBridge;

function log(msg) {
  Zotero.debug("Zotero Management Bridge: " + msg);
}

function install() {
  log("Installed");
}

async function startup({ id, version, resourceURI, rootURI = resourceURI.spec }) {
  log("Starting");
  Services.scriptloader.loadSubScript(rootURI + "src/zotero-management-bridge.js");
  await ZoteroManagementBridge.start({ id, version, rootURI });
}

function onMainWindowLoad({ window }) {}

function onMainWindowUnload({ window }) {}

async function shutdown() {
  log("Shutting down");
  if (ZoteroManagementBridge) {
    await ZoteroManagementBridge.stop();
  }
  ZoteroManagementBridge = undefined;
}

function uninstall() {
  log("Uninstalled");
}
