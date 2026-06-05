const assert = require("assert");
const bridge = require("../plugin/src/zotero-management-bridge.js");

function testDuplicateTitlePreference() {
  const generic = {
    key: "GENERIC1",
    itemID: 20,
    title: "Full Text PDF",
    fileName: "Wang-2024-flow-sensor.pdf"
  };
  const descriptive = {
    key: "DESCR1",
    itemID: 21,
    title: "Wang et al. - 2024 - Bioinspired piezoresistive pressure sensors.pdf",
    fileName: "PDF"
  };
  const choice = bridge.chooseDuplicateAttachmentKeep([generic, descriptive]);
  assert.strictEqual(choice.keep.key, "DESCR1");
  assert.deepStrictEqual(choice.remove.map(item => item.key), ["GENERIC1"]);
}

function testChineseGenericTitle() {
  assert(bridge.genericAttachmentTitleSet().has("\u5168\u6587"));
}

function testDuplicateGroupKeyIncludesParentTypeAndSize() {
  const detail = {
    parentItemID: 123,
    contentType: "application/pdf"
  };
  assert.strictEqual(bridge.duplicateGroupKey(detail, 4096), "123|application/pdf|4096");
}

function testMetadataAuditJournalArticle() {
  const report = {
    itemType: "journalArticle",
    title: "",
    fields: {
      DOI: "",
      date: "",
      publicationTitle: ""
    },
    creators: []
  };
  assert.deepStrictEqual(bridge.metadataMissingFieldsForReport(report), [
    "title",
    "DOI",
    "date",
    "publicationTitle",
    "creators"
  ]);
}

function testMetadataAuditThesisDoesNotRequireDoi() {
  const report = {
    itemType: "thesis",
    title: "A thesis with no DOI",
    fields: {
      DOI: "",
      date: "2024",
      publicationTitle: ""
    },
    creators: [{ lastName: "Zheng" }]
  };
  assert.deepStrictEqual(bridge.metadataMissingFieldsForReport(report), []);
}

function fakeAttachment({ key, id, parentID, title, path, contentType = "application/pdf" }) {
  return {
    key,
    id,
    parentID,
    attachmentContentType: contentType,
    attachmentPath: path,
    isLinkedFileAttachment: () => true,
    getFilePath: () => path,
    getField: field => field === "title" ? title : ""
  };
}

async function testDuplicatePlanUsesSizeThenHash() {
  const subject = Object.create(bridge);
  const attachments = [
    fakeAttachment({ key: "GENERIC1", id: 10, parentID: 1, title: "PDF", path: "D:/linked/a.pdf" }),
    fakeAttachment({ key: "DESCR1", id: 11, parentID: 1, title: "Wang et al. - 2024 - Bioinspired pressure sensors.pdf", path: "D:/linked/a-copy.pdf" }),
    fakeAttachment({ key: "DIFFHASH", id: 12, parentID: 1, title: "Different paper", path: "D:/linked/different.pdf" }),
    fakeAttachment({ key: "MISSING", id: 13, parentID: 1, title: "Missing file", path: "D:/linked/missing.pdf" })
  ];
  subject.allAttachmentItems = async () => attachments;
  subject.fileSize = async path => {
    if (path.includes("missing")) return { exists: false, error: "file missing" };
    return { exists: true, size: 4096 };
  };
  subject.sha256File = async path => path.includes("different") ? "hash-b" : "hash-a";

  const plan = await subject.buildDuplicateAttachmentPlan({ maxHashCandidateAttachments: 10 });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.summary.sizeCandidateGroups, 1);
  assert.strictEqual(plan.summary.duplicateGroups, 1);
  assert.strictEqual(plan.summary.removableAttachments, 1);
  assert.strictEqual(plan.summary.missingFiles, 1);
  assert.deepStrictEqual(plan.removeKeys, ["GENERIC1"]);
  assert.strictEqual(plan.duplicateGroups[0].keep.key, "DESCR1");
}

async function run() {
  testDuplicateTitlePreference();
  testChineseGenericTitle();
  testDuplicateGroupKeyIncludesParentTypeAndSize();
  testMetadataAuditJournalArticle();
  testMetadataAuditThesisDoesNotRequireDoi();
  await testDuplicatePlanUsesSizeThenHash();
  console.log("plugin helper tests passed");
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
