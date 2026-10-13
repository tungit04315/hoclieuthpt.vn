'use strict';
const crypto = require('crypto');
const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const P = require('./pure');

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });
const { FieldValue, Timestamp } = admin.firestore;

const REGION = process.env.FUNCTIONS_REGION || 'asia-southeast1';
const sha = (s, algo = 'sha256') => crypto.createHash(algo).update(s).digest('hex');

/* ---------- Validate input (loại HTML, giới hạn độ dài) ---------- */
const clean = (s) => s.replace(/<[^>]*>/g, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
const S = (v, { max = 500, required = false, name = 'Trường này' } = {}) => {
  if (v === undefined || v === null || v === '') { if (required) throw P.bad('VALIDATION_ERROR', `${name} là bắt buộc`); return undefined; }
  if (typeof v !== 'string') throw P.bad('VALIDATION_ERROR', `${name} phải là chuỗi`);
  const c = clean(v);
  if (required && !c) throw P.bad('VALIDATION_ERROR', `${name} là bắt buộc`);
  if (c.length > max) throw P.bad('VALIDATION_ERROR', `${name} tối đa ${max} ký tự`);
  return c || undefined;
};
const N = (v, { min = -Infinity, max = Infinity, required = false, name = 'Trường này' } = {}) => {
  if (v === undefined || v === null || v === '') { if (required) throw P.bad('VALIDATION_ERROR', `${name} là bắt buộc`); return undefined; }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw P.bad('VALIDATION_ERROR', `${name} không hợp lệ`);
  return n;
};
const URLS = (v, name) => {
  const s = S(v, { max: 1000, name }); if (!s) return undefined;
  if (!/^https?:\/\/[^\s]+$/i.test(s)) throw P.bad('VALIDATION_ERROR', `${name} phải là URL http/https`);
  return s;
};
const ENUM = (v, list, name, required = false) => {
  if (v === undefined || v === null || v === '') { if (required) throw P.bad('VALIDATION_ERROR', `${name} là bắt buộc`); return undefined; }
  if (!list.includes(v)) throw P.bad('VALIDATION_ERROR', `${name} phải là một trong: ${list.join(', ')}`);
  return v;
};
const pageArgs = (d) => ({ page: N(d.page, { min: 1, name: 'page' }) || 1, limit: Math.min(N(d.limit, { min: 1, name: 'limit' }) || 10, 50) });
const paginate = (items, total, page, limit) => ({ items, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
const slicePage = (arr, { page, limit }) => paginate(arr.slice((page - 1) * limit, page * limit), arr.length, page, limit);

/* ---------- Rate limit đơn giản theo instance (giảm lạm dụng; dùng thêm App Check ở production) ---------- */
const hits = new Map();
function rateLimit(key, limit, windowMs = 60_000) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) throw new P.AppError('TOO_MANY_REQUESTS', 'Bạn thao tác quá nhanh, vui lòng thử lại sau', 'resource-exhausted');
  arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) hits.clear();
}

/* ---------- Chuyển Timestamp -> ISO để trả về client ---------- */
const plain = (v) => {
  if (v === null || v === undefined) return v;
  if (v instanceof Timestamp || typeof v.toDate === 'function') return v.toDate().toISOString();
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
};

/* ---------- Endpoint: xác thực + phân quyền theo DB (không tin client) ---------- */
async function getActiveUser(uid) {
  const s = await db.doc(`users/${uid}`).get();
  if (!s.exists) throw new P.AppError('ACCOUNT_NOT_FOUND', 'Tài khoản chưa được cấp quyền sử dụng hệ thống', 'permission-denied');
  const u = { uid, ...s.data() };
  if (u.status !== 'ACTIVE') throw new P.AppError('ACCOUNT_DISABLED', 'Tài khoản đã bị khóa hoặc ngưng hoạt động', 'permission-denied');
  return u;
}
/** roles: mảng role được phép. Mọi endpoint đều yêu cầu đăng nhập. */
function endpoint(roles, handler, opts = {}) {
  return onCall({ region: REGION, cors: true, maxInstances: 20, ...opts }, async (req) => {
    try {
      if (!req.auth) throw new P.AppError('UNAUTHORIZED', 'Vui lòng đăng nhập', 'unauthenticated');
      const user = await getActiveUser(req.auth.uid);
      if (!roles.includes(user.role)) throw new P.AppError('FORBIDDEN', 'Bạn không có quyền thực hiện thao tác này', 'permission-denied');
      const ip = req.rawRequest && (req.rawRequest.ip || req.rawRequest.headers['x-forwarded-for']);
      return plain(await handler({ data: req.data || {}, user, ip, req }));
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      if (e instanceof P.AppError) throw new HttpsError(e.status, e.message, { code: e.code });
      console.error(e);
      throw new HttpsError('internal', 'Lỗi hệ thống, vui lòng thử lại sau', { code: 'INTERNAL_ERROR' });
    }
  });
}
const STUDENT = ['STUDENT'], ANY = ['STUDENT', 'ADMIN', 'TEACHER'], ADMIN = ['ADMIN'];

