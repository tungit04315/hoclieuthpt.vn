'use strict';
const crypto = require('crypto');
const C = require('./lib/common');
const { admin, db, FieldValue, P, S, ENUM, pageArgs, slicePage, endpoint, ADMIN } = C;

const ROLES = ['STUDENT', 'TEACHER', 'ADMIN'], STATUSES = ['ACTIVE', 'INACTIVE', 'SUSPENDED'];
const STUDENT_EMAIL_DOMAIN = 'hs.thuvien.vn'; // email nội bộ cho tài khoản đăng nhập bằng mã học sinh
const PASSWORD_RE = /^(?=.*[A-Za-z])(?=.*\d).{8,64}$/;
const pw = (v) => {
  if (!PASSWORD_RE.test(String(v || ''))) throw P.bad('WEAK_PASSWORD', 'Mật khẩu 8-64 ký tự, gồm cả chữ và số');
  return v;
};
const notSelf = (id, actor) => {
  if (id === actor.uid) throw new P.AppError('CANNOT_MODIFY_SELF', 'Không thể tự thay đổi quyền/trạng thái của chính mình');
};
const getUserDoc = async (uid) => {
  const s = await db.doc(`users/${uid}`).get();
  if (!s.exists) throw new P.AppError('USER_NOT_FOUND', 'Không tìm thấy người dùng', 'not-found');
  return { uid, ...s.data() };
};
async function assertUnique(field, value, exceptUid) {
  if (!value) return;
  const q = await db.collection('users').where(field, '==', value).limit(2).get();
  if (q.docs.some((d) => d.id !== exceptUid)) throw new P.AppError('DUPLICATE_VALUE', `${field} đã tồn tại`, 'already-exists');
}
const safeSnap = (u) => ({ email: u.email, studentCode: u.studentCode ?? null, fullName: u.fullName, role: u.role, status: u.status, gradeId: u.gradeId ?? null });

exports.adminListUsers = endpoint(ADMIN, async ({ data }) => {
  const role = ENUM(data.role, ROLES, 'role'), status = ENUM(data.status, STATUSES, 'status');
  const s = P.normalize(S(data.search, { max: 100 }) || '');
  const snap = await db.collection('users').limit(2000).get(); // quy mô trường học
  const rows = snap.docs.map((d) => ({ uid: d.id, ...d.data() }))
    .filter((u) => (!role || u.role === role) && (!status || u.status === status)
      && (!s || P.normalize([u.fullName, u.email, u.phone, u.studentCode].filter(Boolean).join(' ')).includes(s)))
    .sort((a, b) => P.millis(b.createdAt) - P.millis(a.createdAt));
  return slicePage(rows, pageArgs(data));
});
exports.adminGetUser = endpoint(ADMIN, async ({ data }) => getUserDoc(S(data.uid, { required: true, max: 128 })));

/**
 * STUDENT đăng nhập bằng email hoặc mã học sinh: nếu không có email thật, Auth email = <mã>@hs.thuvien.vn
 * (client tự ghép khi người dùng nhập mã). ADMIN/TEACHER bắt buộc có email.
 */
exports.adminCreateUser = endpoint(ADMIN, async ({ data, user, ip }) => {
  const role = ENUM(data.role, ROLES, 'role', true), password = pw(data.password);
  const fullName = S(data.fullName, { required: true, max: 100, name: 'Họ tên' });
  const code = S(data.studentCode, { max: 30 })?.toUpperCase();
  if (code && !/^[A-Z0-9_-]{3,30}$/.test(code)) throw P.bad('VALIDATION_ERROR', 'Mã học sinh không hợp lệ');
  const contactEmail = S(data.email, { max: 120 })?.toLowerCase();
  if (contactEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail)) throw P.bad('VALIDATION_ERROR', 'Email không hợp lệ');
  const authEmail = contactEmail || (role === 'STUDENT' && code ? `${code.toLowerCase()}@${STUDENT_EMAIL_DOMAIN}` : null);
  if (!authEmail) throw P.bad('IDENTIFIER_REQUIRED', 'Cần email (hoặc mã học sinh cho tài khoản STUDENT)');
  await assertUnique('studentCode', code);

  const profile = {};
  if (role === 'STUDENT') {
    const school = S(data.school, { required: true, max: 150, name: 'Trường' }), className = S(data.className, { required: true, max: 20, name: 'Lớp' });
    const g = await db.doc(`grades/${S(data.gradeId, { required: true, max: 10, name: 'Khối' })}`).get();
    if (!g.exists || g.data().status !== 'ACTIVE') throw P.bad('INVALID_GRADE', 'Khối lớp không hợp lệ');
    Object.assign(profile, { school, className, gradeId: g.id, gradeName: g.data().name, gender: ENUM(data.gender, ['MALE', 'FEMALE', 'OTHER'], 'gender') ?? null });
  }
  let rec;
  try { rec = await admin.auth().createUser({ email: authEmail, password, displayName: fullName }); }
  catch (e) { if (e.code === 'auth/email-already-exists') throw new P.AppError('DUPLICATE_VALUE', 'Email/mã học sinh đã tồn tại', 'already-exists'); throw e; }
  await admin.auth().setCustomUserClaims(rec.uid, { role }); // claim dùng cho Security Rules; quyền thật kiểm tra lại ở DB
  const doc = {
    email: authEmail, contactEmail: contactEmail ?? null, phone: S(data.phone, { max: 20 }) ?? null, studentCode: code ?? null, fullName, role,
    status: 'ACTIVE', avatarUrl: null, ...profile, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), lastLoginAt: null,
  };
  const batch = db.batch();
  batch.set(db.doc(`users/${rec.uid}`), doc);
  C.bump(batch, 'newUsers');
  C.audit(batch, { actor: user, action: 'ADMIN_CREATE_USER', entityType: 'user', entityId: rec.uid, newData: safeSnap(doc) }, ip);
  await batch.commit();
  return { uid: rec.uid, ...safeSnap(doc) };
});

