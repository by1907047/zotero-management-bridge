var ZoteroManagementBridge = {
  id: null,
  version: null,
  rootURI: null,
  timer: null,
  running: false,
  queueRoot: null,
  cloudBase: "",
  reportMode: "summary",
  intervalMs: 2500,

  async start({ id, version, rootURI }) {
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
    this.configure();
    await this.ensureQueueDirs();
    this.timer = setInterval(() => {
      this.tick().catch(e => this.log("tick failed: " + (e && e.stack || e)));
    }, this.intervalMs);
    await this.writeStartupStatus();
    this.log("Started");
  },

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.log("Stopped");
  },

  log(message) {
    Zotero.debug("Zotero Management Bridge: " + message);
  },

  pref(name, fallback) {
    try {
      let value = Zotero.Prefs.get(`extensions.zoteroManagementBridge.${name}`);
      if (value !== undefined && value !== null && value !== "") return value;
    }
    catch (e) {}
    return fallback;
  },

  profileDir() {
    try {
      if (typeof Zotero !== "undefined" && Zotero.Profile && Zotero.Profile.dir) {
        return Zotero.Profile.dir;
      }
    }
    catch (e) {}
    try {
      if (typeof Services !== "undefined" && Services.dirsvc) {
        return Services.dirsvc.get("ProfD", Ci.nsIFile).path;
      }
    }
    catch (e) {}
    try {
      if (typeof OS !== "undefined" && OS.Constants && OS.Constants.Path && OS.Constants.Path.profileDir) {
        return OS.Constants.Path.profileDir;
      }
    }
    catch (e) {}
    try {
      if (typeof Zotero !== "undefined" && Zotero.DataDirectory && Zotero.DataDirectory.dir) {
        return Zotero.DataDirectory.dir;
      }
    }
    catch (e) {}
    throw new Error("Cannot determine Zotero profile directory; configure extensions.zoteroManagementBridge.queueRoot");
  },

  defaultQueueRoot() {
    return PathUtils.join(this.profileDir(), "zotero-management-bridge", "queue");
  },

  configure() {
    this.queueRoot = this.pref("queueRoot", this.defaultQueueRoot());
    this.cloudBase = this.pref("cloudBase", "");
    this.reportMode = this.pref("reportMode", "summary");
    let interval = parseInt(this.pref("intervalMs", this.intervalMs), 10);
    if (Number.isFinite(interval) && interval > 0) {
      this.intervalMs = interval;
    }
  },

  getCloudBase(args, options = {}) {
    let cloudBase = args.cloudBase || this.cloudBase || "";
    if (options.required && !cloudBase) {
      throw new Error("cloudBase is required for this operation. Configure extensions.zoteroManagementBridge.cloudBase or pass args.cloudBase.");
    }
    return cloudBase;
  },

  dir(name) {
    return PathUtils.join(this.queueRoot, name);
  },

  async ensureDir(path) {
    if (typeof IOUtils !== "undefined" && IOUtils.makeDirectory) {
      await IOUtils.makeDirectory(path, { ignoreExisting: true, createAncestors: true });
      return;
    }
    let file = Zotero.File.pathToFile(path);
    if (!file.exists()) {
      file.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
    }
  },

  async ensureQueueDirs() {
    await this.ensureDir(this.queueRoot);
    await this.ensureDir(this.dir("requests"));
    await this.ensureDir(this.dir("responses"));
    await this.ensureDir(this.dir("processed"));
    await this.ensureDir(this.dir("failed"));
  },

  async exists(path) {
    try {
      if (typeof IOUtils !== "undefined" && await IOUtils.exists(path)) return true;
    }
    catch (e) {}
    try {
      let file = Zotero.File.pathToFile(path);
      return !!file && file.exists();
    }
    catch (e) {
      return false;
    }
  },

  async readText(path) {
    if (typeof IOUtils !== "undefined" && IOUtils.readUTF8) {
      return await IOUtils.readUTF8(path);
    }
    return await Zotero.File.getContentsAsync(path);
  },

  async writeText(path, text) {
    await this.ensureDir(PathUtils.parent(path));
    if (Zotero.File.putContentsAsync) {
      return await Zotero.File.putContentsAsync(path, text);
    }
    if (Zotero.File.putContents) {
      return Zotero.File.putContents(path, text);
    }
    if (typeof IOUtils !== "undefined" && IOUtils.writeUTF8) {
      return await IOUtils.writeUTF8(path, text);
    }
    throw new Error("No Zotero text-file writer is available");
  },

  async remove(path) {
    if (typeof IOUtils !== "undefined" && IOUtils.remove) {
      await IOUtils.remove(path, { ignoreAbsent: true });
      return;
    }
    let file = Zotero.File.pathToFile(path);
    if (file.exists()) file.remove(false);
  },

  async copyFile(src, dst) {
    await this.ensureDir(PathUtils.parent(dst));
    if (typeof IOUtils !== "undefined" && IOUtils.copy) {
      await IOUtils.copy(src, dst, { noOverwrite: false });
      return;
    }
    let source = Zotero.File.pathToFile(src);
    let parent = Zotero.File.pathToFile(PathUtils.parent(dst));
    source.copyTo(parent, PathUtils.filename(dst));
  },

  async moveFile(src, dst) {
    await this.ensureDir(PathUtils.parent(dst));
    if (typeof IOUtils !== "undefined" && IOUtils.move) {
      await IOUtils.move(src, dst);
      return;
    }
    let source = Zotero.File.pathToFile(src);
    let parent = Zotero.File.pathToFile(PathUtils.parent(dst));
    source.moveTo(parent, PathUtils.filename(dst));
  },

  normalizeSlashes(path) {
    return (path || "").replace(/\\/g, "/");
  },

  leafName(path) {
    return this.normalizeSlashes(path).split("/").pop();
  },

  getStoredLeafName(attachment, expectedPath) {
    let path = attachment.attachmentPath || "";
    if (path.startsWith("storage:")) {
      return path.slice("storage:".length);
    }
    return this.leafName(expectedPath || path);
  },

  async allAttachmentItems() {
    let search = new Zotero.Search();
    search.libraryID = Zotero.Libraries.userLibraryID;
    search.addCondition("itemType", "is", "attachment");
    let ids = await search.search();
    return await Zotero.Items.getAsync(ids);
  },

  linkedPathIndex(attachments) {
    let index = new Set();
    for (let attachment of attachments) {
      if (!attachment || !attachment.isAttachment || !attachment.isAttachment()) continue;
      if (!attachment.isLinkedFileAttachment || !attachment.isLinkedFileAttachment()) continue;
      index.add(this.normalizeSlashes(attachment.attachmentPath || ""));
    }
    return index;
  },

  linkedPathMap(attachments) {
    let map = new Map();
    for (let attachment of attachments) {
      if (!attachment || !attachment.isAttachment || !attachment.isAttachment()) continue;
      if (!attachment.isLinkedFileAttachment || !attachment.isLinkedFileAttachment()) continue;
      let path = this.normalizeSlashes(attachment.attachmentPath || "");
      if (!map.has(path)) map.set(path, []);
      map.get(path).push(attachment);
    }
    return map;
  },

  async createLinkedAttachmentWithoutIndexing(options) {
    return await Zotero.DB.executeTransaction(async function () {
      let item = new Zotero.Item("attachment");
      item.libraryID = Zotero.Libraries.userLibraryID;
      item.parentID = options.parentItemID || undefined;
      item.attachmentLinkMode = Zotero.Attachments.LINK_MODE_LINKED_FILE;
      item.attachmentContentType = options.contentType || "application/octet-stream";
      item.attachmentPath = Zotero.Attachments.BASE_PATH_PLACEHOLDER + options.relativePath;
      item.setField("title", options.title);
      if (!options.parentItemID && options.collections && options.collections.length) {
        item.setCollections(options.collections);
      }
      await item.save(options.saveOptions || {});
      return item;
    });
  },

  async writeStartupStatus() {
    let statusPath = PathUtils.join(this.queueRoot, "bridge_status.json");
    await this.writeText(statusPath, JSON.stringify({
      ok: true,
      bridge: "Zotero Management Bridge",
      version: this.version,
      pluginID: this.id,
      queueRoot: this.queueRoot,
      cloudBase: this.cloudBase,
      reportMode: this.reportMode,
      updatedAt: new Date().toISOString()
    }, null, 2));
  },

  async listRequestFiles() {
    let requestsDir = this.dir("requests");
    let entries = await IOUtils.getChildren(requestsDir);
    return entries.filter(path => path.toLowerCase().endsWith(".json")).sort();
  },

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.ensureQueueDirs();
      let files = await this.listRequestFiles();
      for (let file of files) {
        await this.processRequestFile(file);
      }
    }
    finally {
      this.running = false;
    }
  },

  async processRequestFile(path) {
    let request;
    let id = PathUtils.filename(path).replace(/\.json$/i, "");
    try {
      request = JSON.parse(await this.readText(path));
      id = request.id || id;
      let result = await this.handleRequest(request);
      result.id = id;
      result.operation = request.operation;
      result.mode = request.mode || "dry-run";
      result.ok = result.ok !== false;
      result.finishedAt = new Date().toISOString();
      let responsePath = PathUtils.join(this.dir("responses"), `${id}.json`);
      await this.writeText(responsePath, JSON.stringify(result, null, 2));
      await this.moveFile(path, PathUtils.join(this.dir("processed"), PathUtils.filename(path)));
    }
    catch (e) {
      let error = {
        id,
        ok: false,
        error: String(e && e.stack || e),
        finishedAt: new Date().toISOString()
      };
      await this.writeText(PathUtils.join(this.dir("responses"), `${id}.json`), JSON.stringify(error, null, 2));
      try {
        await this.moveFile(path, PathUtils.join(this.dir("failed"), PathUtils.filename(path)));
      }
      catch (moveError) {
        this.log("failed to move failed request: " + moveError);
      }
    }
  },

  async handleRequest(request) {
    let operation = request.operation;
    let mode = request.mode || "dry-run";
    let args = request.args || {};
    if (!["dry-run", "apply"].includes(mode)) {
      throw new Error(`Invalid mode: ${mode}`);
    }
    if (operation === "status") return await this.operationStatus(args);
    if (operation === "inspect") return await this.operationInspect(args);
    if (operation === "copy-stored-to-cloud") return await this.operationCopyStoredToCloud(mode, args);
    if (operation === "create-linked-copies") return await this.operationCreateLinkedCopies(mode, args);
    if (operation === "cleanup-old-stored") return await this.operationCleanupOldStored(mode, args);
    if (operation === "link-file-to-item") return await this.operationLinkFileToItem(mode, args);
    if (operation === "import-file-to-item") return await this.operationImportFileToItem(mode, args);
    if (operation === "trash-items-by-key") return await this.operationTrashItemsByKey(mode, args);
    if (operation === "erase-trash-by-key") return await this.operationEraseTrashByKey(mode, args);
    throw new Error(`Unknown operation: ${operation}`);
  },

  async operationStatus(args) {
    return {
      ok: true,
      zoteroVersion: Zotero.version,
      pluginVersion: this.version,
      queueRoot: this.queueRoot,
      cloudBase: args.cloudBase || this.cloudBase,
      reportMode: this.reportMode,
      userLibraryID: Zotero.Libraries.userLibraryID
    };
  },

  async operationInspect(args) {
    let attachments = await this.allAttachmentItems();
    let summary = {
      checkedAttachments: attachments.length,
      storedFileAttachments: 0,
      linkedFileAttachments: 0,
      htmlSnapshots: 0,
      linkedURLs: 0,
      otherAttachments: 0,
      storedSourceMissing: 0,
      storedCloudPresent: 0,
      storedCloudMissing: 0
    };
    let details = [];
    let cloudBase = this.getCloudBase(args);
    for (let attachment of attachments) {
      let detail = this.attachmentDetail(attachment, cloudBase);
      if (attachment.isLinkedFileAttachment && attachment.isLinkedFileAttachment()) {
        summary.linkedFileAttachments++;
        detail.category = "linked-file";
      }
      else if (attachment.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_URL) {
        summary.linkedURLs++;
        detail.category = "linked-url";
      }
      else if ((attachment.attachmentContentType || "").toLowerCase() === "text/html") {
        summary.htmlSnapshots++;
        detail.category = "html-snapshot";
      }
      else if (attachment.isStoredFileAttachment && attachment.isStoredFileAttachment()) {
        summary.storedFileAttachments++;
        detail.category = "stored-file";
        detail.sourceExists = await this.exists(detail.sourcePath);
        detail.cloudExists = await this.exists(detail.cloudTarget);
        if (!detail.sourceExists) summary.storedSourceMissing++;
        if (detail.cloudExists) summary.storedCloudPresent++;
        else summary.storedCloudMissing++;
      }
      else {
        summary.otherAttachments++;
        detail.category = "other";
      }
      details.push(detail);
    }
    return { ok: true, summary, details };
  },

  attachmentDetail(attachment, cloudBase) {
    let expectedPath = "";
    try {
      expectedPath = attachment.getFilePath ? attachment.getFilePath() : "";
    }
    catch (e) {}
    let name = this.getStoredLeafName(attachment, expectedPath);
    let relativePath = `storage/${attachment.key}/${name}`;
    return {
      key: attachment.key,
      itemID: attachment.id,
      parentItemID: attachment.parentID || null,
      title: attachment.getField("title") || "",
      contentType: attachment.attachmentContentType || "",
      linkMode: attachment.attachmentLinkMode,
      path: attachment.attachmentPath || "",
      fileName: name,
      relativePath,
      sourcePath: expectedPath,
      cloudTarget: cloudBase ? PathUtils.join(cloudBase, "storage", attachment.key, name) : null
    };
  },

  isAbsoluteWindowsPath(path) {
    return /^[A-Za-z]:[\\/]/.test(path || "");
  },

  filePathToRelativeCloudPath(filePath, cloudBase) {
    let normalizedFile = this.normalizeSlashes(filePath);
    let normalizedBase = this.normalizeSlashes(cloudBase).replace(/\/+$/, "");
    let lowerFile = normalizedFile.toLowerCase();
    let lowerBase = normalizedBase.toLowerCase();
    if (lowerFile === lowerBase) {
      return "";
    }
    if (lowerFile.startsWith(lowerBase + "/")) {
      return normalizedFile.slice(normalizedBase.length + 1);
    }
    return null;
  },

  async mimeTypeForPath(path, fallback) {
    if (fallback) return fallback;
    try {
      return await Zotero.MIME.getMIMETypeFromFile(Zotero.File.pathToFile(path));
    }
    catch (e) {
      return "application/octet-stream";
    }
  },

  async getItemByKey(key) {
    let libraryID = Zotero.Libraries.userLibraryID;
    if (Zotero.Items.getByLibraryAndKeyAsync) {
      try {
        let item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
        if (item) return item;
      }
      catch (e) {
        this.log("getByLibraryAndKeyAsync failed, trying fallback: " + (e && e.message || e));
      }
    }
    if (Zotero.Items.getByLibraryAndKey) {
      try {
        let item = Zotero.Items.getByLibraryAndKey(libraryID, key);
        if (item) return item;
      }
      catch (e) {
        this.log("getByLibraryAndKey failed, trying DB fallback: " + (e && e.message || e));
      }
    }
    if (Zotero.DB && Zotero.DB.valueQueryAsync) {
      let itemID = await Zotero.DB.valueQueryAsync(
        "SELECT itemID FROM items WHERE libraryID=? AND key=?",
        [libraryID, key]
      );
      if (itemID) {
        let item = await Zotero.Items.getAsync(itemID);
        return Array.isArray(item) ? item[0] : item;
      }
    }
    return null;
  },

  async findItemByKey(key) {
    if (!key) throw new Error("args.parentKey is required");
    let item = await this.getItemByKey(key);
    if (!item) {
      throw new Error(`Parent item not found: ${key}`);
    }
    return item;
  },

  async findExistingChildAttachment(parent, targetPath) {
    let childIDs = parent.getAttachments ? parent.getAttachments() : [];
    let children = await Zotero.Items.getAsync(childIDs);
    let normalizedTarget = this.normalizeSlashes(targetPath);
    for (let child of children) {
      if (!child || !child.isAttachment || !child.isAttachment()) continue;
      let childPath = this.normalizeSlashes(child.attachmentPath || "");
      if (childPath === normalizedTarget) {
        return child;
      }
      try {
        let resolved = child.getFilePath ? this.normalizeSlashes(child.getFilePath() || "") : "";
        if (resolved && resolved === normalizedTarget) {
          return child;
        }
      }
      catch (e) {}
    }
    return null;
  },

  async operationLinkFileToItem(mode, args) {
    let cloudBase = this.getCloudBase(args);
    let parentKey = args.parentKey || args.parentItemKey || args.itemKey;
    let parent = await this.findItemByKey(parentKey);
    let relativePath = args.relativePath || null;
    let filePath = args.filePath || null;

    if (!relativePath && !filePath) {
      throw new Error("args.filePath or args.relativePath is required");
    }

    let useRelative = !!relativePath;
    if (!relativePath && filePath) {
      relativePath = this.filePathToRelativeCloudPath(filePath, cloudBase);
      useRelative = !!relativePath;
    }

    let resolvedPath = useRelative
      ? PathUtils.join(cloudBase, ...relativePath.split(/[\\/]+/))
      : filePath;

    let contentType = await this.mimeTypeForPath(resolvedPath, args.contentType);
    let title = args.title || PathUtils.filename(resolvedPath);
    let targetAttachmentPath = useRelative
      ? Zotero.Attachments.BASE_PATH_PLACEHOLDER + relativePath.replace(/\\/g, "/")
      : resolvedPath;
    let existing = await this.findExistingChildAttachment(parent, targetAttachmentPath);

    let detail = {
      parentKey,
      parentItemID: parent.id,
      parentTitle: parent.getField ? parent.getField("title") : "",
      filePath,
      relativePath: useRelative ? relativePath.replace(/\\/g, "/") : null,
      resolvedPath,
      title,
      contentType,
      targetAttachmentPath,
      action: "",
    };

    if (!(await this.exists(resolvedPath))) {
      detail.action = "skip-file-missing";
      return { ok: false, summary: { requested: 1, fileMissing: 1, created: 0, existing: 0 }, details: [detail] };
    }

    if (existing && args.skipExisting !== false) {
      detail.action = "skip-existing-attachment";
      detail.existingKey = existing.key;
      return { ok: true, summary: { requested: 1, fileMissing: 0, created: 0, existing: 1 }, details: [detail] };
    }

    detail.action = useRelative ? "would-link-relative-file" : "would-link-absolute-file";
    let summary = { requested: 1, fileMissing: 0, created: 0, existing: 0, wouldCreate: 1 };

    if (mode === "apply") {
      Zotero.Prefs.set("baseAttachmentPath", cloudBase);
      let newAttachment;
      if (useRelative) {
        newAttachment = await Zotero.Attachments.linkFromFileWithRelativePath({
          path: relativePath.replace(/\\/g, "/"),
          title,
          contentType,
          parentItemID: parent.id,
          saveOptions: { skipDateModifiedUpdate: !!args.skipDateModifiedUpdate }
        });
      }
      else {
        newAttachment = await Zotero.Attachments.linkFromFile({
          file: resolvedPath,
          title,
          contentType,
          parentItemID: parent.id,
          saveOptions: { skipDateModifiedUpdate: !!args.skipDateModifiedUpdate }
        });
      }
      detail.action = "created-linked-attachment";
      detail.newKey = newAttachment.key;
      detail.newItemID = newAttachment.id;
      detail.newPath = newAttachment.attachmentPath || "";
      summary.created = 1;
      summary.wouldCreate = 0;
    }

    return { ok: true, summary, details: [detail] };
  },

  async operationImportFileToItem(mode, args) {
    let parentKey = args.parentKey || args.parentItemKey || args.itemKey;
    let filePath = args.filePath;
    if (!filePath) throw new Error("args.filePath is required");
    let parent = await this.findItemByKey(parentKey);
    let contentType = await this.mimeTypeForPath(filePath, args.contentType);
    let title = args.title || PathUtils.filename(filePath);
    let detail = {
      parentKey,
      parentItemID: parent.id,
      parentTitle: parent.getField ? parent.getField("title") : "",
      filePath,
      title,
      contentType,
      action: "",
    };

    if (!(await this.exists(filePath))) {
      detail.action = "skip-file-missing";
      return { ok: false, summary: { requested: 1, fileMissing: 1, imported: 0 }, details: [detail] };
    }

    detail.action = "would-import-stored-file";
    let summary = { requested: 1, fileMissing: 0, imported: 0, wouldImport: 1 };
    if (mode === "apply") {
      let newAttachment = await Zotero.Attachments.importFromFile({
        file: filePath,
        title,
        contentType,
        parentItemID: parent.id,
        saveOptions: { skipDateModifiedUpdate: !!args.skipDateModifiedUpdate }
      });
      detail.action = "imported-stored-attachment";
      detail.newKey = newAttachment.key;
      detail.newItemID = newAttachment.id;
      detail.newPath = newAttachment.attachmentPath || "";
      summary.imported = 1;
      summary.wouldImport = 0;
    }
    return { ok: true, summary, details: [detail] };
  },

  async operationCopyStoredToCloud(mode, args) {
    let cloudBase = this.getCloudBase(args, { required: true });
    let moveInsteadOfCopy = !!args.move;
    let attachments = await this.allAttachmentItems();
    let summary = {
      checkedAttachments: attachments.length,
      storedCandidates: 0,
      wouldCopy: 0,
      copied: 0,
      alreadyPresent: 0,
      sourceMissing: 0,
      failures: 0
    };
    let details = [];
    for (let attachment of attachments) {
      if (!attachment.isStoredFileAttachment || !attachment.isStoredFileAttachment()) continue;
      if ((attachment.attachmentContentType || "").toLowerCase() === "text/html") continue;
      summary.storedCandidates++;
      let detail = this.attachmentDetail(attachment, cloudBase);
      try {
        if (!(await this.exists(detail.sourcePath))) {
          detail.action = "skip-source-missing";
          summary.sourceMissing++;
        }
        else if (await this.exists(detail.cloudTarget)) {
          detail.action = "skip-cloud-present";
          summary.alreadyPresent++;
        }
        else {
          summary.wouldCopy++;
          detail.action = moveInsteadOfCopy ? "would-move-file" : "would-copy-file";
          if (mode === "apply") {
            if (moveInsteadOfCopy) {
              await this.moveFile(detail.sourcePath, detail.cloudTarget);
              detail.action = "moved-file";
            }
            else {
              await this.copyFile(detail.sourcePath, detail.cloudTarget);
              detail.action = "copied-file";
            }
            summary.copied++;
          }
        }
      }
      catch (e) {
        detail.action = "failed";
        detail.error = String(e && e.stack || e);
        summary.failures++;
      }
      details.push(detail);
    }
    return { ok: summary.failures === 0, summary, details };
  },

  async operationCreateLinkedCopies(mode, args) {
    let cloudBase = this.getCloudBase(args, { required: true });
    let attachments = await this.allAttachmentItems();
    let existingLinkedPaths = this.linkedPathIndex(attachments);
    let summary = {
      checkedAttachments: attachments.length,
      storedFileAttachments: 0,
      plannedCreateLinkedCopies: 0,
      created: 0,
      skippedExistingLinkedCopy: 0,
      skippedNoCloudFile: 0,
      failures: 0
    };
    let details = [];
    Zotero.Prefs.set("baseAttachmentPath", cloudBase);
    for (let attachment of attachments) {
      if (!attachment.isStoredFileAttachment || !attachment.isStoredFileAttachment()) continue;
      if ((attachment.attachmentContentType || "").toLowerCase() === "text/html") continue;
      summary.storedFileAttachments++;
      let detail = this.attachmentDetail(attachment, cloudBase);
      let storedRelativePath = Zotero.Attachments.BASE_PATH_PLACEHOLDER + detail.relativePath;
      detail.storedRelativePath = storedRelativePath;
      try {
        if (existingLinkedPaths.has(this.normalizeSlashes(storedRelativePath))) {
          detail.action = "skip-existing-linked-copy";
          summary.skippedExistingLinkedCopy++;
        }
        else if (!(await this.exists(detail.cloudTarget))) {
          detail.action = "skip-no-cloud-file";
          summary.skippedNoCloudFile++;
        }
        else {
          detail.action = "would-create-linked-copy";
          summary.plannedCreateLinkedCopies++;
          if (mode === "apply") {
            let collections = undefined;
            if (!attachment.parentID && attachment.getCollections) {
              collections = attachment.getCollections();
            }
            let newAttachment = await this.createLinkedAttachmentWithoutIndexing({
              relativePath: detail.relativePath,
              title: attachment.getField("title") || detail.fileName,
              contentType: attachment.attachmentContentType || "application/octet-stream",
              parentItemID: attachment.parentID,
              collections,
              saveOptions: { skipDateModifiedUpdate: true }
            });
            detail.action = "created-linked-copy";
            detail.newKey = newAttachment.key;
            existingLinkedPaths.add(this.normalizeSlashes(storedRelativePath));
            summary.created++;
          }
        }
      }
      catch (e) {
        detail.action = "failed";
        detail.error = String(e && e.stack || e);
        summary.failures++;
      }
      details.push(detail);
    }
    return { ok: summary.failures === 0, summary, details };
  },

  async operationCleanupOldStored(mode, args) {
    let cloudBase = this.getCloudBase(args, { required: true });
    let attachments = await this.allAttachmentItems();
    let linkedByPath = this.linkedPathMap(attachments);
    let summary = {
      checkedAttachments: attachments.length,
      oldStoredCandidatesWithLinkedCopy: 0,
      safeToTrashNoChildren: 0,
      movedToTrash: 0,
      hasAnnotations: 0,
      hasChildNotes: 0,
      hasEmbeddedNote: 0,
      skippedNoLinkedCopy: 0,
      failures: 0
    };
    let details = [];
    let trashIDs = [];
    for (let attachment of attachments) {
      if (!attachment.isStoredFileAttachment || !attachment.isStoredFileAttachment()) continue;
      if ((attachment.attachmentContentType || "").toLowerCase() === "text/html") continue;
      let detail = this.attachmentDetail(attachment, cloudBase);
      let storedRelativePath = Zotero.Attachments.BASE_PATH_PLACEHOLDER + detail.relativePath;
      let linkedCopies = linkedByPath.get(this.normalizeSlashes(storedRelativePath)) || [];
      detail.storedRelativePath = storedRelativePath;
      detail.linkedCopyKeys = linkedCopies.map(item => item.key);
      try {
        if (!linkedCopies.length) {
          detail.action = "skip-no-linked-copy";
          summary.skippedNoLinkedCopy++;
          details.push(detail);
          continue;
        }
        let annotationIDs = attachment.getAnnotations ? attachment.getAnnotations(false, true) : [];
        let noteIDs = attachment.getNotes ? attachment.getNotes(false) : [];
        let embeddedNote = attachment.hasNote ? await attachment.hasNote() : false;
        detail.annotationCount = annotationIDs.length;
        detail.childNoteCount = noteIDs.length;
        detail.hasEmbeddedNote = !!embeddedNote;
        summary.oldStoredCandidatesWithLinkedCopy++;
        if (annotationIDs.length) summary.hasAnnotations++;
        if (noteIDs.length) summary.hasChildNotes++;
        if (embeddedNote) summary.hasEmbeddedNote++;
        if (!annotationIDs.length && !noteIDs.length && !embeddedNote) {
          detail.action = mode === "apply" ? "queued-trash-old-stored-attachment" : "would-trash-old-stored-attachment";
          summary.safeToTrashNoChildren++;
          if (mode === "apply") trashIDs.push(attachment.id);
        }
        else {
          detail.action = "needs-review-before-trash";
        }
      }
      catch (e) {
        detail.action = "failed";
        detail.error = String(e && e.stack || e);
        summary.failures++;
      }
      details.push(detail);
    }
    if (mode === "apply" && trashIDs.length) {
      await Zotero.Items.trashTx(trashIDs);
      summary.movedToTrash = trashIDs.length;
    }
    return { ok: summary.failures === 0, summary, details };
  },

  async operationTrashItemsByKey(mode, args) {
    let keys = args.keys || [];
    if (!Array.isArray(keys) || !keys.length) throw new Error("args.keys must be a non-empty array");
    let summary = { requested: keys.length, found: 0, queued: 0, trashed: 0, missing: 0, failures: 0 };
    let details = [];
    let ids = [];
    for (let key of keys) {
      let detail = { key, action: "" };
      try {
        let item = await this.getItemByKey(key);
        if (!item) {
          detail.action = "missing";
          summary.missing++;
        }
        else {
          detail.itemID = item.id;
          detail.itemType = item.itemType;
          detail.title = item.getField ? item.getField("title") : "";
          detail.action = mode === "apply" ? "queued-trash" : "would-trash";
          summary.found++;
          summary.queued++;
          if (mode === "apply") ids.push(item.id);
        }
      }
      catch (e) {
        detail.action = "failed";
        detail.error = String(e && e.stack || e);
        summary.failures++;
      }
      details.push(detail);
    }
    if (mode === "apply" && ids.length) {
      await Zotero.Items.trashTx(ids);
      summary.trashed = ids.length;
    }
    return { ok: summary.failures === 0, summary, details };
  },

  async operationEraseTrashByKey(mode, args) {
    let keys = args.keys || [];
    if (!Array.isArray(keys) || !keys.length) throw new Error("args.keys must be a non-empty array");
    let summary = { requested: keys.length, foundInTrash: 0, wouldErase: 0, erased: 0, missing: 0, notInTrash: 0, failures: 0 };
    let details = [];
    for (let key of keys) {
      let detail = { key, action: "" };
      try {
        let item = await this.getItemByKey(key);
        if (!item) {
          detail.action = "missing";
          summary.missing++;
        }
        else if (!item.deleted) {
          detail.action = "skip-not-in-trash";
          summary.notInTrash++;
        }
        else {
          detail.itemID = item.id;
          detail.itemType = item.itemType;
          detail.title = item.getField ? item.getField("title") : "";
          detail.action = mode === "apply" ? "erased" : "would-erase";
          summary.foundInTrash++;
          summary.wouldErase++;
          if (mode === "apply") {
            await item.eraseTx();
            summary.erased++;
          }
        }
      }
      catch (e) {
        detail.action = "failed";
        detail.error = String(e && e.stack || e);
        summary.failures++;
      }
      details.push(detail);
    }
    return { ok: summary.failures === 0, summary, details };
  }
};
