'use strict';
// Quản trị nội dung trang chủ học sinh: tab "Giới thiệu" và tab "Hướng dẫn" (document settings/home).
const C = require('./lib/common');
const { db, FieldValue, P, endpoint, ADMIN } = C;

const ref = () => db.doc('settings/home');

exports.adminGetHomeContent = endpoint(ADMIN, async () => {
  const s = await ref().get(), d = s.exists ? s.data() : {};
  return { introduction: d.introduction ?? null, guide: Array.isArray(d.guide) ? d.guide : [], updatedAt: d.contentUpdatedAt ?? null, updatedBy: d.contentUpdatedBy ?? null };
});

/** Ghi đè toàn bộ nội dung (admin sửa trọn form rồi lưu). Audit ghi cùng transaction với bản cũ/mới. */
exports.adminSaveHomeContent = endpoint(ADMIN, async ({ data, user, ip }) => {
  const next = P.normalizeHomeContent(data);
  await db.runTransaction(async (tx) => {
    const old = await tx.get(ref()), o = old.exists ? old.data() : {};
    tx.set(ref(), { ...next, contentUpdatedAt: FieldValue.serverTimestamp(), contentUpdatedBy: user.uid }, { merge: true });
    C.audit(tx, { actor: user, action: 'ADMIN_UPDATE_HOME_CONTENT', entityType: 'settings', entityId: 'home',
      oldData: { introduction: o.introduction ?? null, guide: o.guide ?? null }, newData: next }, ip);
  });
  return { ok: true, ...next };
});