exports.adminUpdateUser = endpoint(ADMIN, async ({ data, user, ip }) => {
  const uid = S(data.uid, { required: true, max: 128 }), old = await getUserDoc(uid);
  const upd = { updatedAt: FieldValue.serverTimestamp() };
  const set = (k, v) => { if (v !== undefined) upd[k] = v; };
  set('fullName', S(data.fullName, { max: 100 })); set('phone', S(data.phone, { max: 20 }));
  set('school', S(data.school, { max: 150 })); set('className', S(data.className, { max: 20 }));
  const code = S(data.studentCode, { max: 30 })?.toUpperCase();
  if (code && code !== old.studentCode) { await assertUnique('studentCode', code, uid); upd.studentCode = code; }
  if (data.gradeId) {
    const g = await db.doc(`grades/${S(data.gradeId, { max: 10 })}`).get();
    if (!g.exists || g.data().status !== 'ACTIVE') throw P.bad('INVALID_GRADE', 'Khối lớp không hợp lệ');
    upd.gradeId = g.id; upd.gradeName = g.data().name;
  }
  const role = ENUM(data.role, ROLES, 'role'), roleChanged = role && role !== old.role;
  if (roleChanged) { notSelf(uid, user); upd.role = role; }
  const batch = db.batch();
  batch.update(db.doc(`users/${uid}`), upd);
  C.audit(batch, { actor: user, action: 'ADMIN_UPDATE_USER', entityType: 'user', entityId: uid, oldData: safeSnap(old), newData: { ...safeSnap(old), ...upd, updatedAt: undefined } }, ip);
  if (roleChanged) C.audit(batch, { actor: user, action: 'ADMIN_CHANGE_ROLE', entityType: 'user', entityId: uid, oldData: { role: old.role }, newData: { role } }, ip);
  await batch.commit();
  if (upd.fullName) await admin.auth().updateUser(uid, { displayName: upd.fullName });
  if (roleChanged) { await admin.auth().setCustomUserClaims(uid, { role }); await admin.auth().revokeRefreshTokens(uid); }
  return getUserDoc(uid);
});

exports.adminSetUserStatus = endpoint(ADMIN, async ({ data, user, ip }) => {
  const uid = S(data.uid, { required: true, max: 128 }), status = ENUM(data.status, STATUSES, 'status', true);
  notSelf(uid, user);
  const old = await getUserDoc(uid);
  const action = { ACTIVE: 'ADMIN_ACTIVATE_USER', INACTIVE: 'ADMIN_DEACTIVATE_USER', SUSPENDED: 'ADMIN_SUSPEND_USER' }[status];
  const batch = db.batch();
  batch.update(db.doc(`users/${uid}`), { status, updatedAt: FieldValue.serverTimestamp() });
  C.audit(batch, { actor: user, action, entityType: 'user', entityId: uid, oldData: { status: old.status }, newData: { status, reason: S(data.reason, { max: 300 }) } }, ip);
  await batch.commit();
  // Khóa: chặn đăng nhập mới + thu hồi refresh token. (ID token đang có còn hiệu lực tối đa ~1h với Rules, nhưng mọi Cloud Function đều từ chối ngay.)
  await admin.auth().updateUser(uid, { disabled: status !== 'ACTIVE' });
  if (status !== 'ACTIVE') await admin.auth().revokeRefreshTokens(uid);
  return getUserDoc(uid);
});

exports.adminResetPassword = endpoint(ADMIN, async ({ data, user, ip }) => {
  const uid = S(data.uid, { required: true, max: 128 }); await getUserDoc(uid);
  const temp = data.newPassword ? pw(data.newPassword) : `Tv${crypto.randomBytes(6).toString('base64url')}9`;
  await admin.auth().updateUser(uid, { password: temp });
  await admin.auth().revokeRefreshTokens(uid);
  await C.audit(null, { actor: user, action: 'ADMIN_RESET_PASSWORD', entityType: 'user', entityId: uid }, ip); // không ghi mật khẩu
  return data.newPassword ? { reset: true } : { reset: true, temporaryPassword: temp };
});
