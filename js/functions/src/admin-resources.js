'use strict';
const C = require('./lib/common');
const { db, FieldValue, P, S, N, URLS, ENUM, pageArgs, slicePage, endpoint, ADMIN } = C;
const { bucket, signedUrl } = require('./lib/storage');

const STATUSES = Object.keys(P.ALLOWED_TRANSITIONS);
const snapOf = (r) => ({ title: r.title, status: r.status, subjectId: r.subjectId, gradeId: r.gradeId, topicId: r.topicId ?? null, resourceTypeId: r.resourceTypeId });
const getRes = async (id, { deleted = false } = {}) => {
  const s = await db.doc(`resources/${id}`).get();
  if (!s.exists || (!deleted && s.data().deleted)) throw C.notFound();
  return { id: s.id, ...s.data() };
};
const hasContent = (r) => !!r.onlineUrl || (r.fileSummaries || []).length > 0;
const assertContent = (r) => { if (!hasContent(r)) throw new P.AppError('RESOURCE_NO_CONTENT', 'Học liệu cần có file hoặc link xem trực tuyến trước khi xuất bản'); };
const history = (w, id, from, to, uid, reason) =>
  w.set(db.collection(`resources/${id}/statusHistory`).doc(), { fromStatus: from, toStatus: to, changedBy: uid, reason: reason ?? null, createdAt: FieldValue.serverTimestamp() });

