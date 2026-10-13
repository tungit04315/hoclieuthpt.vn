'use strict';
const C = require('./lib/common');
const { db, FieldValue, Timestamp, P, S, N, ENUM, pageArgs, paginate, slicePage, endpoint, STUDENT, ANY } = C;

const VIEW_DEDUP_MS = 30 * 60_000; // cùng user + học liệu trong 30 phút chỉ tính 1 lượt xem

/** Gọi ngay sau khi đăng nhập: trả hồ sơ + cập nhật lastLoginAt (tối đa 1 lần/5 phút). */
exports.me = endpoint(ANY, async ({ user }) => {
  const last = user.lastLoginAt && user.lastLoginAt.toMillis ? user.lastLoginAt.toMillis() : 0;
  if (Date.now() - last > 5 * 60_000) await db.doc(`users/${user.uid}`).update({ lastLoginAt: FieldValue.serverTimestamp() });
  return user;
});

exports.updateProfile = endpoint(STUDENT, async ({ data, user }) => {
  const upd = { updatedAt: FieldValue.serverTimestamp() };
  const set = (k, v) => { if (v !== undefined) upd[k] = v; };
  set('fullName', S(data.fullName, { max: 100, name: 'Họ tên' }));
  set('school', S(data.school, { max: 150, name: 'Trường' }));
  set('className', S(data.className, { max: 20, name: 'Lớp' }));
  set('gender', ENUM(data.gender, ['MALE', 'FEMALE', 'OTHER'], 'Giới tính'));
  set('dateOfBirth', S(data.dateOfBirth, { max: 10, name: 'Ngày sinh' }));
  if (data.avatarUrl) set('avatarUrl', C.URLS(data.avatarUrl, 'avatarUrl'));
  if (data.gradeId) {
    const g = await db.doc(`grades/${S(data.gradeId, { max: 10 })}`).get();
    if (!g.exists || g.data().status !== 'ACTIVE') throw P.bad('INVALID_GRADE', 'Khối lớp không hợp lệ');
    upd.gradeId = g.id; upd.gradeName = g.data().name;
  }
  await db.doc(`users/${user.uid}`).update(upd);
  return (await db.doc(`users/${user.uid}`).get()).data();
});

/* ---------- Tìm kiếm / chi tiết ---------- */
exports.searchResources = endpoint(ANY, async ({ data, user }) => {
  C.rateLimit(`search:${user.uid}`, 60);
  const q = S(data.q, { max: 200, name: 'Từ khóa' });
  const filters = {
    subjectId: S(data.subjectId, { max: 100 }), gradeId: S(data.gradeId, { max: 10 }), topicId: S(data.topicId, { max: 150 }),
    resourceTypeId: S(data.resourceTypeId, { max: 100 }), author: S(data.author, { max: 100 }),
  };
  const sort = ENUM(data.sort, ['relevance', 'newest', 'popular', 'title'], 'sort');
  const pg = pageArgs(data);
  const ranked = P.rankSearch(await C.publishedCatalog(), { q, filters, sort });
  const result = slicePage(ranked, pg);
  const favs = await C.favSet(user.uid, result.items.map((r) => r.id));
  result.items = result.items.map((r) => ({ ...C.toItem(r, favs.has(r.id)), ...(q ? { score: r._score } : {}) }));
  if (q && pg.page === 1) await recordSearch(user.uid, q);
  return result;
});

/** Lưu lịch sử tìm kiếm: doc id = hash(query) nên tìm lại cùng câu chỉ cập nhật thời gian (không trùng lặp). */
async function recordSearch(uid, q) {
  const qn = P.normalize(q); if (!qn) return;
  const batch = db.batch();
  batch.set(db.doc(`users/${uid}/searchHistory/${C.sha(qn, 'sha1').slice(0, 20)}`), { query: q, createdAt: FieldValue.serverTimestamp() });
  C.bump(batch, 'searches'); C.bumpQuery(batch, qn);
  await batch.commit();
}

