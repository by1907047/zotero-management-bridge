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
    if (operation === "capabilities") return await this.operationCapabilities(args);
    if (operation === "list-collections") return await this.operationListCollections(args);
    if (operation === "search-items") return await this.operationSearchItems(args);
    if (operation === "get-items") return await this.operationGetItems(args);
    if (operation === "get-item-children") return await this.operationGetItemChildren(args);
    if (operation === "list-attachments") return await this.operationListAttachments(args);
    if (operation === "metadata-audit") return await this.operationMetadataAudit(args);
    if (operation === "find-duplicate-attachments") return await this.operationFindDuplicateAttachments(args);
    if (operation === "cleanup-duplicate-attachments") return await this.operationCleanupDuplicateAttachments(mode, args);
    if (operation === "inspect") return await this.operationInspect(args);
    if (operation === "copy-stored-to-cloud") return await this.operationCopyStoredToCloud(mode, args);
    if (operation === "create-linked-copies") return await this.operationCreateLinkedCopies(mode, args);
    if (operation === "cleanup-old-stored") return await this.operationCleanupOldStored(mode, args);
    if (operation === "link-file-to-item") return await this.operationLinkFileToItem(mode, args);
    if (operation === "import-file-to-item") return await this.operationImportFileToItem(mode, args);
    if (operation === "update-item-fields") return await this.operationUpdateItemFields(mode, args);
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

  async operationCapabilities(args) {
    return {
      ok: true,
      operations: {
        readOnly: [
          "status",
          "capabilities",
          "list-collections",
          "search-items",
          "get-items",
          "get-item-children",
          "list-attachments",
          "metadata-audit",
          "find-duplicate-attachments",
          "inspect"
        ],
        writeDryRunFirst: [
          "update-item-fields",
          "link-file-to-item",
          "import-file-to-item",
          "copy-stored-to-cloud",
          "create-linked-copies",
          "cleanup-old-stored",
          "cleanup-duplicate-attachments",
          "trash-items-by-key",
          "erase-trash-by-key"
        ]
      },
      safety: {
        arbitraryJavaScript: false,
        directSQLiteWrites: false,
        deletesExternalLinkedFiles: false,
        mutatesAttachmentLinkModeInPlace: false,
        batchWritesSupportDryRun: true
      }
    };
  },

  async allRegularItems() {
    let search = new Zotero.Search();
    search.libraryID = Zotero.Libraries.userLibraryID;
    let ids = await search.search();
    let items = await Zotero.Items.getAsync(ids);
    return items.filter(item => {
      if (!item) return false;
      if (item.deleted) return false;
      if (item.isAttachment && item.isAttachment()) return false;
      if (item.isNote && item.isNote()) return false;
      if (item.isAnnotation && item.isAnnotation()) return false;
      if (item.isRegularItem && !item.isRegularItem()) return false;
      return true;
    });
  },

  itemField(item, field) {
    try {
      return item.getField ? (item.getField(field) || "") : "";
    }
    catch (e) {
      return "";
    }
  },

  itemReport(item, options = {}) {
    let fields = options.fields || [
      "title",
      "DOI",
      "url",
      "date",
      "publicationTitle",
      "proceedingsTitle",
      "journalAbbreviation",
      "volume",
      "issue",
      "pages"
    ];
    let report = {
      key: item.key,
      itemID: item.id,
      itemType: item.itemType,
      title: this.itemField(item, "title"),
      dateAdded: item.dateAdded || "",
      dateModified: item.dateModified || "",
      fields: {},
      creators: this.getCreatorsForReport(item),
      collections: item.getCollections ? item.getCollections() : [],
      tags: item.getTags ? item.getTags().map(tag => tag.tag || tag.name || tag) : []
    };
    for (let field of fields) {
      report.fields[field] = this.itemField(item, field);
    }
    return report;
  },

  async operationListCollections(args) {
    let collections = [];
    if (Zotero.Collections && Zotero.Collections.getByLibrary) {
      collections = Zotero.Collections.getByLibrary(Zotero.Libraries.userLibraryID) || [];
    }
    let rows = collections.map(collection => ({
      collectionID: collection.id || collection.collectionID,
      key: collection.key,
      name: collection.name,
      parentCollectionID: collection.parentID || null
    }));
    let byID = new Map(rows.map(row => [row.collectionID, row]));
    for (let row of rows) {
      let parts = [];
      let cursor = row;
      let seen = new Set();
      while (cursor && !seen.has(cursor.collectionID)) {
        seen.add(cursor.collectionID);
        parts.unshift(cursor.name);
        cursor = byID.get(cursor.parentCollectionID);
      }
      row.path = parts.join(" / ");
    }
    rows.sort((a, b) => (a.path || "").localeCompare(b.path || ""));
    return { ok: true, summary: { collections: rows.length }, collections: rows };
  },

  async operationSearchItems(args) {
    let query = (args.query || "").toLowerCase();
    let doi = (args.DOI || args.doi || "").toLowerCase();
    let itemType = args.itemType || "";
    let year = args.year ? String(args.year) : "";
    let limit = Number.isFinite(args.limit) ? args.limit : parseInt(args.limit || "100", 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 100;

    let items = await this.allRegularItems();
    let matches = [];
    for (let item of items) {
      let report = this.itemReport(item);
      let haystack = [
        report.title,
        report.fields.DOI,
        report.fields.publicationTitle,
        report.fields.proceedingsTitle,
        report.creators.map(creator => `${creator.firstName || ""} ${creator.lastName || ""}`).join(" ")
      ].join(" ").toLowerCase();
      if (itemType && report.itemType !== itemType) continue;
      if (doi && (report.fields.DOI || "").toLowerCase() !== doi) continue;
      if (year && !(report.fields.date || "").startsWith(year)) continue;
      if (query && !haystack.includes(query)) continue;
      matches.push(report);
      if (matches.length >= limit) break;
    }
    return { ok: true, summary: { checkedItems: items.length, returnedItems: matches.length }, items: matches };
  },

  async operationGetItems(args) {
    let keys = args.keys || (args.key ? [args.key] : []);
    if (!Array.isArray(keys) || !keys.length) throw new Error("args.keys must be a non-empty array");
    let details = [];
    let summary = { requested: keys.length, found: 0, missing: 0 };
    for (let key of keys) {
      let item = await this.getItemByKey(key);
      if (!item) {
        details.push({ key, action: "missing" });
        summary.missing++;
        continue;
      }
      details.push(this.itemReport(item));
      summary.found++;
    }
    return { ok: true, summary, items: details };
  },

  async operationGetItemChildren(args) {
    let keys = args.keys || (args.key ? [args.key] : []);
    if (!Array.isArray(keys) || !keys.length) throw new Error("args.keys must be a non-empty array");
    let details = [];
    let summary = { requested: keys.length, found: 0, missing: 0, attachments: 0, notes: 0 };
    for (let key of keys) {
      let item = await this.getItemByKey(key);
      if (!item) {
        details.push({ key, action: "missing" });
        summary.missing++;
        continue;
      }
      let attachmentIDs = item.getAttachments ? item.getAttachments() : [];
      let noteIDs = item.getNotes ? item.getNotes(false) : [];
      let attachments = await Zotero.Items.getAsync(attachmentIDs);
      let notes = await Zotero.Items.getAsync(noteIDs);
      let cloudBase = this.getCloudBase(args);
      details.push({
        key,
        itemID: item.id,
        title: this.itemField(item, "title"),
        attachments: attachments.filter(Boolean).map(attachment => this.attachmentDetail(attachment, cloudBase)),
        notes: notes.filter(Boolean).map(note => ({
          key: note.key,
          itemID: note.id,
          title: this.itemField(note, "title")
        }))
      });
      summary.found++;
      summary.attachments += attachmentIDs.length;
      summary.notes += noteIDs.length;
    }
    return { ok: true, summary, items: details };
  },

  attachmentCategory(attachment) {
    if (attachment.isLinkedFileAttachment && attachment.isLinkedFileAttachment()) return "linked-file";
    if (attachment.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_URL) return "linked-url";
    if ((attachment.attachmentContentType || "").toLowerCase() === "text/html") return "html-snapshot";
    if (attachment.isStoredFileAttachment && attachment.isStoredFileAttachment()) return "stored-file";
    return "other";
  },

  async operationListAttachments(args) {
    let attachments = await this.allAttachmentItems();
    let cloudBase = this.getCloudBase(args);
    let categoryFilter = args.category || "";
    let contentTypeFilter = (args.contentType || "").toLowerCase();
    let details = [];
    let summary = { checkedAttachments: attachments.length, returnedAttachments: 0 };
    for (let attachment of attachments) {
      let category = this.attachmentCategory(attachment);
      if (categoryFilter && category !== categoryFilter) continue;
      if (contentTypeFilter && (attachment.attachmentContentType || "").toLowerCase() !== contentTypeFilter) continue;
      let detail = this.attachmentDetail(attachment, cloudBase);
      detail.category = category;
      details.push(detail);
      summary.returnedAttachments++;
    }
    return { ok: true, summary, details };
  },

  metadataMissingFieldsForReport(report, args = {}) {
    let missing = [];
    let doiTypes = args.doiItemTypes || ["journalArticle", "conferencePaper"];
    let dateTypes = args.dateItemTypes || ["journalArticle", "conferencePaper"];
    if (!report.title) missing.push("title");
    if (doiTypes.includes(report.itemType) && !report.fields.DOI) missing.push("DOI");
    if (dateTypes.includes(report.itemType) && !report.fields.date) missing.push("date");
    if (report.itemType === "journalArticle" && !report.fields.publicationTitle) missing.push("publicationTitle");
    if (report.itemType === "conferencePaper" && !report.fields.proceedingsTitle) missing.push("proceedingsTitle");
    if (!report.creators || !report.creators.length) missing.push("creators");
    return missing;
  },

  async operationMetadataAudit(args) {
    let items = await this.allRegularItems();
    let itemTypes = Array.isArray(args.itemTypes) ? new Set(args.itemTypes) : null;
    let details = [];
    let summary = {
      checkedItems: 0,
      incompleteItems: 0,
      missingTitle: 0,
      missingDOI: 0,
      missingDate: 0,
      missingPublication: 0,
      missingCreators: 0
    };
    for (let item of items) {
      if (itemTypes && !itemTypes.has(item.itemType)) continue;
      summary.checkedItems++;
      let report = this.itemReport(item);
      let missing = this.metadataMissingFieldsForReport(report, args);
      if (!missing.length) continue;
      summary.incompleteItems++;
      if (missing.includes("title")) summary.missingTitle++;
      if (missing.includes("DOI")) summary.missingDOI++;
      if (missing.includes("date")) summary.missingDate++;
      if (missing.includes("publicationTitle") || missing.includes("proceedingsTitle")) summary.missingPublication++;
      if (missing.includes("creators")) summary.missingCreators++;
      details.push({
        key: report.key,
        itemID: report.itemID,
        itemType: report.itemType,
        title: report.title,
        missing,
        fields: report.fields,
        creators: report.creators
      });
    }
    return { ok: true, summary, details };
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

  genericAttachmentTitleSet() {
    return new Set([
      "pdf",
      "full text pdf",
      "full text",
      "fulltext",
      "article pdf",
      "publisher full text pdf",
      "iop full text pdf",
      "snapshot",
      "webpage snapshot",
      "web page snapshot",
      "html snapshot",
      "\u5168\u6587"
    ]);
  },

  normalizedAttachmentTitle(title) {
    return (title || "").replace(/\s+/g, " ").trim().toLowerCase();
  },

  duplicateAttachmentScore(detail) {
    let title = detail.title || "";
    let normalizedTitle = this.normalizedAttachmentTitle(title);
    let fileName = detail.fileName || this.leafName(detail.sourcePath || detail.path || "");
    let score = 0;
    if (!this.genericAttachmentTitleSet().has(normalizedTitle)) score += 100;
    if (title.length > 20) score += Math.min(title.length, 140);
    if (/\b(19|20)\d{2}\b/.test(title)) score += 20;
    if (fileName.length > 20) score += Math.floor(Math.min(fileName.length, 120) / 2);
    score -= (detail.itemID || 0) / 1000000;
    return score;
  },

  isGenericAttachmentDetail(detail) {
    let normalizedTitle = this.normalizedAttachmentTitle(detail.title || "");
    if (this.genericAttachmentTitleSet().has(normalizedTitle)) return true;
    let normalizedFileName = this.normalizedAttachmentTitle((detail.fileName || "").replace(/\.[^.]+$/, ""));
    return this.genericAttachmentTitleSet().has(normalizedFileName);
  },

  supplementaryAttachmentPattern() {
    return /\b(supplement|supplementary|supporting|appendix|additional|movie|video|dataset|source\s+data|extended\s+data|moesm|esm|fig(?:ure)?\s*s\d+|table\s*s\d+|s\d+)\b/i;
  },

  isSupplementaryLikeAttachment(detail) {
    let text = [
      detail.title || "",
      detail.fileName || "",
      detail.sourcePath || "",
      detail.path || ""
    ].join(" ");
    return this.supplementaryAttachmentPattern().test(text);
  },

  isPdfAttachmentDetail(detail) {
    let contentType = (detail.contentType || "").toLowerCase();
    let fileName = (detail.fileName || detail.sourcePath || detail.path || "").toLowerCase();
    return contentType === "application/pdf" || fileName.endsWith(".pdf");
  },

  attachmentKind(detail) {
    let contentType = (detail.contentType || "").toLowerCase();
    let text = [
      detail.title || "",
      detail.fileName || "",
      detail.sourcePath || "",
      detail.path || ""
    ].join(" ");
    if (contentType === "text/html" || /\b(snapshot|webpage|web\s+page)\b/i.test(text)) return "snapshot";
    if (/\b(movie|video)\b/i.test(text)) return "media";
    if (/\b(dataset|source\s+data|extended\s+data)\b/i.test(text)) return "data";
    if (this.supplementaryAttachmentPattern().test(text)) return "supplementary";
    return "primary";
  },

  attachmentTextTokens(detail) {
    let generic = this.genericAttachmentTitleSet();
    let stop = new Set(["pdf", "full", "text", "article", "publisher", "download", "zotero", "attachment", "file"]);
    let text = [
      detail.title || "",
      (detail.fileName || "").replace(/\.[^.]+$/, "")
    ].join(" ").toLowerCase();
    let tokens = text
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
      .split(/\s+/)
      .filter(token => token.length > 2 && !stop.has(token) && !generic.has(token));
    return new Set(tokens);
  },

  tokenOverlapRatio(a, b) {
    if (!a.size || !b.size) return 0;
    let smaller = a.size <= b.size ? a : b;
    let larger = a.size <= b.size ? b : a;
    let overlap = 0;
    for (let token of smaller) {
      if (larger.has(token)) overlap++;
    }
    return overlap / smaller.size;
  },

  normalizedComparableAttachmentName(detail) {
    return this.normalizedAttachmentTitle((detail.title || detail.fileName || "").replace(/\.[^.]+$/, ""));
  },

  nearDuplicateAttachmentEvidence(a, b, args = {}) {
    if ((a.parentItemID || null) !== (b.parentItemID || null)) return null;
    if ((a.contentType || "") !== (b.contentType || "")) return null;
    let aKind = this.attachmentKind(a);
    let bKind = this.attachmentKind(b);
    if (aKind !== bKind) return null;
    if (!Number.isFinite(a.size) || !Number.isFinite(b.size)) return null;
    if (a.sha256 && b.sha256 && a.size === b.size && a.sha256 !== b.sha256) return null;

    let maxDeltaBytes = parseInt(args.nearDuplicateMaxSizeDeltaBytes || "8192", 10);
    if (!Number.isFinite(maxDeltaBytes) || maxDeltaBytes < 0) maxDeltaBytes = 8192;
    let maxDeltaRatio = parseFloat(args.nearDuplicateMaxSizeDeltaRatio || "0.01");
    if (!Number.isFinite(maxDeltaRatio) || maxDeltaRatio < 0) maxDeltaRatio = 0.01;
    let tinyDeltaBytes = parseInt(args.nearDuplicateTinySizeDeltaBytes || "1024", 10);
    if (!Number.isFinite(tinyDeltaBytes) || tinyDeltaBytes < 0) tinyDeltaBytes = 1024;

    let sizeDeltaBytes = Math.abs(a.size - b.size);
    let maxSize = Math.max(a.size, b.size, 1);
    let sizeDeltaRatio = sizeDeltaBytes / maxSize;
    if (sizeDeltaBytes > maxDeltaBytes || sizeDeltaRatio > maxDeltaRatio) return null;

    let aName = this.normalizedComparableAttachmentName(a);
    let bName = this.normalizedComparableAttachmentName(b);
    let sameName = !!aName && aName === bName && !this.genericAttachmentTitleSet().has(aName);
    let genericPair = this.isGenericAttachmentDetail(a) || this.isGenericAttachmentDetail(b);
    let tokenOverlap = this.tokenOverlapRatio(this.attachmentTextTokens(a), this.attachmentTextTokens(b));
    let tinySizeDelta = sizeDeltaBytes <= tinyDeltaBytes;
    let titleEvidence = sameName || tokenOverlap >= 0.6 || genericPair || tinySizeDelta;
    if (!titleEvidence) return null;

    return {
      evidenceType: "near-size-same-kind-file",
      confidence: "probable",
      attachmentKind: aKind,
      sizeDeltaBytes,
      sizeDeltaRatio,
      sameName,
      genericTitleInPair: genericPair,
      tokenOverlap,
      tinySizeDelta,
      reason: "same-parent-same-content-type-near-size-same-kind-file"
    };
  },

  possibleDuplicateAttachmentEvidence(a, b) {
    if ((a.parentItemID || null) !== (b.parentItemID || null)) return null;
    if ((a.contentType || "") !== (b.contentType || "")) return null;
    let aKind = this.attachmentKind(a);
    let bKind = this.attachmentKind(b);
    if (aKind !== bKind) return null;
    if (aKind !== "primary") return null;
    if (!Number.isFinite(a.size) || !Number.isFinite(b.size)) return null;
    if (a.sha256 && b.sha256 && a.size === b.size && a.sha256 !== b.sha256) return null;

    let sizeDeltaBytes = Math.abs(a.size - b.size);
    let maxSize = Math.max(a.size, b.size, 1);
    let sizeDeltaRatio = sizeDeltaBytes / maxSize;
    return {
      evidenceType: "same-parent-multiple-primary-files",
      confidence: "possible",
      attachmentKind: aKind,
      sizeDeltaBytes,
      sizeDeltaRatio,
      sameName: this.normalizedComparableAttachmentName(a) === this.normalizedComparableAttachmentName(b),
      genericTitleInPair: this.isGenericAttachmentDetail(a) || this.isGenericAttachmentDetail(b),
      tokenOverlap: this.tokenOverlapRatio(this.attachmentTextTokens(a), this.attachmentTextTokens(b)),
      reason: "same-parent-same-content-type-primary-files-review-needed"
    };
  },

  chooseDuplicateAttachmentKeep(details) {
    let sorted = details.slice().sort((a, b) => {
      let scoreDelta = this.duplicateAttachmentScore(b) - this.duplicateAttachmentScore(a);
      if (scoreDelta !== 0) return scoreDelta;
      return (a.itemID || 0) - (b.itemID || 0);
    });
    return {
      keep: sorted[0],
      remove: sorted.slice(1)
    };
  },

  async fileSize(path) {
    if (!path) return { exists: false, error: "missing path" };
    try {
      if (typeof IOUtils !== "undefined" && IOUtils.stat) {
        let stat = await IOUtils.stat(path);
        return { exists: true, size: stat.size };
      }
    }
    catch (e) {
      return { exists: false, error: String(e && e.message || e) };
    }
    try {
      let file = Zotero.File.pathToFile(path);
      if (!file || !file.exists()) return { exists: false, error: "file missing" };
      return { exists: true, size: file.fileSize };
    }
    catch (e) {
      return { exists: false, error: String(e && e.message || e) };
    }
  },

  async sha256File(path) {
    let classes = typeof Cc !== "undefined" ? Cc : Components.classes;
    let interfaces = typeof Ci !== "undefined" ? Ci : Components.interfaces;
    let stream = classes["@mozilla.org/network/file-input-stream;1"].createInstance(interfaces.nsIFileInputStream);
    try {
      let file = Zotero.File.pathToFile(path);
      stream.init(file, -1, 0, 0);
      let hash = classes["@mozilla.org/security/hash;1"].createInstance(interfaces.nsICryptoHash);
      hash.init(hash.SHA256);
      hash.updateFromStream(stream, -1);
      let binary = hash.finish(false);
      let hex = "";
      for (let i = 0; i < binary.length; i++) {
        hex += ("0" + binary.charCodeAt(i).toString(16)).slice(-2);
      }
      return hex;
    }
    finally {
      try {
        stream.close();
      }
      catch (e) {}
    }
  },

  duplicateGroupKey(detail, size) {
    return [
      detail.parentItemID || "",
      detail.contentType || "",
      size
    ].join("|");
  },

  parentContentTypeGroupKey(detail) {
    return [
      detail.parentItemID || "",
      detail.contentType || ""
    ].join("|");
  },

  componentKey(details) {
    return details.map(detail => detail.key).sort().join("|");
  },

  unionFindMake(values) {
    let parent = new Map();
    for (let value of values) parent.set(value, value);
    let find = value => {
      let current = parent.get(value);
      if (current !== value) {
        current = find(current);
        parent.set(value, current);
      }
      return current;
    };
    let union = (a, b) => {
      let rootA = find(a);
      let rootB = find(b);
      if (rootA !== rootB) parent.set(rootB, rootA);
    };
    return { find, union };
  },

  async buildDuplicateAttachmentPlan(args = {}) {
    let cloudBase = this.getCloudBase(args);
    let attachments = await this.allAttachmentItems();
    let includeStoredFiles = !!args.includeStoredFiles;
    let includeSnapshots = args.includeSnapshots !== false;
    let enableNearDuplicates = args.enableNearDuplicateAttachments !== false;
    let enablePossibleDuplicates = args.enablePossibleDuplicateAttachments !== false;
    let maxHashCandidateAttachments = parseInt(args.maxHashCandidateAttachments || "200", 10);
    if (!Number.isFinite(maxHashCandidateAttachments) || maxHashCandidateAttachments <= 0) {
      maxHashCandidateAttachments = 200;
    }

    let summary = {
      checkedAttachments: attachments.length,
      fileAttachments: 0,
      sizeCandidateGroups: 0,
      hashCandidateAttachments: 0,
      nearSizeCandidateGroups: 0,
      nearSizeCandidatePairs: 0,
      probableDuplicateGroups: 0,
      exactDuplicateGroups: 0,
      possibleDuplicateGroups: 0,
      reviewOnlyDuplicateGroups: 0,
      duplicateGroups: 0,
      removableAttachments: 0,
      missingFiles: 0,
      hashFailures: 0,
      skippedHashLimit: false
    };
    let sizeGroups = new Map();
    let parentContentTypeGroups = new Map();
    let skipped = [];

    for (let attachment of attachments) {
      let category = this.attachmentCategory(attachment);
      if (
        category !== "linked-file" &&
        !(includeStoredFiles && category === "stored-file") &&
        !(includeSnapshots && category === "html-snapshot")
      ) continue;
      let detail = this.attachmentDetail(attachment, cloudBase);
      detail.category = category;
      summary.fileAttachments++;
      let sizeInfo = await this.fileSize(detail.sourcePath);
      if (!sizeInfo.exists) {
        summary.missingFiles++;
        skipped.push(Object.assign(detail, { action: "skip-file-missing", error: sizeInfo.error || "" }));
        continue;
      }
      detail.size = sizeInfo.size;
      let key = this.duplicateGroupKey(detail, sizeInfo.size);
      if (!sizeGroups.has(key)) sizeGroups.set(key, []);
      sizeGroups.get(key).push(detail);
      let nearKey = this.parentContentTypeGroupKey(detail);
      if (!parentContentTypeGroups.has(nearKey)) parentContentTypeGroups.set(nearKey, []);
      parentContentTypeGroups.get(nearKey).push(detail);
    }

    let candidateGroups = Array.from(sizeGroups.values()).filter(group => group.length > 1);
    summary.sizeCandidateGroups = candidateGroups.length;
    summary.hashCandidateAttachments = candidateGroups.reduce((total, group) => total + group.length, 0);
    if (summary.hashCandidateAttachments > maxHashCandidateAttachments) {
      summary.skippedHashLimit = true;
      return {
        ok: false,
        summary,
        duplicateGroups: [],
        removeKeys: [],
        skipped,
        sizeCandidateGroups: candidateGroups.map(group => ({
          parentItemID: group[0].parentItemID,
          contentType: group[0].contentType,
          size: group[0].size,
          keys: group.map(detail => detail.key)
        })),
        error: `Hash candidate limit exceeded: ${summary.hashCandidateAttachments} > ${maxHashCandidateAttachments}`
      };
    }

    let hashGroups = new Map();
    for (let group of candidateGroups) {
      for (let detail of group) {
        try {
          detail.sha256 = await this.sha256File(detail.sourcePath);
          let hashKey = [
            detail.parentItemID || "",
            detail.contentType || "",
            detail.size,
            detail.sha256
          ].join("|");
          if (!hashGroups.has(hashKey)) hashGroups.set(hashKey, []);
          hashGroups.get(hashKey).push(detail);
        }
        catch (e) {
          summary.hashFailures++;
          skipped.push(Object.assign(detail, { action: "skip-hash-failed", error: String(e && e.message || e) }));
        }
      }
    }

    let duplicateGroups = [];
    let removeKeySet = new Set();
    let coveredComponentKeySet = new Set();
    for (let group of hashGroups.values()) {
      if (group.length <= 1) continue;
      let choice = this.chooseDuplicateAttachmentKeep(group);
      let keep = choice.keep;
      let remove = choice.remove;
      let duplicateGroup = {
        parentItemID: keep.parentItemID || null,
        contentType: keep.contentType || "",
        size: keep.size,
        sha256: keep.sha256,
        confidence: "exact",
        evidenceType: "exact-hash",
        canAutoTrash: true,
        reason: "same-parent-same-content-type-same-size-same-sha256",
        keep: Object.assign({}, keep, {
          score: this.duplicateAttachmentScore(keep),
          keepReason: "highest-descriptive-title-score"
        }),
        remove: remove.map(detail => Object.assign({}, detail, {
          score: this.duplicateAttachmentScore(detail),
          removeReason: "duplicate-content-lower-title-score"
        }))
      };
      duplicateGroups.push(duplicateGroup);
      summary.exactDuplicateGroups++;
      coveredComponentKeySet.add(this.componentKey(group));
      for (let detail of remove) removeKeySet.add(detail.key);
    }

    if (enableNearDuplicates) {
      let nearGroups = Array.from(parentContentTypeGroups.values()).filter(group => group.length > 1);
      summary.nearSizeCandidateGroups = nearGroups.length;
      for (let group of nearGroups) {
        let uf = this.unionFindMake(group.map(detail => detail.key));
        let edgeEvidence = new Map();
        for (let i = 0; i < group.length; i++) {
          for (let j = i + 1; j < group.length; j++) {
            let evidence = this.nearDuplicateAttachmentEvidence(group[i], group[j], args);
            if (!evidence) continue;
            summary.nearSizeCandidatePairs++;
            uf.union(group[i].key, group[j].key);
            edgeEvidence.set([group[i].key, group[j].key].sort().join("|"), evidence);
          }
        }
        let components = new Map();
        for (let detail of group) {
          let root = uf.find(detail.key);
          if (!components.has(root)) components.set(root, []);
          components.get(root).push(detail);
        }
        for (let component of components.values()) {
          if (component.length <= 1) continue;
          let componentKey = this.componentKey(component);
          if (coveredComponentKeySet.has(componentKey)) continue;
          let pairEvidence = [];
          let maxSizeDeltaBytes = 0;
          let maxSizeDeltaRatio = 0;
          for (let i = 0; i < component.length; i++) {
            for (let j = i + 1; j < component.length; j++) {
              let edgeKey = [component[i].key, component[j].key].sort().join("|");
              let evidence = edgeEvidence.get(edgeKey);
              if (!evidence) continue;
              pairEvidence.push(Object.assign({
                keys: [component[i].key, component[j].key]
              }, evidence));
              maxSizeDeltaBytes = Math.max(maxSizeDeltaBytes, evidence.sizeDeltaBytes || 0);
              maxSizeDeltaRatio = Math.max(maxSizeDeltaRatio, evidence.sizeDeltaRatio || 0);
            }
          }
          if (!pairEvidence.length) continue;
          let choice = this.chooseDuplicateAttachmentKeep(component);
          let keep = choice.keep;
          let remove = choice.remove;
          let duplicateGroup = {
            parentItemID: keep.parentItemID || null,
            contentType: keep.contentType || "",
            confidence: "probable",
            evidenceType: "near-size-same-kind-file",
            canAutoTrash: true,
            reason: "same-parent-same-content-type-near-size-same-kind-file",
            maxSizeDeltaBytes,
            maxSizeDeltaRatio,
            pairEvidence,
            keep: Object.assign({}, keep, {
              score: this.duplicateAttachmentScore(keep),
              keepReason: "highest-descriptive-title-score"
            }),
            remove: remove.map(detail => Object.assign({}, detail, {
              score: this.duplicateAttachmentScore(detail),
              removeReason: "probable-duplicate-content-lower-title-score"
            }))
          };
          duplicateGroups.push(duplicateGroup);
          summary.probableDuplicateGroups++;
          coveredComponentKeySet.add(componentKey);
          for (let detail of remove) removeKeySet.add(detail.key);
        }
      }
    }

    if (enablePossibleDuplicates) {
      let possibleGroups = Array.from(parentContentTypeGroups.values()).filter(group => group.length > 1);
      for (let group of possibleGroups) {
        let byKind = new Map();
        for (let detail of group) {
          let kind = this.attachmentKind(detail);
          if (!byKind.has(kind)) byKind.set(kind, []);
          byKind.get(kind).push(detail);
        }
        for (let kindGroup of byKind.values()) {
          if (kindGroup.length <= 1) continue;
          let uf = this.unionFindMake(kindGroup.map(detail => detail.key));
          let edgeEvidence = new Map();
          for (let i = 0; i < kindGroup.length; i++) {
            for (let j = i + 1; j < kindGroup.length; j++) {
              let evidence = this.possibleDuplicateAttachmentEvidence(kindGroup[i], kindGroup[j]);
              if (!evidence) continue;
              uf.union(kindGroup[i].key, kindGroup[j].key);
              edgeEvidence.set([kindGroup[i].key, kindGroup[j].key].sort().join("|"), evidence);
            }
          }
          let components = new Map();
          for (let detail of kindGroup) {
            let root = uf.find(detail.key);
            if (!components.has(root)) components.set(root, []);
            components.get(root).push(detail);
          }
          for (let component of components.values()) {
            if (component.length <= 1) continue;
            let componentKey = this.componentKey(component);
            if (coveredComponentKeySet.has(componentKey)) continue;
            let pairEvidence = [];
            let maxSizeDeltaBytes = 0;
            let maxSizeDeltaRatio = 0;
            for (let i = 0; i < component.length; i++) {
              for (let j = i + 1; j < component.length; j++) {
                let edgeKey = [component[i].key, component[j].key].sort().join("|");
                let evidence = edgeEvidence.get(edgeKey);
                if (!evidence) continue;
                pairEvidence.push(Object.assign({
                  keys: [component[i].key, component[j].key]
                }, evidence));
                maxSizeDeltaBytes = Math.max(maxSizeDeltaBytes, evidence.sizeDeltaBytes || 0);
                maxSizeDeltaRatio = Math.max(maxSizeDeltaRatio, evidence.sizeDeltaRatio || 0);
              }
            }
            if (!pairEvidence.length) continue;
            let choice = this.chooseDuplicateAttachmentKeep(component);
            let keep = choice.keep;
            let review = choice.remove;
            duplicateGroups.push({
              parentItemID: keep.parentItemID || null,
              contentType: keep.contentType || "",
              confidence: "possible",
              evidenceType: "same-parent-multiple-primary-files",
              canAutoTrash: false,
              reason: "same-parent-same-content-type-primary-files-review-needed",
              maxSizeDeltaBytes,
              maxSizeDeltaRatio,
              pairEvidence,
              keep: Object.assign({}, keep, {
                score: this.duplicateAttachmentScore(keep),
                keepReason: "highest-descriptive-title-score-review-needed"
              }),
              remove: review.map(detail => Object.assign({}, detail, {
                score: this.duplicateAttachmentScore(detail),
                removeReason: "review-only-possible-duplicate-not-auto-trashable"
              }))
            });
            summary.possibleDuplicateGroups++;
            summary.reviewOnlyDuplicateGroups++;
          }
        }
      }
    }

    let removeKeys = Array.from(removeKeySet);
    summary.duplicateGroups = duplicateGroups.length;
    summary.removableAttachments = removeKeys.length;
    duplicateGroups.sort((a, b) => {
      let parentDelta = (a.parentItemID || 0) - (b.parentItemID || 0);
      if (parentDelta !== 0) return parentDelta;
      return (a.keep.title || "").localeCompare(b.keep.title || "");
    });
    return { ok: summary.hashFailures === 0, summary, duplicateGroups, removeKeys, skipped };
  },

  async operationFindDuplicateAttachments(args) {
    return await this.buildDuplicateAttachmentPlan(args);
  },

  async operationCleanupDuplicateAttachments(mode, args) {
    let plan = await this.buildDuplicateAttachmentPlan(args);
    plan.operation = "cleanup-duplicate-attachments";
    plan.mode = mode;
    if (!plan.ok || !plan.removeKeys.length || mode !== "apply") {
      if (mode !== "apply") {
        plan.summary.wouldTrash = plan.removeKeys.length;
      }
      return plan;
    }
    let ids = [];
    let trashDetails = [];
    for (let key of plan.removeKeys) {
      let item = await this.getItemByKey(key);
      if (!item) {
        trashDetails.push({ key, action: "missing" });
        continue;
      }
      ids.push(item.id);
      trashDetails.push({ key, itemID: item.id, action: "queued-trash" });
    }
    if (ids.length) {
      await Zotero.Items.trashTx(ids);
    }
    plan.summary.trashed = ids.length;
    plan.trashDetails = trashDetails;
    return plan;
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

  getCreatorsForReport(item) {
    try {
      return item.getCreators ? item.getCreators().map(creator => Object.assign({}, creator)) : [];
    }
    catch (e) {
      return [];
    }
  },

  assertSafeFieldName(field) {
    let blocked = new Set(["key", "itemKey", "itemType", "itemID", "libraryID", "dateAdded", "dateModified"]);
    if (!field || blocked.has(field)) {
      throw new Error(`Field cannot be updated through this operation: ${field}`);
    }
  },

  async applyItemMetadataUpdate(item, fields, creators, saveOptions) {
    await Zotero.DB.executeTransaction(async () => {
      for (let [field, value] of Object.entries(fields)) {
        item.setField(field, value);
      }
      if (creators) {
        item.setCreators(creators);
      }
      await item.save(saveOptions || {});
    });
  },

  async operationUpdateItemFields(mode, args) {
    let updates = args.items || null;
    if (!updates) {
      updates = [{
        key: args.key || args.itemKey,
        fields: args.fields || {},
        creators: args.creators
      }];
    }
    if (!Array.isArray(updates) || !updates.length) {
      throw new Error("args.items or args.key is required");
    }

    let summary = { requested: updates.length, found: 0, wouldUpdate: 0, updated: 0, missing: 0, failures: 0 };
    let details = [];
    for (let update of updates) {
      let key = update.key || update.itemKey;
      let fields = update.fields || {};
      let creators = update.creators;
      let detail = { key, action: "" };
      try {
        if (!key) throw new Error("item key is required");
        if ((!fields || !Object.keys(fields).length) && creators === undefined) {
          throw new Error("fields or creators is required");
        }
        for (let field of Object.keys(fields)) {
          this.assertSafeFieldName(field);
        }
        if (creators !== undefined && !Array.isArray(creators)) {
          throw new Error("creators must be an array when provided");
        }

        let item = await this.getItemByKey(key);
        if (!item) {
          detail.action = "missing";
          summary.missing++;
          details.push(detail);
          continue;
        }

        detail.itemID = item.id;
        detail.itemType = item.itemType;
        detail.before = { fields: {}, creators: this.getCreatorsForReport(item) };
        detail.after = { fields: {}, creators: creators !== undefined ? creators : detail.before.creators };
        for (let [field, value] of Object.entries(fields)) {
          detail.before.fields[field] = item.getField ? item.getField(field) : null;
          detail.after.fields[field] = value;
        }

        summary.found++;
        detail.action = mode === "apply" ? "updated-item-fields" : "would-update-item-fields";
        summary.wouldUpdate++;
        if (mode === "apply") {
          await this.applyItemMetadataUpdate(item, fields, creators, update.saveOptions || args.saveOptions || {});
          summary.updated++;
          summary.wouldUpdate--;
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

if (typeof module !== "undefined" && module.exports) {
  module.exports = ZoteroManagementBridge;
}
