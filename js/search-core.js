/**
 * THUẬT TOÁN TÌM KIẾM DÙNG CHUNG (ESM) cho frontend.
 *
 * Đây là bản sao 1-1 phần tìm kiếm của `functions/src/lib/pure.js` (server). Dùng ở:
 *   - mock-api.js  → chế độ demo chạy ĐÚNG thuật toán như Firebase thật
 *   - ai-engine.js → Trợ lý AI chuẩn hóa từ khóa & đánh giá độ khớp cùng quy tắc
 * Nếu sửa thuật toán ở pure.js thì PHẢI sửa file này (tests/ai-search.test.mjs đối chiếu hai bên).
 */
const bad = (code, message) => Object.assign(new Error(message), { code, message });

/* ---------- Chuẩn hóa / token ---------- */
export const normalize = (s = '') => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/đ/g, 'd').replace(/\s+/g, ' ').trim();
export const STOP = new Set('em toi minh can muon tim kiem tai lieu de hieu ve cho lop khoi mon hoc cua va la nhung cac mot nao co the giup xin hay'.split(' '));
export const tokenize = (q) => [...new Set(normalize(q).replace(/[^a-z0-9+# ]/g, ' ').split(' ')
  .filter((t) => t.length >= 2 && !STOP.has(t)))].slice(0, 10);

/* ---------- Mô hình học liệu ---------- */
export const millis = (v) => (!v ? Date.now() : v.toMillis ? v.toMillis() : v instanceof Date ? +v : typeof v === 'string' ? Date.parse(v) : +v);
export const popularity = (r) => Math.min(1, Math.log(1 + (r.viewCount || 0) + 3 * (r.downloadCount || 0) + 5 * (r.favoriteCount || 0)) / Math.log(1001));
export const freshness = (r, now = Date.now()) => Math.exp(-((now - millis(r.publishedAt || r.createdAt)) / 864e5) / 180);

/** Trường dẫn xuất phục vụ tìm kiếm (giống `derive` ở server). */
export const derive = (r) => ({
  titleNorm: normalize(r.title),
  searchText: normalize([r.title, r.authorName, r.subjectName, r.gradeName, r.topicName, r.resourceTypeName, (r.description || '').slice(0, 500)].filter(Boolean).join(' ')),
});

/* ---------- Tìm kiếm (từ khóa + metadata) ---------- */
export function keywordScore(r, tokens, qn) {
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
/** score = 0.75·từ khóa + 0.15·phổ biến + 0.10·độ mới. filters: subjectId, gradeId, topicId, resourceTypeId, author. */
export function rankSearch(items, { q, filters = {}, sort, now = Date.now() } = {}) {
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
 * Đánh giá độ tin cậy của kết quả (dùng cho Trợ lý AI), dựa trên chính quy tắc của rankSearch:
 *  - none: không có kết quả
 *  - ok:   học liệu đầu bảng chứa đủ mọi từ khóa (hoặc chỉ lọc theo môn/khối/loại, không có từ khóa)
 *  - weak: có kết quả nhưng chỉ khớp một phần từ khóa (rankSearch cho phép khớp ≥ nửa số từ)
 * `items` là học liệu dạng API trả về ({title, author, subject:{name}, ...}) hoặc dạng thô ({authorName, subjectName, ...}).
 */
export function assessMatch(tokens, items) {
  if (!items || !items.length) return { level: 'none', coverage: 0, missing: [] };
  if (!tokens.length) return { level: 'ok', coverage: 1, missing: [] };
  const hay = (r) => normalize([r.title, r.author || r.authorName, r.subject?.name ?? r.subjectName, r.grade?.name ?? r.gradeName,
    r.topic?.name ?? r.topicName, r.resourceType?.name ?? r.resourceTypeName, r.summary || r.description].filter(Boolean).join(' '));
  let best = 0;
  const seen = items.slice(0, 5).map(hay);
  for (const h of seen.slice(0, 3)) best = Math.max(best, tokens.filter((t) => h.includes(t)).length);
  const missing = tokens.filter((t) => !seen.some((h) => h.includes(t))); // từ khóa không thấy ở kết quả nào
  // API chỉ trả mô tả cắt ngắn; thuật toán đã đảm bảo ≥ nửa số từ khóa khớp nên lấy mức tối thiểu đó làm sàn.
  const hits = Math.max(best, Math.ceil(tokens.length / 2));
  return { level: hits >= tokens.length ? 'ok' : 'weak', coverage: Math.round((hits / tokens.length) * 100) / 100, missing: hits >= tokens.length ? [] : missing };
}
