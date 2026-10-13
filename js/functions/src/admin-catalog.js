'use strict';
const C = require('./lib/common');
const { db, FieldValue, P, S, ENUM, endpoint, ADMIN } = C;

const ENTITIES = { subjects: 'subjects', grades: 'grades', topics: 'topics', 'resource-types': 'resourceTypes' };
const col = (e) => { if (!ENTITIES[e]) throw new P.AppError('CATALOG_NOT_FOUND', 'Danh mục không tồn tại', 'not-found'); return ENTITIES[e]; };
// Tên danh mục được lưu lặp (denormalize) trong từng học liệu => khi đổi tên phải cập nhật lại
const RES_FIELD = { subjects: ['subjectId', 'subjectName'], grades: ['gradeId', 'gradeName'], topics: ['topicId', 'topicName'], resourceTypes: ['resourceTypeId', 'resourceTypeName'] };

exports.adminListCatalog = endpoint(ADMIN, async ({ data }) => {
  const c = col(S(data.entity, { required: true, max: 20 }));
  const subjectId = S(data.subjectId, { max: 100 }), status = ENUM(data.status, ['ACTIVE', 'INACTIVE'], 'status');
  const snap = await db.collection(c).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((x) => (!status || x.status === status) && (!subjectId || x.subjectId === subjectId))
    .sort((a, b) => String(a.id).localeCompare(String(b.id), 'vi', { numeric: true }));
});

exports.adminSaveCatalog = endpoint(ADMIN, async ({ data, user, ip }) => {
  const entity = S(data.entity, { required: true, max: 20 }), c = col(entity);
  const name = S(data.name, { required: true, max: 100, name: 'Tên' }), description = S(data.description, { max: 500 });
  const status = ENUM(data.status, ['ACTIVE', 'INACTIVE'], 'status') || 'ACTIVE';
  let id = S(data.id, { max: 150 }), doc = { name, status };
  if (entity === 'grades') id = id || name;
  else {
    doc.description = description ?? null;
    if (entity === 'resource-types') {
      const code = S(data.code, { required: true, max: 30, name: 'Mã' }).toUpperCase();
      if (!/^[A-Z0-9_]{2,30}$/.test(code)) throw P.bad('VALIDATION_ERROR', 'Mã chỉ gồm A-Z, 0-9, _');
      doc.code = code; id = id || code.toLowerCase();
    } else {
      doc.slug = P.slugify(name);
      if (entity === 'topics') {
        const sid = S(data.subjectId, { required: true, max: 100, name: 'Môn học' });
        if (!(await db.doc(`subjects/${sid}`).get()).exists) throw P.bad('INVALID_SUBJECT', 'Môn học không tồn tại');
        doc.subjectId = sid; id = id || `${sid}-${doc.slug}`;
      } else id = id || doc.slug;
    }
  }
  if (!/^[A-Za-z0-9_-]{1,150}$/.test(id)) throw P.bad('VALIDATION_ERROR', 'id không hợp lệ');
  const ref = db.doc(`${c}/${id}`), old = await ref.get();
  const batch = db.batch();
  batch.set(ref, { ...doc, ...(old.exists ? {} : { createdAt: FieldValue.serverTimestamp() }) }, { merge: true });
  C.audit(batch, { actor: user, action: old.exists ? 'ADMIN_UPDATE_CATALOG' : 'ADMIN_CREATE_CATALOG', entityType: entity, entityId: id, oldData: old.exists ? old.data() : null, newData: doc }, ip);
  await batch.commit();
  if (old.exists && old.data().name !== name) await propagateName(c, id, name);
  return { id, ...doc };
});

async function propagateName(c, id, name) {
  const [idField, nameField] = RES_FIELD[c];
  const snap = await db.collection('resources').where(idField, '==', id).get();
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = db.batch();
    for (const d of snap.docs.slice(i, i + 400)) batch.update(d.ref, { [nameField]: name, ...P.derive({ ...d.data(), [nameField]: name }) });
    await batch.commit();
  }
  C.invalidateCatalog();
}

/** "Xóa" luôn là chuyển INACTIVE (soft) để không làm mồ côi học liệu đang dùng. */
exports.adminDisableCatalog = endpoint(ADMIN, async ({ data, user, ip }) => {
  const entity = S(data.entity, { required: true, max: 20 }), c = col(entity), id = S(data.id, { required: true, max: 150 });
  const ref = db.doc(`${c}/${id}`), s = await ref.get();
  if (!s.exists) throw new P.AppError('CATALOG_ITEM_NOT_FOUND', 'Không tìm thấy mục danh mục', 'not-found');
  const batch = db.batch();
  batch.update(ref, { status: 'INACTIVE' });
  C.audit(batch, { actor: user, action: 'ADMIN_DISABLE_CATALOG', entityType: entity, entityId: id, oldData: { status: s.data().status }, newData: { status: 'INACTIVE' } }, ip);
  await batch.commit();
  return { id, ...s.data(), status: 'INACTIVE' };
});

/** Thông báo hệ thống: 1 người (userId) hoặc toàn bộ học sinh đang ACTIVE. */
exports.adminSendNotification = endpoint(ADMIN, async ({ data, user, ip }) => {
  const title = S(data.title, { required: true, max: 120, name: 'Tiêu đề' }), message = S(data.message, { required: true, max: 1000, name: 'Nội dung' });
  const type = ENUM(data.type, ['SYSTEM', 'ANNOUNCEMENT'], 'type') || 'ANNOUNCEMENT', uid = S(data.userId, { max: 128 });
  const ids = uid ? [uid] : (await db.collection('users').where('role', '==', 'STUDENT').where('status', '==', 'ACTIVE').get()).docs.map((d) => d.id);
  for (let i = 0; i < ids.length; i += 400) {
    const batch = db.batch();
    for (const id of ids.slice(i, i + 400)) batch.set(db.collection(`users/${id}/notifications`).doc(), { title, message, type, isRead: false, createdAt: FieldValue.serverTimestamp() });
    await batch.commit();
  }
  await C.audit(null, { actor: user, action: 'ADMIN_CREATE_NOTIFICATION', entityType: 'notification', newData: { title, target: uid || 'ALL_STUDENTS', sent: ids.length } }, ip);
  return { sent: ids.length };
});
