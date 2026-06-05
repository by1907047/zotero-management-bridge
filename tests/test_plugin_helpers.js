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

async function testNearDuplicatePdfCatchesTinySizeDelta() {
  const subject = Object.create(bridge);
  const attachments = [
    fakeAttachment({ key: "GENERICPDF", id: 30, parentID: 2, title: "PDF", path: "D:/linked/paper.pdf" }),
    fakeAttachment({ key: "DESCRIPTIVEPDF", id: 31, parentID: 2, title: "Wang et al. - 2024 - Bioinspired pressure sensors.pdf", path: "D:/linked/Wang-2024-paper.pdf" })
  ];
  subject.allAttachmentItems = async () => attachments;
  subject.fileSize = async path => ({ exists: true, size: path.includes("Wang") ? 1000003 : 1000000 });
  subject.sha256File = async path => path.includes("Wang") ? "hash-b" : "hash-a";

  const plan = await subject.buildDuplicateAttachmentPlan({ maxHashCandidateAttachments: 10 });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.summary.exactDuplicateGroups, 0);
  assert.strictEqual(plan.summary.probableDuplicateGroups, 1);
  assert.strictEqual(plan.summary.removableAttachments, 1);
  assert.deepStrictEqual(plan.removeKeys, ["GENERICPDF"]);
  assert.strictEqual(plan.duplicateGroups[0].confidence, "probable");
  assert.strictEqual(plan.duplicateGroups[0].evidenceType, "near-size-same-kind-file");
  assert.strictEqual(plan.duplicateGroups[0].maxSizeDeltaBytes, 3);
}

async function testNearDuplicateCatchesSupplementaryFiles() {
  const subject = Object.create(bridge);
  const attachments = [
    fakeAttachment({ key: "SI1", id: 40, parentID: 3, title: "Supplementary Materials PDF", path: "D:/linked/si-a.pdf" }),
    fakeAttachment({ key: "SI2", id: 41, parentID: 3, title: "Supplementary Information", path: "D:/linked/si-b.pdf" })
  ];
  subject.allAttachmentItems = async () => attachments;
  subject.fileSize = async path => ({ exists: true, size: path.includes("si-b") ? 500003 : 500000 });
  subject.sha256File = async path => path.includes("si-b") ? "hash-b" : "hash-a";

  const plan = await subject.buildDuplicateAttachmentPlan({ maxHashCandidateAttachments: 10 });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.summary.probableDuplicateGroups, 1);
  assert.strictEqual(plan.summary.removableAttachments, 1);
  assert.strictEqual(plan.duplicateGroups[0].pairEvidence[0].attachmentKind, "supplementary");
}

async function testNearDuplicateDoesNotMixPrimaryAndSupplementary() {
  const subject = Object.create(bridge);
  const attachments = [
    fakeAttachment({ key: "MAINPDF", id: 50, parentID: 4, title: "PDF", path: "D:/linked/main.pdf" }),
    fakeAttachment({ key: "SIPDF", id: 51, parentID: 4, title: "Supplementary Information", path: "D:/linked/si.pdf" })
  ];
  subject.allAttachmentItems = async () => attachments;
  subject.fileSize = async path => ({ exists: true, size: path.includes("si") ? 700003 : 700000 });
  subject.sha256File = async path => path.includes("si") ? "hash-b" : "hash-a";

  const plan = await subject.buildDuplicateAttachmentPlan({ maxHashCandidateAttachments: 10 });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.summary.probableDuplicateGroups, 0);
  assert.strictEqual(plan.summary.removableAttachments, 0);
}

async function testNearDuplicateCatchesSnapshots() {
  const subject = Object.create(bridge);
  const attachments = [
    fakeAttachment({ key: "SNAP1", id: 60, parentID: 5, title: "Snapshot", path: "D:/linked/snapshot-a.html", contentType: "text/html" }),
    fakeAttachment({ key: "SNAP2", id: 61, parentID: 5, title: "Webpage Snapshot", path: "D:/linked/snapshot-b.html", contentType: "text/html" })
  ];
  subject.allAttachmentItems = async () => attachments;
  subject.fileSize = async path => ({ exists: true, size: path.includes("snapshot-b") ? 900002 : 900000 });
  subject.sha256File = async path => path.includes("snapshot-b") ? "hash-b" : "hash-a";

  const plan = await subject.buildDuplicateAttachmentPlan({ maxHashCandidateAttachments: 10 });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.summary.probableDuplicateGroups, 1);
  assert.strictEqual(plan.duplicateGroups[0].pairEvidence[0].attachmentKind, "snapshot");
}

async function testPossiblePrimaryDuplicatesAreReviewOnly() {
  const subject = Object.create(bridge);
  const attachments = [
    fakeAttachment({ key: "PUBLISHERPDF", id: 70, parentID: 6, title: "Publisher PDF", path: "D:/linked/publisher-version.pdf" }),
    fakeAttachment({ key: "ACCEPTEDPDF", id: 71, parentID: 6, title: "Accepted manuscript", path: "D:/linked/accepted-manuscript.pdf" })
  ];
  subject.allAttachmentItems = async () => attachments;
  subject.fileSize = async path => ({ exists: true, size: path.includes("accepted") ? 1900000 : 2600000 });
  subject.sha256File = async path => path.includes("accepted") ? "hash-b" : "hash-a";

  const plan = await subject.buildDuplicateAttachmentPlan({ maxHashCandidateAttachments: 10 });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.summary.probableDuplicateGroups, 0);
  assert.strictEqual(plan.summary.possibleDuplicateGroups, 1);
  assert.strictEqual(plan.summary.reviewOnlyDuplicateGroups, 1);
  assert.strictEqual(plan.summary.removableAttachments, 0);
  assert.deepStrictEqual(plan.removeKeys, []);
  assert.strictEqual(plan.duplicateGroups[0].confidence, "possible");
  assert.strictEqual(plan.duplicateGroups[0].canAutoTrash, false);
}

async function testPossiblePrimaryDuplicatesCanBeDisabled() {
  const subject = Object.create(bridge);
  const attachments = [
    fakeAttachment({ key: "MAIN1", id: 80, parentID: 7, title: "One title", path: "D:/linked/one.pdf" }),
    fakeAttachment({ key: "MAIN2", id: 81, parentID: 7, title: "Different title", path: "D:/linked/two.pdf" })
  ];
  subject.allAttachmentItems = async () => attachments;
  subject.fileSize = async path => ({ exists: true, size: path.includes("two") ? 3000000 : 1000000 });
  subject.sha256File = async path => path.includes("two") ? "hash-b" : "hash-a";

  const plan = await subject.buildDuplicateAttachmentPlan({
    maxHashCandidateAttachments: 10,
    enablePossibleDuplicateAttachments: false
  });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.summary.possibleDuplicateGroups, 0);
  assert.strictEqual(plan.summary.duplicateGroups, 0);
}

async function run() {
  testDuplicateTitlePreference();
  testChineseGenericTitle();
  testDuplicateGroupKeyIncludesParentTypeAndSize();
  testMetadataAuditJournalArticle();
  testMetadataAuditThesisDoesNotRequireDoi();
  await testDuplicatePlanUsesSizeThenHash();
  await testNearDuplicatePdfCatchesTinySizeDelta();
  await testNearDuplicateCatchesSupplementaryFiles();
  await testNearDuplicateDoesNotMixPrimaryAndSupplementary();
  await testNearDuplicateCatchesSnapshots();
  await testPossiblePrimaryDuplicatesAreReviewOnly();
  await testPossiblePrimaryDuplicatesCanBeDisabled();
  console.log("plugin helper tests passed");
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
