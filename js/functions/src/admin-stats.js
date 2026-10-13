'use strict';
const C = require('./lib/common');
const { db, P, S, N, ENUM, pageArgs, slicePage, endpoint, ADMIN } = C;
const { AggregateField } = require('firebase-admin/firestore');

const count = async (q) => (await q.count().get()).data().count;
const range = (d) => P.resolveRange({ range: d.range, from: d.from, to: d.to });

/** Chuỗi theo ngày, điền 0 cho ngày không có dữ liệu. */
async function daily(days) {
  const snaps = await db.getAll(...days.map(C.dayRef));
  return snaps.map((s, i) => ({ date: days[i], ...(s.exists ? s.data() : {}) }));
}
const series = (rows, field) => rows.map((r) => ({ date: r.date, count: r[field] || 0 }));
const sum = (rows, field) => rows.reduce((t, r) => t + (r[field] || 0), 0);
/** Gộp subcollection theo ngày (resources/queries) rồi lấy top. */
async function topFrom(days, sub, field, keyOf, pick, limit = 5) {
  const snaps = await Promise.all(days.map((k) => C.dayRef(k).collection(sub).get()));
  const m = new Map();
  for (const s of snaps) for (const d of s.docs) {
    const x = d.data(), k = keyOf(d, x); if (!k || !x[field]) continue;
    const cur = m.get(k) || { ...pick(d, x), count: 0 };
    cur.count += x[field]; m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}
const topResources = (days, field, limit = 5) => topFrom(days, 'resources', field, (d) => d.id, (d, x) => ({ id: d.id, title: x.title }), limit);
const topQueries = (days, limit = 10) => topFrom(days, 'queries', 'count', (d, x) => x.query, (d, x) => ({ query: x.query }), limit);

async function totals() {
  const live = (q) => q.where('deleted', '==', false), res = db.collection('resources');
  const [students, teachers, total, published, pending, rejected, sums, bookmarks] = await Promise.all([
    count(db.collection('users').where('role', '==', 'STUDENT')), count(db.collection('users').where('role', '==', 'TEACHER')),
    count(live(res)), count(live(res).where('status', '==', 'PUBLISHED')), count(live(res).where('status', '==', 'PENDING_REVIEW')),
    count(live(res).where('status', '==', 'REJECTED')),
    live(res).aggregate({ v: AggregateField.sum('viewCount'), d: AggregateField.sum('downloadCount') }).get(),
    count(db.collectionGroup('bookmarks')),
  ]);
  return { totalStudents: students, totalTeachers: teachers, totalResources: total, publishedResources: published, pendingResources: pending,
    rejectedResources: rejected, totalViews: sums.data().v || 0, totalDownloads: sums.data().d || 0, totalBookmarks: bookmarks };
}
async function groupCounts(col, field, values) {
  const out = {}; await Promise.all(values.map(async (v) => { out[v] = await count(db.collection(col).where(field, '==', v)); })); return out;
}

async function overview(d) {
  const days = range(d), rows = await daily(days);
  const [t, tv, td, tq] = await Promise.all([totals(), topResources(days, 'views'), topResources(days, 'downloads'), topQueries(days)]);
  return { range: { from: days[0], to: days[days.length - 1] }, ...t,
    inRange: { views: sum(rows, 'views'), downloads: sum(rows, 'downloads'), newUsers: sum(rows, 'newUsers'), newResources: sum(rows, 'newResources'), searches: sum(rows, 'searches') },
    topViewedResources: tv, topDownloadedResources: td, topSearchQueries: tq };
}
exports.adminDashboard = endpoint(ADMIN, ({ data }) => overview(data));

exports.adminStatistics = endpoint(ADMIN, async ({ data }) => {
  const kind = ENUM(data.kind, ['overview', 'resources', 'users', 'search', 'downloads', 'views'], 'kind', true);
  if (kind === 'overview') return overview(data);
  const days = range(data), rows = await daily(days), r = { from: days[0], to: days[days.length - 1] };
  if (kind === 'resources') {
    const statuses = ['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'PUBLISHED', 'HIDDEN', 'ARCHIVED'];
    const [byStatus, subj, top] = await Promise.all([groupCounts('resources', 'status', statuses),
      topFrom(days, 'resources', 'views', (d, x) => x.subjectId, (d, x) => ({ id: x.subjectId, name: x.subjectName })),
      topFrom(days, 'resources', 'views', (d, x) => x.topicId, (d, x) => ({ id: x.topicId, name: x.topicName }))]);
    return { range: r, newResourcesPerDay: series(rows, 'newResources'), approvedPerDay: series(rows, 'approved'), rejectedPerDay: series(rows, 'rejected'), byStatus, topSubjects: subj, topTopics: top };
  }
  if (kind === 'users') {
    const [byRole, byStatus] = await Promise.all([groupCounts('users', 'role', ['STUDENT', 'TEACHER', 'ADMIN']), groupCounts('users', 'status', ['ACTIVE', 'INACTIVE', 'SUSPENDED'])]);
    return { range: r, registrationsPerDay: series(rows, 'newUsers'), byRole, byStatus };
  }
  if (kind === 'search') return { range: r, searchesPerDay: series(rows, 'searches'), topQueries: await topQueries(days, 20) };
  if (kind === 'downloads') return { range: r, downloadsPerDay: series(rows, 'downloads'), topResources: await topResources(days, 'downloads', 10) };
  return { range: r, viewsPerDay: series(rows, 'views'), topResources: await topResources(days, 'views', 10) };
});

/** Audit log: chỉ đọc (không có API sửa/xóa; Security Rules chặn mọi truy cập từ client). */
exports.adminListAuditLogs = endpoint(ADMIN, async ({ data }) => {
  const f = { action: S(data.action, { max: 60 }), entityType: S(data.entityType, { max: 40 }), entityId: S(data.entityId, { max: 150 }), actorId: S(data.actorId, { max: 128 }) };
  const from = data.from ? Date.parse(data.from) : 0, to = data.to ? Date.parse(data.to) + 864e5 : Infinity;
  const snap = await db.collection('audit_logs').orderBy('createdAt', 'desc').limit(1000).get(); // 1000 bản ghi gần nhất
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((r) => Object.entries(f).every(([k, v]) => !v || r[k] === v) && P.millis(r.createdAt) >= from && P.millis(r.createdAt) < to);
  return slicePage(rows, pageArgs(data));
});