exports.getResource = endpoint(ANY, async ({ data, user }) => {
  const id = S(data.id, { required: true, max: 100, name: 'id' });
  const r = C.assertVisible(await db.doc(`resources/${id}`).get(), user);
  const fav = (await db.doc(`users/${user.uid}/bookmarks/${id}`).get()).exists;
  return {
    ...C.toItem(r, fav), description: r.description ?? null, onlineUrl: r.onlineUrl ?? null,
    files: r.fileSummaries || [], // chỉ id/tên/định dạng/dung lượng — không có đường dẫn lưu trữ
    createdAt: r.createdAt, updatedAt: r.updatedAt, ...(user.role === 'ADMIN' ? { status: r.status } : {}),
  };
});

/** Tăng view_count + ghi lịch sử xem; chống đếm trùng khi frontend refresh liên tục. */
exports.recordView = endpoint(ANY, async ({ data, user }) => {
  const id = S(data.id, { required: true, max: 100, name: 'id' });
  const dur = N(data.durationSeconds, { min: 0, max: 86400, name: 'durationSeconds' });
  return db.runTransaction(async (tx) => {
    const rRef = db.doc(`resources/${id}`), stRef = db.doc(`users/${user.uid}/viewState/${id}`);
    const [rs, st] = await Promise.all([tx.get(rRef), tx.get(stRef)]);
    const r = C.assertVisible(rs, user);
    if (r.status !== 'PUBLISHED') return { counted: false, viewCount: r.viewCount || 0 };
    if (st.exists && Date.now() - st.data().lastAt.toMillis() < VIEW_DEDUP_MS) {
      if (dur && dur > (st.data().durationSeconds || 0)) {
        tx.update(db.doc(`users/${user.uid}/viewHistory/${st.data().historyId}`), { durationSeconds: dur });
        tx.update(stRef, { durationSeconds: dur });
      }
      return { counted: false, viewCount: r.viewCount || 0 };
    }
    const hRef = db.collection(`users/${user.uid}/viewHistory`).doc();
    tx.set(hRef, { resourceId: id, viewedAt: FieldValue.serverTimestamp(), durationSeconds: dur ?? null, subjectId: r.subjectId, topicId: r.topicId ?? null });
    tx.set(stRef, { lastAt: Timestamp.now(), historyId: hRef.id, durationSeconds: dur || 0 });
    tx.update(rRef, { viewCount: FieldValue.increment(1) });
    C.bump(tx, 'views'); C.bumpResource(tx, r, 'views');
    return { counted: true, viewCount: (r.viewCount || 0) + 1 };
  });
});

/* ---------- Bookmark (transaction, idempotent, không âm) ---------- */
exports.addBookmark = endpoint(ANY, async ({ data, user }) => {
  const id = S(data.id, { required: true, max: 100, name: 'id' });
  return db.runTransaction(async (tx) => {
    const rRef = db.doc(`resources/${id}`), bRef = db.doc(`users/${user.uid}/bookmarks/${id}`);
    const [rs, bs] = await Promise.all([tx.get(rRef), tx.get(bRef)]);
    const r = C.assertVisible(rs, user);
    if (bs.exists) return { isFavorite: true, favoriteCount: r.favoriteCount || 0 };
    tx.set(bRef, { createdAt: FieldValue.serverTimestamp(), subjectId: r.subjectId, topicId: r.topicId ?? null });
    tx.update(rRef, { favoriteCount: FieldValue.increment(1) });
    return { isFavorite: true, favoriteCount: (r.favoriteCount || 0) + 1 };
  });
});
exports.removeBookmark = endpoint(ANY, async ({ data, user }) => {
  const id = S(data.id, { required: true, max: 100, name: 'id' });
  return db.runTransaction(async (tx) => {
    const rRef = db.doc(`resources/${id}`), bRef = db.doc(`users/${user.uid}/bookmarks/${id}`);
    const [rs, bs] = await Promise.all([tx.get(rRef), tx.get(bRef)]);
    let count = rs.exists ? rs.data().favoriteCount || 0 : 0;
    if (bs.exists) {
      tx.delete(bRef);
      if (rs.exists) { count = Math.max(0, count - 1); tx.update(rRef, { favoriteCount: count }); }
    }
    return { isFavorite: false, favoriteCount: count };
  });
});