/* ---------- Audit log (ghi cùng transaction/batch với nghiệp vụ) ---------- */
/** w = transaction | batch | null (ghi trực tiếp). Chỉ Admin SDK ghi được; rules chặn mọi truy cập từ client. */
function audit(w, { actor, action, entityType, entityId, oldData, newData }, ip) {
  const ref = db.collection('audit_logs').doc();
  const data = { actorId: actor.uid, action, entityType, entityId: entityId ?? null, oldData: oldData ?? null, newData: newData ?? null, ip: ip ?? null, createdAt: FieldValue.serverTimestamp() };
  return w ? w.set(ref, data) : ref.set(data);
}

/* ---------- Thống kê theo ngày (cộng dồn khi có sự kiện, đọc dashboard rất rẻ) ---------- */
const dayRef = (k) => db.doc(`stats_daily/${k}`);
const bump = (w, field, n = 1, key = P.dayKey()) => w.set(dayRef(key), { date: key, [field]: FieldValue.increment(n) }, { merge: true });
const bumpResource = (w, r, field, key = P.dayKey()) =>
  w.set(dayRef(key).collection('resources').doc(r.id), {
    title: r.title, subjectId: r.subjectId, subjectName: r.subjectName, topicId: r.topicId ?? null, topicName: r.topicName ?? null,
    [field]: FieldValue.increment(1),
  }, { merge: true });
const bumpQuery = (w, qn, key = P.dayKey()) =>
  w.set(dayRef(key).collection('queries').doc(sha(qn, 'sha1').slice(0, 20)), { query: qn, count: FieldValue.increment(1) }, { merge: true });

/* ---------- Cache danh sách học liệu PUBLISHED (60s) để tìm kiếm linh hoạt mà ít tốn lượt đọc ---------- */
let cache = { at: 0, items: null };
async function publishedCatalog() {
  if (cache.items && Date.now() - cache.at < 60_000) return cache.items;
  const snap = await db.collection('resources').where('status', '==', 'PUBLISHED').where('deleted', '==', false).limit(3000).get();
  cache = { at: Date.now(), items: snap.docs.map((d) => ({ id: d.id, ...d.data() })) };
  return cache.items;
}
const invalidateCatalog = () => { cache.at = 0; };

/* ---------- Mapper ---------- */
const toItem = (r, isFavorite = false) => ({
  id: r.id, title: r.title, slug: r.slug, thumbnailUrl: r.thumbnailUrl ?? null,
  summary: r.description ? String(r.description).slice(0, 160) : null, author: r.authorName,
  subject: { id: r.subjectId, name: r.subjectName }, grade: { id: r.gradeId, name: r.gradeName },
  topic: r.topicId ? { id: r.topicId, name: r.topicName } : null,
  resourceType: { id: r.resourceTypeId, name: r.resourceTypeName, code: r.resourceTypeCode },
  fileFormat: (r.fileSummaries && r.fileSummaries[0] && r.fileSummaries[0].format) || null, durationSeconds: r.durationSeconds ?? null,
  viewCount: r.viewCount || 0, downloadCount: r.downloadCount || 0, favoriteCount: r.favoriteCount || 0,
  isFavorite, publishedAt: r.publishedAt ?? null,
});
async function favSet(uid, ids) {
  if (!ids.length) return new Set();
  const snaps = await db.getAll(...ids.map((id) => db.doc(`users/${uid}/bookmarks/${id}`)));
  return new Set(snaps.filter((s) => s.exists).map((s) => s.id));
}
const notFound = () => new P.AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy học liệu', 'not-found');
/** STUDENT chỉ thấy PUBLISHED & chưa xóa; không đủ quyền cũng trả "không tìm thấy" (không lộ sự tồn tại). */
function assertVisible(snap, user) {
  if (!snap.exists) throw notFound();
  const r = snap.data();
  if (r.deleted || (user.role !== 'ADMIN' && r.status !== 'PUBLISHED')) throw notFound();
  return { id: snap.id, ...r };
}
async function loadCatalogs() {
  const [s, g, t, ty] = await Promise.all(['subjects', 'grades', 'topics', 'resourceTypes'].map((c) => db.collection(c).get()));
  const m = (snap) => Object.fromEntries(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
  return { subjects: m(s), grades: m(g), topics: m(t), resourceTypes: m(ty) };
}

module.exports = {
  admin, db, FieldValue, Timestamp, REGION, P, sha, S, N, URLS, ENUM, pageArgs, paginate, slicePage, rateLimit, plain,
  endpoint, STUDENT, ANY, ADMIN, getActiveUser, audit, bump, bumpResource, bumpQuery, dayRef, publishedCatalog, invalidateCatalog,
  toItem, favSet, notFound, assertVisible, loadCatalogs,
};