/** Đọc & kiểm tra input chung của học liệu; trả về các trường đã chuẩn hóa (chỉ những trường có gửi lên khi partial). */
function readInput(d, partial) {
  const req = !partial;
  const o = {
    title: S(d.title, { required: req, max: 200, name: 'Tên tài liệu' }), authorName: S(d.authorName, { required: req, max: 120, name: 'Tác giả' }),
    description: S(d.description, { max: 5000, name: 'Mô tả' }), subjectId: S(d.subjectId, { required: req, max: 100, name: 'Môn học' }),
    gradeId: S(d.gradeId, { required: req, max: 10, name: 'Khối lớp' }), topicId: S(d.topicId, { max: 150 }),
    resourceTypeId: S(d.resourceTypeId, { required: req, max: 100, name: 'Loại tài liệu' }),
    thumbnailUrl: URLS(d.thumbnailUrl, 'thumbnailUrl'), onlineUrl: URLS(d.onlineUrl, 'onlineUrl'),
    durationSeconds: N(d.durationSeconds, { min: 0, max: 86400, name: 'durationSeconds' }),
  };
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

exports.adminCreateResource = endpoint(ADMIN, async ({ data, user, ip }) => {
  const input = readInput(data, false), cat = await C.loadCatalogs();
  const names = P.resolveCatalog(input, cat);
  const ref = db.collection('resources').doc();
  const r = {
    ...input, ...names, slug: `${P.slugify(input.title).slice(0, 80)}-${ref.id.slice(0, 5).toLowerCase()}`, status: 'DRAFT',
    viewCount: 0, downloadCount: 0, favoriteCount: 0, fileSummaries: [], createdBy: user.uid, publishedAt: null,
    deleted: false, deletedAt: null, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  };
  Object.assign(r, P.derive(r));
  const batch = db.batch();
  batch.set(ref, r); history(batch, ref.id, null, 'DRAFT', user.uid, 'Tạo mới'); C.bump(batch, 'newResources');
  C.audit(batch, { actor: user, action: 'ADMIN_CREATE_RESOURCE', entityType: 'resource', entityId: ref.id, newData: snapOf(r) }, ip);
  await batch.commit();
  return getFull(ref.id);
});

exports.adminUpdateResource = endpoint(ADMIN, async ({ data, user, ip }) => {
  const id = S(data.id, { required: true, max: 100 }), old = await getRes(id);
  const changes = readInput(data, true);
  if (changes.subjectId && changes.subjectId !== old.subjectId && changes.topicId === undefined) changes.topicId = null; // đổi môn thì bỏ chủ đề cũ
  const merged = { ...old, ...changes };
  const upd = { ...changes, ...P.resolveCatalog(merged, await C.loadCatalogs()) };
  Object.assign(upd, P.derive({ ...merged, ...upd }), { updatedAt: FieldValue.serverTimestamp() });
  const batch = db.batch();
  batch.update(db.doc(`resources/${id}`), upd);
  C.audit(batch, { actor: user, action: 'ADMIN_UPDATE_RESOURCE', entityType: 'resource', entityId: id, oldData: snapOf(old), newData: snapOf({ ...old, ...upd }) }, ip);
  await batch.commit(); C.invalidateCatalog();
  return getFull(id);
});

/** Đổi trạng thái (publish/hide/archive...). Dùng transaction để chống 2 admin thao tác đồng thời. */
exports.adminChangeResourceStatus = endpoint(ADMIN, async ({ data, user, ip }) => {
  const id = S(data.id, { required: true, max: 100 }), to = ENUM(data.status, STATUSES, 'status', true), reason = S(data.reason, { max: 500 });
  if (to === 'APPROVED' || to === 'REJECTED') throw P.bad('USE_MODERATION_ENDPOINT', 'Duyệt/từ chối phải dùng adminApprove / adminReject');
  await db.runTransaction(async (tx) => {
    const ref = db.doc(`resources/${id}`), s = await tx.get(ref);
    if (!s.exists || s.data().deleted) throw C.notFound();
    const r = { id, ...s.data() };
    if (!P.ALLOWED_TRANSITIONS[r.status].includes(to)) throw new P.AppError('INVALID_STATUS_TRANSITION', `Không thể chuyển từ ${r.status} sang ${to}`);
    if (to === 'PUBLISHED') assertContent(r);
    tx.update(ref, { status: to, updatedAt: FieldValue.serverTimestamp(), ...(to === 'PUBLISHED' ? { publishedAt: FieldValue.serverTimestamp() } : {}) });
    history(tx, id, r.status, to, user.uid, reason);
    const action = { PUBLISHED: 'ADMIN_PUBLISH_RESOURCE', HIDDEN: 'ADMIN_HIDE_RESOURCE', ARCHIVED: 'ADMIN_ARCHIVE_RESOURCE' }[to] || 'ADMIN_CHANGE_RESOURCE_STATUS';
    C.audit(tx, { actor: user, action, entityType: 'resource', entityId: id, oldData: { status: r.status }, newData: { status: to, reason } }, ip);
  });
  C.invalidateCatalog();
  return getFull(id);
});

exports.adminDeleteResource = endpoint(ADMIN, async ({ data, user, ip }) => {
  const id = S(data.id, { required: true, max: 100 }), r = await getRes(id);
  const batch = db.batch();
  batch.update(db.doc(`resources/${id}`), { deleted: true, deletedAt: FieldValue.serverTimestamp() }); // xóa mềm
  C.audit(batch, { actor: user, action: 'ADMIN_DELETE_RESOURCE', entityType: 'resource', entityId: id, oldData: snapOf(r) }, ip);
  await batch.commit(); C.invalidateCatalog();
  return { deleted: true };
});
exports.adminRestoreResource = endpoint(ADMIN, async ({ data, user, ip }) => {
  const id = S(data.id, { required: true, max: 100 }), r = await getRes(id, { deleted: true });
  if (!r.deleted) throw new P.AppError('RESOURCE_NOT_DELETED', 'Học liệu chưa bị xóa');
  const batch = db.batch();
  batch.update(db.doc(`resources/${id}`), { deleted: false, deletedAt: null });
  C.audit(batch, { actor: user, action: 'ADMIN_RESTORE_RESOURCE', entityType: 'resource', entityId: id }, ip);
  await batch.commit(); C.invalidateCatalog();
  return getFull(id);
});

async function getFull(id) {
  const r = await getRes(id, { deleted: true });
  const [hist, reviews] = await Promise.all([
    db.collection(`resources/${id}/statusHistory`).orderBy('createdAt', 'desc').get(), db.collection(`resources/${id}/reviews`).orderBy('reviewedAt', 'desc').get(),
  ]);
  const { searchText, titleNorm, ...rest } = r;
  return { ...rest, statusHistory: hist.docs.map((d) => ({ id: d.id, ...d.data() })), reviews: reviews.docs.map((d) => ({ id: d.id, ...d.data() })) };
}
exports.adminGetResource = endpoint(ADMIN, async ({ data }) => getFull(S(data.id, { required: true, max: 100 })));

exports.adminListResources = endpoint(ADMIN, async ({ data }) => {
  const f = {
    status: ENUM(data.status, STATUSES, 'status'), subjectId: S(data.subjectId, { max: 100 }), gradeId: S(data.gradeId, { max: 10 }),
    topicId: S(data.topicId, { max: 150 }), resourceTypeId: S(data.resourceTypeId, { max: 100 }), createdBy: S(data.createdBy, { max: 128 }),
  };
  const q = P.normalize(S(data.q, { max: 100 }) || ''), from = data.from ? Date.parse(data.from) : 0, to = data.to ? Date.parse(data.to) + 864e5 : Infinity;
  const showDeleted = data.deleted === true || data.deleted === 'true';
  const snap = await db.collection('resources').limit(1000).get();
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((r) => !!r.deleted === showDeleted && Object.entries(f).every(([k, v]) => !v || r[k] === v)
      && (!q || r.searchText.includes(q)) && P.millis(r.createdAt) >= from && P.millis(r.createdAt) < to)
    .sort((a, b) => P.millis(b.createdAt) - P.millis(a.createdAt));
  const res = slicePage(rows, pageArgs(data));
  res.items = res.items.map((r) => ({ ...C.toItem(r), status: r.status, createdBy: r.createdBy, deleted: !!r.deleted, createdAt: r.createdAt }));
  return res;
});

/* ---------- File: client upload thẳng lên Storage rồi gọi adminRegisterFile để kiểm tra & ghi nhận ---------- */
exports.adminRegisterFile = endpoint(ADMIN, async ({ data, user, ip }) => {
  const rid = S(data.resourceId, { required: true, max: 100 }), fid = S(data.fileId, { required: true, max: 64 });
  const name = S(data.originalName, { required: true, max: 200, name: 'Tên file' }).replace(/[\\/]/g, '_');
  if (!/^[A-Za-z0-9]{16,64}$/.test(fid)) throw P.bad('VALIDATION_ERROR', 'fileId không hợp lệ');
  await getRes(rid);
  const ext = name.split('.').pop().toLowerCase(), path = `resources/${rid}/${fid}.${ext}`; // đường dẫn do server tự dựng
  const file = bucket().file(path);
  const [exists] = await file.exists();
  if (!exists) throw new P.AppError('FILE_NOT_UPLOADED', 'Chưa tìm thấy file đã tải lên', 'not-found');
  const [meta] = await file.getMetadata();
  const head = await new Promise((ok, no) => { const c = []; file.createReadStream({ start: 0, end: 15 }).on('data', (b) => c.push(b)).on('end', () => ok(Buffer.concat(c))).on('error', no); });
  try { P.validateFileMeta({ name, mime: meta.contentType, size: Number(meta.size), head }); }
  catch (e) { await file.delete().catch(() => undefined); throw e; } // file không hợp lệ bị xóa ngay
  const info = { originalName: name, storagePath: path, fileFormat: ext.toUpperCase(), mimeType: meta.contentType, fileSize: Number(meta.size), checksum: meta.md5Hash || null };
  await db.runTransaction(async (tx) => {
    const rRef = db.doc(`resources/${rid}`), s = await tx.get(rRef);
    const sums = [...(s.data().fileSummaries || []), { id: fid, name, format: info.fileFormat, size: info.fileSize }];
    tx.set(db.doc(`resources/${rid}/files/${fid}`), { ...info, createdAt: FieldValue.serverTimestamp() }); // storagePath chỉ nằm ở subcollection (admin-only)
    tx.update(rRef, { fileSummaries: sums, updatedAt: FieldValue.serverTimestamp() });
    C.audit(tx, { actor: user, action: 'ADMIN_UPLOAD_FILE', entityType: 'resource', entityId: rid, newData: { fileId: fid, name, size: info.fileSize } }, ip);
  });
  C.invalidateCatalog();
  return { id: fid, name, format: info.fileFormat, size: info.fileSize };
});
exports.adminRemoveFile = endpoint(ADMIN, async ({ data, user, ip }) => {
  const rid = S(data.resourceId, { required: true, max: 100 }), fid = S(data.fileId, { required: true, max: 64 });
  const fs = await db.doc(`resources/${rid}/files/${fid}`).get();
  if (!fs.exists) throw new P.AppError('FILE_NOT_FOUND', 'Không tìm thấy file', 'not-found');
  await db.runTransaction(async (tx) => {
    const rRef = db.doc(`resources/${rid}`), s = await tx.get(rRef);
    tx.delete(fs.ref); tx.update(rRef, { fileSummaries: (s.data().fileSummaries || []).filter((x) => x.id !== fid) });
    C.audit(tx, { actor: user, action: 'ADMIN_DELETE_FILE', entityType: 'resource', entityId: rid, oldData: { fileId: fid, name: fs.data().originalName } }, ip);
  });
  await bucket().file(fs.data().storagePath).delete().catch(() => undefined);
  C.invalidateCatalog();
  return { deleted: true };
});
exports.adminFilePreviewUrl = endpoint(ADMIN, async ({ data }) => {
  const fs = await db.doc(`resources/${S(data.resourceId, { required: true, max: 100 })}/files/${S(data.fileId, { required: true, max: 64 })}`).get();
  if (!fs.exists) throw new P.AppError('FILE_NOT_FOUND', 'Không tìm thấy file', 'not-found');
  return signedUrl(fs.data().storagePath, fs.data().originalName);
});

/* ---------- Kiểm duyệt ---------- */
exports.adminModerationQueue = endpoint(ADMIN, async ({ data }) => {
  const snap = await db.collection('resources').where('status', '==', 'PENDING_REVIEW').get();
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((r) => !r.deleted).sort((a, b) => P.millis(a.createdAt) - P.millis(b.createdAt)); // cũ nhất duyệt trước
  const res = slicePage(rows, pageArgs(data));
  res.items = res.items.map((r) => ({ id: r.id, title: r.title, author: r.authorName, subject: r.subjectName, grade: r.gradeName, resourceType: r.resourceTypeName, createdBy: r.createdBy, createdAt: r.createdAt, fileCount: (r.fileSummaries || []).length, hasOnlineUrl: !!r.onlineUrl }));
  return res;
});

async function decide(id, user, ip, decision, reason) {
  const [target, action, notifType, title, msg] = decision === 'APPROVED'
    ? ['PUBLISHED', 'ADMIN_PUBLISH_RESOURCE', 'RESOURCE_APPROVED', 'Tài liệu đã được duyệt', (t) => `"${t}" đã được duyệt và xuất bản.`]
    : ['REJECTED', 'ADMIN_REJECT_RESOURCE', 'RESOURCE_REJECTED', 'Tài liệu bị từ chối', (t) => `"${t}" bị từ chối: ${reason}`];
  await db.runTransaction(async (tx) => {
    const ref = db.doc(`resources/${id}`), s = await tx.get(ref);
    if (!s.exists || s.data().deleted) throw C.notFound();
    const r = { id, ...s.data() };
    if (r.status !== 'PENDING_REVIEW') throw new P.AppError('NOT_PENDING_REVIEW', 'Học liệu không ở trạng thái chờ duyệt');
    if (decision === 'APPROVED') assertContent(r);
    tx.update(ref, { status: target, updatedAt: FieldValue.serverTimestamp(), ...(decision === 'APPROVED' ? { publishedAt: FieldValue.serverTimestamp() } : {}) });
    if (decision === 'APPROVED') { history(tx, id, 'PENDING_REVIEW', 'APPROVED', user.uid, reason); history(tx, id, 'APPROVED', 'PUBLISHED', user.uid, reason); }
    else history(tx, id, 'PENDING_REVIEW', 'REJECTED', user.uid, reason);
    tx.set(db.collection(`resources/${id}/reviews`).doc(), { reviewerId: user.uid, decision, reason: reason ?? null, reviewedAt: FieldValue.serverTimestamp() });
    tx.set(db.collection(`users/${r.createdBy}/notifications`).doc(), { title, message: msg(r.title), type: notifType, isRead: false, createdAt: FieldValue.serverTimestamp() });
    C.bump(tx, decision === 'APPROVED' ? 'approved' : 'rejected');
    C.audit(tx, { actor: user, action, entityType: 'resource', entityId: id, oldData: { status: 'PENDING_REVIEW' }, newData: { status: target, via: 'moderation', reason } }, ip);
  });
  C.invalidateCatalog();
  return getFull(id);
}
exports.adminApprove = endpoint(ADMIN, ({ data, user, ip }) => decide(S(data.id, { required: true, max: 100 }), user, ip, 'APPROVED', S(data.note, { max: 500 })));
exports.adminReject = endpoint(ADMIN, ({ data, user, ip }) => {
  const reason = S(data.reason, { required: true, max: 500, name: 'Lý do từ chối' });
  if (reason.length < 5) throw P.bad('VALIDATION_ERROR', 'Lý do từ chối tối thiểu 5 ký tự');
  return decide(S(data.id, { required: true, max: 100 }), user, ip, 'REJECTED', reason);
});