/** Nạp học liệu theo danh sách id, bỏ những cái không còn PUBLISHED. */
async function loadPublished(ids) {
  if (!ids.length) return new Map();
  const snaps = await db.getAll(...ids.map((i) => db.doc(`resources/${i}`)));
  return new Map(snaps.filter((s) => s.exists && !s.data().deleted && s.data().status === 'PUBLISHED').map((s) => [s.id, { id: s.id, ...s.data() }]));
}
exports.listBookmarks = endpoint(ANY, async ({ data, user }) => {
  const pg = pageArgs(data), col = db.collection(`users/${user.uid}/bookmarks`);
  const [snap, total] = await Promise.all([
    col.orderBy('createdAt', 'desc').offset((pg.page - 1) * pg.limit).limit(pg.limit).get(), col.count().get(),
  ]);
  const map = await loadPublished(snap.docs.map((d) => d.id));
  const items = snap.docs.filter((d) => map.has(d.id)).map((d) => ({ ...C.toItem(map.get(d.id), true), bookmarkedAt: d.data().createdAt }));
  return paginate(items, total.data().count, pg.page, pg.limit);
});
exports.listViewHistory = endpoint(ANY, async ({ data, user }) => {
  const pg = pageArgs(data), col = db.collection(`users/${user.uid}/viewHistory`);
  const [snap, total] = await Promise.all([
    col.orderBy('viewedAt', 'desc').offset((pg.page - 1) * pg.limit).limit(pg.limit).get(), col.count().get(),
  ]);
  const map = await loadPublished([...new Set(snap.docs.map((d) => d.data().resourceId))]);
  const favs = await C.favSet(user.uid, [...map.keys()]);
  const items = snap.docs.filter((d) => map.has(d.data().resourceId)).map((d) => ({
    id: d.id, viewedAt: d.data().viewedAt, durationSeconds: d.data().durationSeconds ?? null,
    resource: C.toItem(map.get(d.data().resourceId), favs.has(d.data().resourceId)),
  }));
  return paginate(items, total.data().count, pg.page, pg.limit);
});

/* ---------- Tải xuống: kiểm quyền -> PUBLISHED -> có file -> ký URL -> ghi lịch sử ---------- */
exports.getDownloadUrl = endpoint(ANY, async ({ data, user, ip }) => {
  C.rateLimit(`dl:${user.uid}`, 30);
  const id = S(data.id, { required: true, max: 100, name: 'id' });
  const r = C.assertVisible(await db.doc(`resources/${id}`).get(), user);
  if (r.status !== 'PUBLISHED') throw new P.AppError('RESOURCE_NOT_PUBLISHED', 'Học liệu chưa được xuất bản');
  const fid = S(data.fileId, { max: 100 });
  let fileSnap;
  if (fid) fileSnap = await db.doc(`resources/${id}/files/${fid}`).get();
  else { const q = await db.collection(`resources/${id}/files`).orderBy('createdAt', 'asc').limit(1).get(); fileSnap = q.docs[0]; }
  if (!fileSnap || !fileSnap.exists) throw new P.AppError('FILE_NOT_FOUND', 'Học liệu này không có file để tải xuống', 'not-found');
  const f = fileSnap.data();
  const signed = await require('./lib/storage').signedUrl(f.storagePath, f.originalName); // ký xong mới tính lượt tải
  const batch = db.batch();
  batch.set(db.collection('download_history').doc(), {
    userId: user.uid, resourceId: id, fileId: fileSnap.id, createdAt: FieldValue.serverTimestamp(),
    ipHash: ip ? C.sha(String(ip) + (process.env.IP_HASH_SALT || '')) : null, // không lưu IP gốc
  });
  batch.update(db.doc(`resources/${id}`), { downloadCount: FieldValue.increment(1) });
  C.bump(batch, 'downloads'); C.bumpResource(batch, r, 'downloads');
  await batch.commit();
  return { url: signed.url, expiresIn: signed.expiresIn, fileName: f.originalName, fileFormat: f.fileFormat, fileSize: f.fileSize };
});

