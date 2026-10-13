'use strict';
/**
 * Logic thuần (không phụ thuộc Firebase) => dễ unit test và dùng lại cho seed.
 */
class AppError extends Error {
  /** @param {string} code mã lỗi ổn định cho frontend  @param {string} status mã HttpsError (not-found, permission-denied...) */
  constructor(code, message, status = 'failed-precondition') { super(message); this.code = code; this.status = status; }
}
const bad = (code, msg) => new AppError(code, msg, 'invalid-argument');

/* ---------- Chuẩn hóa / token ---------- */
const normalize = (s = '') => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/đ/g, 'd').replace(/\s+/g, ' ').trim();
const slugify = (s) => normalize(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const STOP = new Set('em toi minh can muon tim kiem tai lieu de hieu ve cho lop khoi mon hoc cua va la nhung cac mot nao co the giup xin hay'.split(' '));
const tokenize = (q) => [...new Set(normalize(q).replace(/[^a-z0-9+# ]/g, ' ').split(' ')
  .filter((t) => t.length >= 2 && !STOP.has(t)))].slice(0, 10);

/* ---------- Ngày (múi giờ VN) ---------- */
const TZ = 'Asia/Ho_Chi_Minh';
const dayKey = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
/** Danh sách 'YYYY-MM-DD' từ ngày from đến to (gồm cả hai đầu). Tối đa 92 ngày. */
function daysBetween(fromKey, toKey) {
  const out = [];
  let t = Date.parse(`${fromKey}T00:00:00Z`);
  const end = Date.parse(`${toKey}T00:00:00Z`);
  if (Number.isNaN(t) || Number.isNaN(end) || t > end) throw bad('INVALID_RANGE', 'Khoảng thời gian không hợp lệ');
  while (t <= end) { out.push(new Date(t).toISOString().slice(0, 10)); t += 864e5; }
  if (out.length > 92) throw bad('RANGE_TOO_LARGE', 'Chỉ hỗ trợ tối đa 92 ngày');
  return out;
}
function resolveRange({ range = '30d', from, to } = {}, now = new Date()) {
  const today = dayKey(now);
  if (range === 'today') return [today];
  if (range === '7d' || range === '30d') return daysBetween(dayKey(new Date(+now - (range === '7d' ? 6 : 29) * 864e5)), today);
  if (range === 'custom') return daysBetween(from, to);
  throw bad('INVALID_RANGE', 'range phải là today | 7d | 30d | custom');
}

/* ---------- Mô hình học liệu ---------- */
const millis = (v) => (!v ? Date.now() : v.toMillis ? v.toMillis() : v instanceof Date ? +v : typeof v === 'string' ? Date.parse(v) : +v);
const popularity = (r) => Math.min(1, Math.log(1 + (r.viewCount || 0) + 3 * (r.downloadCount || 0) + 5 * (r.favoriteCount || 0)) / Math.log(1001));
const freshness = (r, now = Date.now()) => Math.exp(-((now - millis(r.publishedAt || r.createdAt)) / 864e5) / 180);

/** Kiểm tra môn/khối/chủ đề/loại tồn tại, đang ACTIVE, và chủ đề thuộc đúng môn. Trả về tên để lưu denormalize. */
function resolveCatalog(input, cat) {
  const ok = (x) => x && x.status === 'ACTIVE';
  const s = cat.subjects[input.subjectId], g = cat.grades[input.gradeId], ty = cat.resourceTypes[input.resourceTypeId];
  if (!ok(s)) throw bad('INVALID_SUBJECT', 'Môn học không hợp lệ');
  if (!ok(g)) throw bad('INVALID_GRADE', 'Khối lớp không hợp lệ');
  if (!ok(ty)) throw bad('INVALID_RESOURCE_TYPE', 'Loại tài liệu không hợp lệ');
  let t = null;
  if (input.topicId) {
    t = cat.topics[input.topicId];
    if (!ok(t)) throw bad('INVALID_TOPIC', 'Chủ đề không hợp lệ');
    if (t.subjectId !== input.subjectId) throw bad('TOPIC_SUBJECT_MISMATCH', 'Chủ đề không thuộc môn học đã chọn');
  }
  return { subjectName: s.name, gradeName: g.name, topicName: t ? t.name : null, resourceTypeName: ty.name, resourceTypeCode: ty.code };
}
/** Trường dẫn xuất phục vụ tìm kiếm: phải gọi lại mỗi khi tiêu đề/mô tả/tên danh mục đổi. */
const derive = (r) => ({
  titleNorm: normalize(r.title),
  searchText: normalize([r.title, r.authorName, r.subjectName, r.gradeName, r.topicName, r.resourceTypeName, (r.description || '').slice(0, 500)].filter(Boolean).join(' ')),
});

/** Chuyển trạng thái hợp lệ. APPROVED/REJECTED chỉ đi qua kiểm duyệt. */
const ALLOWED_TRANSITIONS = {
  DRAFT: ['PENDING_REVIEW', 'PUBLISHED'], PENDING_REVIEW: ['DRAFT', 'APPROVED', 'REJECTED'],
  APPROVED: ['PUBLISHED', 'HIDDEN'], REJECTED: ['DRAFT', 'PENDING_REVIEW'],
  PUBLISHED: ['HIDDEN', 'ARCHIVED'], HIDDEN: ['PUBLISHED', 'ARCHIVED'], ARCHIVED: ['HIDDEN'],
};

/* ---------- Tìm kiếm (từ khóa + metadata, KHÔNG dùng AI) ---------- */
function keywordScore(r, tokens, qn) {
  if (!tokens.length) return 0;
  let s = 0, hit = 0;
  for (const t of tokens) {
    if (r.titleNorm.includes(t)) { s += 1; hit++; } else if (r.searchText.includes(t)) { s += 0.5; hit++; }
  }
  if (hit < Math.ceil(tokens.length / 2)) return 0; // phải khớp tối thiểu nửa số từ khóa
  let k = s / tokens.length;
  if (qn && r.titleNorm.includes(qn)) k = Math.min(1, k + 0.2);
  return k;
}
/**
 * Lọc + xếp hạng. score = 0.75·từ khóa + 0.15·phổ biến + 0.10·độ mới (độ phổ biến không lấn át độ liên quan).
 * filters: subjectId, gradeId, topicId, resourceTypeId, author. sort: relevance | newest | popular | title.
 */
function rankSearch(items, { q, filters = {}, sort, now = Date.now() } = {}) {
  const tokens = q ? tokenize(q) : [], qn = q ? normalize(q) : '';
  const author = filters.author ? normalize(filters.author) : '';
  const rows = [];
  for (const r of items) {
    if (filters.subjectId && r.subjectId !== filters.subjectId) continue;
    if (filters.gradeId && r.gradeId !== filters.gradeId) continue;
    if (filters.topicId && r.topicId !== filters.topicId) continue;
    if (filters.resourceTypeId && r.resourceTypeId !== filters.resourceTypeId) continue;
    if (author && !normalize(r.authorName).includes(author)) continue;
    let kw = 0;
    if (tokens.length) { kw = keywordScore(r, tokens, qn); if (!kw) continue; }
    rows.push({ r, score: 0.75 * kw + 0.15 * popularity(r) + 0.1 * freshness(r, now) });
  }
  const s = sort || (tokens.length ? 'relevance' : 'newest');
  const cmp = {
    relevance: (a, b) => b.score - a.score || millis(b.r.publishedAt) - millis(a.r.publishedAt),
    newest: (a, b) => millis(b.r.publishedAt) - millis(a.r.publishedAt),
    popular: (a, b) => (b.r.viewCount || 0) - (a.r.viewCount || 0),
    title: (a, b) => a.r.title.localeCompare(b.r.title, 'vi'),
  }[s];
  if (!cmp) throw bad('INVALID_SORT', 'sort không hợp lệ');
  return rows.sort(cmp).map((x) => ({ ...x.r, _score: Math.round(x.score * 1000) / 1000 }));
}

/**
 * Gợi ý theo hành vi: score = .25 khối + .22 môn hay xem + .18 chủ đề hay xem + .10 liên quan bookmark + .15 phổ biến + .10 mới.
 * Chưa có lịch sử => affinity = 0 => tự rơi về "khối + phổ biến + mới".
 */
function recommend(items, { gradeId, views = [], bookmarks = [], seen = new Set(), now = Date.now() }) {
  const count = (arr, k) => arr.reduce((m, x) => (x[k] ? m.set(x[k], (m.get(x[k]) || 0) + 1) : m), new Map());
  const subj = count(views, 'subjectId'), top = count(views, 'topicId');
  const aff = (m, id) => (id && m.size ? (m.get(id) || 0) / Math.max(...m.values()) : 0);
  const bmSub = new Set(bookmarks.map((b) => b.subjectId)), bmTop = new Set(bookmarks.map((b) => b.topicId).filter(Boolean));
  const personalized = views.length + bookmarks.length > 0;
  const list = items.map((r) => {
    const grade = gradeId && r.gradeId === gradeId ? 1 : 0, sA = aff(subj, r.subjectId), tA = aff(top, r.topicId);
    const bA = (bmSub.has(r.subjectId) ? 0.5 : 0) + (r.topicId && bmTop.has(r.topicId) ? 0.5 : 0);
    let score = 0.25 * grade + 0.22 * sA + 0.18 * tA + 0.1 * bA + 0.15 * popularity(r) + 0.1 * freshness(r, now);
    if (seen.has(r.id)) score *= 0.6;
    const reason = tA > 0 ? 'Cùng chủ đề bạn quan tâm' : sA > 0 ? `Bạn thường xem môn ${r.subjectName}` : bA > 0 ? 'Giống học liệu bạn đã lưu'
      : grade ? `Phù hợp với khối ${r.gradeName}` : popularity(r) > freshness(r, now) ? 'Được nhiều bạn xem' : 'Mới cập nhật';
    return { ...r, _score: Math.round(score * 1000) / 1000, _reason: reason };
  }).sort((a, b) => b._score - a._score);
  return { list, personalized };
}

/* ---------- Kiểm tra file tải lên ---------- */
const ole = (b) => b.subarray(0, 4).toString('hex') === 'd0cf11e0';
const zip = (b) => b.subarray(0, 2).toString() === 'PK';
const OOXML = 'application/vnd.openxmlformats-officedocument';
const FILE_RULES = {
  pdf: { mimes: ['application/pdf'], maxMb: 50, magic: (b) => b.subarray(0, 4).toString() === '%PDF' },
  doc: { mimes: ['application/msword'], maxMb: 50, magic: ole },
  docx: { mimes: [`${OOXML}.wordprocessingml.document`], maxMb: 50, magic: zip },
  ppt: { mimes: ['application/vnd.ms-powerpoint'], maxMb: 50, magic: ole },
  pptx: { mimes: [`${OOXML}.presentationml.presentation`], maxMb: 50, magic: zip },
  mp4: { mimes: ['video/mp4'], maxMb: 100, magic: (b) => b.subarray(4, 8).toString() === 'ftyp' },
  mp3: { mimes: ['audio/mpeg'], maxMb: 30, magic: (b) => b.subarray(0, 3).toString() === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) },
  jpg: { mimes: ['image/jpeg'], maxMb: 10, magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  jpeg: { mimes: ['image/jpeg'], maxMb: 10, magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  png: { mimes: ['image/png'], maxMb: 10, magic: (b) => b.subarray(1, 4).toString() === 'PNG' },
};
/** Kiểm tra đuôi + MIME + dung lượng + magic bytes. Trả về đuôi file hợp lệ. */
function validateFileMeta({ name, mime, size, head }) {
  const ext = String(name).split('.').pop().toLowerCase();
  const rule = FILE_RULES[ext];
  if (!rule || !String(name).includes('.')) throw bad('FILE_TYPE_NOT_ALLOWED', `Không hỗ trợ định dạng .${ext}`);
  if (!rule.mimes.includes(mime)) throw bad('FILE_MIME_MISMATCH', 'MIME type không khớp với đuôi file');
  if (!(size > 0) || size > rule.maxMb * 1048576) throw bad('FILE_TOO_LARGE', `File .${ext} tối đa ${rule.maxMb}MB`);
  if (!rule.magic(head)) throw bad('FILE_CONTENT_INVALID', 'Nội dung file không đúng định dạng khai báo');
  return ext;
}

/* ---------- Nội dung trang chủ (tab Giới thiệu / Hướng dẫn) do admin quản trị ---------- */
const GUIDE_TARGETS = ['home', 'search', 'library', 'loans', 'account'];
const stripTags = (v) => String(v ?? '').replace(/<[^>]*>/g, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
function txt(v, name, { max, required = false } = {}) {
  if (v !== undefined && v !== null && typeof v !== 'string') throw bad('VALIDATION_ERROR', `${name} phải là chuỗi`);
  const c = stripTags(v);
  if (required && !c) throw bad('VALIDATION_ERROR', `${name} là bắt buộc`);
  if (c.length > max) throw bad('VALIDATION_ERROR', `${name} tối đa ${max} ký tự`);
  return c;
}
function lines(v, name, { maxItems, maxLen }) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw bad('VALIDATION_ERROR', `${name} phải là danh sách`);
  const out = v.map((x) => txt(x, name, { max: maxLen })).filter(Boolean);
  if (out.length > maxItems) throw bad('VALIDATION_ERROR', `${name} tối đa ${maxItems} dòng`);
  return out;
}
/** Kiểm tra + làm sạch nội dung do admin gửi. Trả về { introduction, guide } đã chuẩn hóa (chỉ giữ trường hợp lệ). */
function normalizeHomeContent(input) {
  const i = (input && input.introduction) || {}, g = input && input.guide;
  if (typeof i !== 'object' || Array.isArray(i)) throw bad('VALIDATION_ERROR', 'Phần giới thiệu không hợp lệ');
  const email = txt(i.email, 'Email', { max: 120 }), phone = txt(i.phone, 'Số điện thoại', { max: 30 });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw bad('VALIDATION_ERROR', 'Email liên hệ không hợp lệ');
  if (phone && !/^[0-9+().\-\s]{6,30}$/.test(phone)) throw bad('VALIDATION_ERROR', 'Số điện thoại liên hệ không hợp lệ');
  const introduction = {
    school: txt(i.school, 'Tên trường / thư viện', { max: 120, required: true }), tagline: txt(i.tagline, 'Khẩu hiệu', { max: 160 }),
    about: txt(i.about, 'Giới thiệu chung', { max: 2000 }), hours: lines(i.hours, 'Giờ mở cửa', { maxItems: 10, maxLen: 120 }),
    address: txt(i.address, 'Địa chỉ', { max: 250 }), phone, email, rules: lines(i.rules, 'Nội quy', { maxItems: 20, maxLen: 300 }),
  };
  if (!Array.isArray(g)) throw bad('VALIDATION_ERROR', 'Phần hướng dẫn phải là danh sách mục');
  if (g.length > 20) throw bad('VALIDATION_ERROR', 'Tối đa 20 mục hướng dẫn');
  const guide = g.map((x, k) => {
    if (!x || typeof x !== 'object') throw bad('VALIDATION_ERROR', `Mục hướng dẫn #${k + 1} không hợp lệ`);
    const go = x.go ? String(x.go) : '';
    if (go && !GUIDE_TARGETS.includes(go)) throw bad('VALIDATION_ERROR', `Mục hướng dẫn #${k + 1}: màn hình đích không hợp lệ`);
    const item = { title: txt(x.title, `Tiêu đề mục #${k + 1}`, { max: 120, required: true }), body: txt(x.body, `Nội dung mục #${k + 1}`, { max: 1500, required: true }) };
    if (go) { item.go = go; item.cta = txt(x.cta, `Nhãn nút mục #${k + 1}`, { max: 40 }) || 'Mở'; }
    return item;
  });
  return { introduction, guide };
}

/* ---------- Yêu cầu bổ sung học liệu (từ Trợ lý AI khi tìm không thấy) ---------- */
const REQUEST_STATUS = ['NEW', 'DONE', 'REJECTED'];
/** Làm sạch + kiểm tra yêu cầu. Trả về { text, subjectId, gradeId, resourceTypeId } (id rỗng = null). */
function normalizeRequest(input = {}) {
  const text = txt(input.text, 'Nội dung yêu cầu', { max: 300, required: true });
  if (text.length < 5) throw bad('VALIDATION_ERROR', 'Hãy mô tả học liệu cần tìm (tối thiểu 5 ký tự)');
  const id = (v, name) => { const s = txt(v, name, { max: 100 }); return s || null; };
  return { text, subjectId: id(input.subjectId, 'Môn học'), gradeId: id(input.gradeId, 'Khối lớp'), resourceTypeId: id(input.resourceTypeId, 'Loại tài liệu') };
}

module.exports = {
  AppError, bad, normalize, slugify, tokenize, dayKey, daysBetween, resolveRange, millis, popularity, freshness,
  resolveCatalog, derive, ALLOWED_TRANSITIONS, keywordScore, rankSearch, recommend, FILE_RULES, validateFileMeta, normalizeHomeContent, GUIDE_TARGETS,
  REQUEST_STATUS, normalizeRequest,
};
