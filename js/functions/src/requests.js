'use strict';
// Yêu cầu bổ sung học liệu: học sinh/giáo viên gửi khi Trợ lý AI không tìm thấy; quản trị viên xử lý và hệ thống thông báo lại.
// Collection `resource_requests` chỉ truy cập qua Functions (Security Rules chặn client).
const C = require('./lib/common');
const { db, FieldValue, P, S, ENUM, pageArgs, paginate, endpoint, ANY, ADMIN } = C;

const col = () => db.collection('resource_requests');
const STUDENT_OR_TEACHER = ['STUDENT', 'TEACHER'];

/** Gửi yêu cầu. id = uid + hash(nội dung) → gửi lại đúng nội dung đang chờ xử lý chỉ trả { duplicate: true } (idempotent). */
exports.createResourceRequest = endpoint(STUDENT_OR_TEACHER, async ({ data, user }) => {
  C.rateLimit(`request:${user.uid}`, 10, 60 * 60_000);
  const r = P.normalizeRequest(data);
  const ref = col().doc(`${user.uid}_${C.sha(P.normalize(r.text), 'sha1').slice(0, 16)}`);
  const out = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (s.exists && s.data().status === 'NEW') return { duplicate: true };
    tx.set(ref, { ...r, userId: user.uid, userName: user.fullName || user.email || user.uid, status: 'NEW', note: null,
      createdAt: FieldValue.serverTimestamp(), handledAt: null, handledBy: null });
    C.bump(tx, 'requests');
    return { id: ref.id, status: 'NEW' };
  });
  return out;
});

/** Admin: danh sách yêu cầu (mới nhất trước), lọc theo status. Lọc trong bộ nhớ trên 500 yêu cầu gần nhất (tránh composite index). */
exports.adminListResourceRequests = endpoint(ADMIN, async ({ data }) => {
  const status = ENUM(data.status, P.REQUEST_STATUS, 'status'), pg = pageArgs(data);
  const snap = await col().orderBy('createdAt', 'desc').limit(500).get();
  const all = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((x) => !status || x.status === status);
  return paginate(all.slice((pg.page - 1) * pg.limit, pg.page * pg.limit), all.length, pg.page, pg.limit);
});

/** Admin: đánh dấu DONE | REJECTED (chỉ từ NEW), kèm ghi chú; thông báo cho người gửi + audit log trong cùng batch. */
exports.adminUpdateResourceRequest = endpoint(ADMIN, async ({ data, user, ip }) => {
  const id = S(data.id, { required: true, max: 200, name: 'id' });
  const status = ENUM(data.status, ['DONE', 'REJECTED'], 'status', true);
  const note = S(data.note, { max: 300, name: 'Ghi chú' }) || null;
  const ref = col().doc(id);
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) throw new P.AppError('REQUEST_NOT_FOUND', 'Không tìm thấy yêu cầu', 'not-found');
    const r = s.data();
    if (r.status !== 'NEW') throw new P.AppError('REQUEST_ALREADY_HANDLED', 'Yêu cầu này đã được xử lý');
    tx.update(ref, { status, note, handledAt: FieldValue.serverTimestamp(), handledBy: user.uid });
    tx.set(db.collection(`users/${r.userId}/notifications`).doc(), {
      title: status === 'DONE' ? 'Yêu cầu tài liệu đã được xử lý' : 'Yêu cầu tài liệu chưa thể đáp ứng',
      message: `“${r.text}”${note ? ` — ${note}` : ''}`, type: 'SYSTEM', isRead: false, createdAt: FieldValue.serverTimestamp(),
    });
    C.audit(tx, { actor: user, action: 'ADMIN_HANDLE_RESOURCE_REQUEST', entityType: 'resource_request', entityId: id, oldData: { status: r.status }, newData: { status, note } }, ip);
  });
  return { ok: true, id, status };
});