/* ---------- Trang chủ + gợi ý (dựa trên hành vi, không AI) ---------- */
async function recommendFor(uid, gradeId) {
  const [views, bms, seenSnap, all] = await Promise.all([
    db.collection(`users/${uid}/viewHistory`).orderBy('viewedAt', 'desc').limit(200).get(),
    db.collection(`users/${uid}/bookmarks`).limit(200).get(), db.collection(`users/${uid}/viewState`).select().get(), C.publishedCatalog(),
  ]);
  return P.recommend(all, {
    gradeId, views: views.docs.map((d) => d.data()), bookmarks: bms.docs.map((d) => d.data()), seen: new Set(seenSnap.docs.map((d) => d.id)),
  });
}
exports.getRecommendations = endpoint(STUDENT, async ({ data, user }) => {
  const pg = pageArgs(data), { list, personalized } = await recommendFor(user.uid, user.gradeId);
  const res = slicePage(list, pg), favs = await C.favSet(user.uid, res.items.map((r) => r.id));
  res.items = res.items.map((r) => ({ ...C.toItem(r, favs.has(r.id)), score: r._score, reason: r._reason }));
  return { ...res, personalized };
});

/** Màn hình Trang chủ: 1 request duy nhất. */
exports.getHome = endpoint(STUDENT, async ({ user }) => {
  const [rec, all, unread, subjects, grades, settings] = await Promise.all([
    recommendFor(user.uid, user.gradeId), C.publishedCatalog(),
    db.collection(`users/${user.uid}/notifications`).where('isRead', '==', false).count().get(),
    db.collection('subjects').where('status', '==', 'ACTIVE').get(), db.collection('grades').where('status', '==', 'ACTIVE').get(),
    db.doc('settings/home').get(),
  ]);
  const popular = [...all].sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0)).slice(0, 6);
  const latest = [...all].sort((a, b) => P.millis(b.publishedAt) - P.millis(a.publishedAt)).slice(0, 6);
  const top = rec.list.slice(0, 6);
  const favs = await C.favSet(user.uid, [...new Set([...top, ...popular, ...latest].map((r) => r.id))]);
  const it = (r) => C.toItem(r, favs.has(r.id));
  const name = String(user.fullName || '').trim().split(/\s+/).slice(-2).join(' '); // "Nguyễn Như Ý" -> "Như Ý"
  return {
    greeting: `Chào ${name} 👋`, subtitle: 'Học tốt hôm nay, vững vàng tương lai!',
    user: { id: user.uid, fullName: user.fullName, avatarUrl: user.avatarUrl ?? null, school: user.school ?? null, className: user.className ?? null,
      grade: user.gradeId ? { id: user.gradeId, name: user.gradeName } : null, unreadNotifications: unread.data().count },
    recommended: top.map((r) => ({ ...it(r), reason: r._reason })), popular: popular.map(it), latest: latest.map(it),
    subjects: subjects.docs.map((d) => ({ id: d.id, name: d.data().name })), grades: grades.docs.map((d) => ({ id: d.id, name: d.data().name })),
    introduction: settings.exists && settings.data().introduction ? { ...settings.data().introduction, stats: [{ n: all.length, l: 'Học liệu số' }, { n: subjects.size, l: 'Môn học' }] } : null,
    guide: settings.exists && Array.isArray(settings.data().guide) ? settings.data().guide : null,
  };
});
