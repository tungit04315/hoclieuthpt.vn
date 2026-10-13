/**
 * CHẾ ĐỘ DEMO – chạy thẳng trên trình duyệt, KHÔNG cần Firebase, Node, Java hay Emulator.
 * Cùng giao diện (Api.*) với firebase-api.js nên app.js dùng được cả hai.
 * Dữ liệu giả; tủ sách, lịch sử, lượt xem được lưu trong localStorage của trình duyệt.
 *
 * Tài khoản demo:
 *   Học sinh : HS0002  /  Student@12345
 *   Giáo viên: gv01@thuvien.vn  /  Teacher@12345
 *   Quản trị : admin@thuvien.vn /  Admin@12345
 */

import { derive, rankSearch } from './search-core.js'; // cùng thuật toán với functions/src/lib/pure.js

/* ---------- Lưu trữ (an toàn khi localStorage bị chặn) ---------- */
const mem = {};
const store = {
  get(k, d) { try { const v = localStorage.getItem('demo:' + k); return v == null ? d : JSON.parse(v); } catch { return k in mem ? mem[k] : d; } },
  set(k, v) { try { localStorage.setItem('demo:' + k, JSON.stringify(v)); } catch { mem[k] = v; } },
  del(k) { try { localStorage.removeItem('demo:' + k); } catch { delete mem[k]; } },
};
const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const err = (code, message) => Object.assign(new Error(message), { code, message });
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* ---------- Danh mục ---------- */
const SUBJECTS = ['Toán', 'Vật lý', 'Hóa học', 'Sinh học', 'Tin học', 'Ngữ văn', 'Tiếng Anh'].map((name) => ({ id: slug(name), name, status: 'ACTIVE' }));
const GRADES = ['10', '11', '12'].map((name) => ({ id: name, name, status: 'ACTIVE' }));
const TYPES = [['VIDEO', 'Video bài giảng'], ['EXERCISE', 'Bài tập'], ['EXAM', 'Đề thi'], ['SUMMARY', 'Tài liệu tóm tắt'], ['DOCUMENT', 'Tài liệu học tập']]
  .map(([code, name]) => ({ id: code.toLowerCase(), code, name, status: 'ACTIVE' }));
const CATALOG = { subjects: SUBJECTS, grades: GRADES, resourceTypes: TYPES, topics: [] };
const byId = (list, id) => list.find((x) => x.id === id);

/* ---------- Học liệu mẫu ---------- */
const day = 86400000, NOW = Date.now();
// [tiêu đề, môn, khối, loại, tác giả, mô tả, lượt xem, số ngày trước, thời lượng(giây)|null, chủ đề]
const RAW = [
  ['Bài giảng Vòng lặp for và while', 'Tin học', '10', 'VIDEO', 'Thầy Minh Quân', 'Giải thích vòng lặp for, while kèm ví dụ minh họa bằng Python từng bước.', 3420, 2, 1260, 'Vòng lặp'],
  ['Biến và kiểu dữ liệu trong Python', 'Tin học', '10', 'DOCUMENT', 'Cô Thu Hà', 'Tài liệu tổng hợp các kiểu dữ liệu cơ bản, cách khai báo và chuyển đổi kiểu.', 1980, 6, null, 'Biến và kiểu dữ liệu'],
  ['Hàm số bậc hai và đồ thị parabol', 'Toán', '10', 'VIDEO', 'Cô Lan Anh', 'Cách khảo sát và vẽ đồ thị hàm số bậc hai, xác định đỉnh và trục đối xứng.', 5120, 1, 1800, 'Hàm số và đồ thị'],
  ['Bài tập trắc nghiệm Đạo hàm', 'Toán', '11', 'EXERCISE', 'Thầy Văn Hải', '60 câu trắc nghiệm đạo hàm có đáp án và hướng dẫn giải chi tiết.', 2750, 9, null, null],
  ['Đề thi thử THPT Quốc gia môn Toán', 'Toán', '12', 'EXAM', 'Tổ Toán', 'Đề thi thử theo cấu trúc mới nhất của Bộ GD&ĐT, kèm đáp án.', 8900, 3, null, null],
  ['Dao động điều hòa – Tóm tắt lý thuyết', 'Vật lý', '11', 'SUMMARY', 'Thầy Đức Anh', 'Sơ đồ tư duy và công thức quan trọng của chương Dao động cơ.', 2210, 14, null, 'Dao động & Sóng điện từ'],
  ['Thí nghiệm sóng điện từ', 'Vật lý', '12', 'VIDEO', 'Thầy Đức Anh', 'Video mô phỏng thí nghiệm về sóng điện từ và ứng dụng trong đời sống.', 1630, 20, 960, 'Dao động & Sóng điện từ'],
  ['Cân bằng phương trình hóa học', 'Hóa học', '10', 'EXERCISE', 'Cô Mai Phương', 'Bài tập cân bằng phương trình theo phương pháp đại số và electron.', 1450, 12, null, null],
  ['Di truyền học Mendel', 'Sinh học', '12', 'DOCUMENT', 'Cô Bích Ngọc', 'Các quy luật di truyền của Mendel với bài tập vận dụng.', 1120, 25, null, null],
  ['Phân tích tác phẩm Chí Phèo', 'Ngữ văn', '11', 'DOCUMENT', 'Cô Hồng Nhung', 'Dàn ý và phân tích nhân vật, giá trị hiện thực và nhân đạo của tác phẩm.', 3340, 5, null, null],
  ['Ôn thi Tiếng Anh – Thì của động từ', 'Tiếng Anh', '12', 'SUMMARY', 'Cô Kim Ngân', 'Tổng hợp 12 thì trong tiếng Anh kèm bài tập có đáp án.', 2670, 8, null, 'Ôn thi'],
  ['Bài giảng Phản ứng oxi hóa – khử', 'Hóa học', '11', 'VIDEO', 'Cô Mai Phương', 'Khái niệm số oxi hóa, chất khử, chất oxi hóa và cách lập phương trình.', 2980, 4, 1500, null],
];
const RES = RAW.map(([title, sub, grade, type, author, desc, views, ago, dur, topic], i) => {
  const s = byId(SUBJECTS, slug(sub)), t = byId(TYPES, type.toLowerCase());
  const isVideo = type === 'VIDEO';
  return {
    id: slug(title) + '-' + (i + 1), title, description: desc, authorName: author,
    subjectId: s.id, subjectName: s.name, gradeId: grade, gradeName: grade,
    topicId: topic ? slug(sub) + '-' + slug(topic) : null, topicName: topic,
    resourceTypeId: t.id, resourceTypeName: t.name, resourceTypeCode: t.code,
    format: isVideo ? 'MP4' : 'PDF', durationSeconds: dur, viewCount: views, downloadCount: Math.round(views / 6), favoriteCount: Math.round(views / 40),
    publishedAt: new Date(NOW - ago * day).toISOString(), status: 'PUBLISHED', onlineUrl: null,
    files: [{ id: 'f' + (i + 1), name: slug(title) + (isVideo ? '.mp4' : '.pdf'), format: isVideo ? 'MP4' : 'PDF', size: 1048576 * (isVideo ? 38 : 2) }],
  };
});
const PENDING = [
  { id: 'cho-duyet-1', title: 'Đề cương ôn tập Toán 11 (chờ duyệt)', author: 'Cô Lan Anh', subject: 'Toán', grade: '11', fileCount: 1 },
  { id: 'cho-duyet-2', title: 'Slide bài giảng Hóa hữu cơ (chờ duyệt)', author: 'Cô Mai Phương', subject: 'Hóa học', grade: '11', fileCount: 2 },
];

/* ---------- Tài khoản demo ---------- */
const ACCOUNTS = [
  { keys: ['hs0002', 'student01@thuvien.vn', 'hs0002@hs.thuvien.vn'], pw: 'Student@12345', u: { id: 'u-hs0002', email: 'student01@thuvien.vn', fullName: 'Nguyễn Như Ý', role: 'STUDENT', studentCode: 'HS0002', school: 'THPT Demo', gradeId: '10', gradeName: '10', className: '10A1' } },
  { keys: ['hs0001', 'hs0001@hs.thuvien.vn'], pw: 'Student@12345', u: { id: 'u-hs0001', email: 'hs0001@hs.thuvien.vn', fullName: 'Trần Minh Khang', role: 'STUDENT', studentCode: 'HS0001', school: 'THPT Demo', gradeId: '11', gradeName: '11', className: '11A2' } },
  { keys: ['gv01@thuvien.vn'], pw: 'Teacher@12345', u: { id: 'u-gv01', email: 'gv01@thuvien.vn', fullName: 'Lê Thu Hà', role: 'TEACHER' } },
  { keys: ['admin@thuvien.vn'], pw: 'Admin@12345', u: { id: 'u-admin', email: 'admin@thuvien.vn', fullName: 'Quản trị viên', role: 'ADMIN' } },
];
/* Chuẩn hóa định danh: email -> chữ thường; SĐT (+84/84/0…) -> 0xxxxxxxxx */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, PHONE_RE = /^(0|\+?84)(3|5|7|8|9)\d{8}$/;
const normPhone = (v) => { const d = String(v).replace(/[\s.-]/g, ''); return PHONE_RE.test(d) ? '0' + d.replace(/^(0|\+?84)/, '') : null; };
const normId = (v) => { const t = String(v || '').trim(); return normPhone(t) || t.toLowerCase(); };
const registered = () => store.get('accounts', []);
const sessionUser = () => store.get('session', null);
const need = () => { const u = sessionUser(); if (!u) throw err('UNAUTHENTICATED', 'Vui lòng đăng nhập'); return u; };
const mine = (k) => store.get(`${need().id}:${k}`, k === 'notes' ? undefined : []);
const setMine = (k, v) => store.set(`${need().id}:${k}`, v);

/* ---------- Chuyển đổi dữ liệu giống backend (toItem) ---------- */
const logA = (action) => store.set('audit', [{ at: new Date().toISOString(), actor: (store.get('session', null) || {}).fullName || '—', action }, ...store.get('audit', [])].slice(0, 60));
const hiddenIds = () => store.get('hidden', []);
const deletedIds = () => store.get('deletedRes', []); // tài liệu mẫu đã bị admin xóa
const allUsers = () => [...ACCOUNTS, ...registered()].map((a) => { const m = store.get('userMeta:' + a.u.id, {}); return { ...a.u, ...store.get('profile:' + a.u.id, {}), role: m.role || a.u.role, status: m.status || 'ACTIVE' }; });
const catAll = (name) => {
  const base = { subjects: SUBJECTS, grades: GRADES, resourceTypes: TYPES }[name]; if (!base) return [];
  const meta = store.get('catMeta', {}); return [...base, ...store.get('catExtra:' + name, [])].map((x) => ({ ...x, status: meta[name + ':' + x.id] || 'ACTIVE' }));
};
const adm = () => { const u = need(); if (u.role !== 'ADMIN') throw err('FORBIDDEN', 'Chỉ quản trị viên được dùng chức năng này'); return u; };
const tdocs = () => store.get('tdocs', []);
const setTdoc = (id, patch) => { const l = tdocs(); if (!l.some((d) => d.id === id)) return false; store.set('tdocs', l.map((d) => (d.id === id ? { ...d, ...patch } : d))); return true; };
const tToRes = (d) => {
  const s = SUBJECTS.find((x) => x.name === d.subject) || SUBJECTS[0], t = TYPES.find((x) => x.code === d.type) || TYPES[4];
  return { id: d.id, title: d.title, description: d.description || '', authorName: d.author, subjectId: s.id, subjectName: s.name, gradeId: d.grade, gradeName: d.grade,
    topicId: d.topic ? s.id + '-' + slug(d.topic) : null, topicName: d.topic || null, resourceTypeId: t.id, resourceTypeName: t.name, resourceTypeCode: t.code, format: 'LINK',
    durationSeconds: null, viewCount: 0, downloadCount: 0, favoriteCount: 0, publishedAt: d.publishedAt, status: 'PUBLISHED', onlineUrl: d.url, files: [] };
};
const published = () => [...RES.filter((r) => !deletedIds().includes(r.id)), ...tdocs().filter((d) => d.status === 'PUBLISHED').map(tToRes)].filter((r) => r.status === 'PUBLISHED').filter((r) => !hiddenIds().includes(r.id)).map((r) => ({ ...r, viewCount: r.viewCount + (store.get('extraViews:' + r.id, 0)) }));
const favSet = () => new Set(mine('bookmarks'));
const toItem = (r) => ({
  id: r.id, title: r.title, thumbnailUrl: null, summary: String(r.description).slice(0, 160), author: r.authorName,
  subject: { id: r.subjectId, name: r.subjectName }, grade: { id: r.gradeId, name: r.gradeName },
  topic: r.topicId ? { id: r.topicId, name: r.topicName } : null,
  resourceType: { id: r.resourceTypeId, name: r.resourceTypeName, code: r.resourceTypeCode },
  fileFormat: r.format, durationSeconds: r.durationSeconds, viewCount: r.viewCount, downloadCount: r.downloadCount, favoriteCount: r.favoriteCount,
  isFavorite: favSet().has(r.id), publishedAt: r.publishedAt,
});
const GUIDE_TARGETS = ['home', 'search', 'library', 'loans', 'account'];
const homeContent = () => ({ introduction: SCHOOL, guide: GUIDE, ...store.get('homeContent', {}) });
/** Kiểm tra + làm sạch nội dung trang chủ (cùng quy tắc với functions/src/lib/pure.js → normalizeHomeContent). */
function normalizeHomeContent(input) {
  const strip = (v) => String(v ?? '').replace(/<[^>]*>/g, '').trim();
  const txt = (v, name, max, required) => { const c = strip(v); if (required && !c) throw err('VALIDATION_ERROR', `${name} là bắt buộc`); if (c.length > max) throw err('VALIDATION_ERROR', `${name} tối đa ${max} ký tự`); return c; };
  const lines = (v, name, maxItems, maxLen) => { const a = (Array.isArray(v) ? v : []).map((x) => txt(x, name, maxLen)).filter(Boolean); if (a.length > maxItems) throw err('VALIDATION_ERROR', `${name} tối đa ${maxItems} dòng`); return a; };
  const i = (input && input.introduction) || {}, g = input && input.guide;
  const email = txt(i.email, 'Email', 120), phone = txt(i.phone, 'Số điện thoại', 30);
  if (email && !EMAIL_RE.test(email)) throw err('VALIDATION_ERROR', 'Email liên hệ không hợp lệ');
  if (phone && !/^[0-9+().\-\s]{6,30}$/.test(phone)) throw err('VALIDATION_ERROR', 'Số điện thoại liên hệ không hợp lệ');
  const introduction = { school: txt(i.school, 'Tên trường / thư viện', 120, true), tagline: txt(i.tagline, 'Khẩu hiệu', 160), about: txt(i.about, 'Giới thiệu chung', 2000),
    hours: lines(i.hours, 'Giờ mở cửa', 10, 120), address: txt(i.address, 'Địa chỉ', 250), phone, email, rules: lines(i.rules, 'Nội quy', 20, 300) };
  if (!Array.isArray(g)) throw err('VALIDATION_ERROR', 'Phần hướng dẫn phải là danh sách mục');
  if (g.length > 20) throw err('VALIDATION_ERROR', 'Tối đa 20 mục hướng dẫn');
  const guide = g.map((x, k) => {
    if (x.go && !GUIDE_TARGETS.includes(x.go)) throw err('VALIDATION_ERROR', `Mục #${k + 1}: màn hình đích không hợp lệ`);
    const it = { title: txt(x.title, `Tiêu đề mục #${k + 1}`, 120, true), body: txt(x.body, `Nội dung mục #${k + 1}`, 1500, true) };
    if (x.go) { it.go = x.go; it.cta = txt(x.cta, `Nhãn nút mục #${k + 1}`, 40) || 'Mở'; }
    return it;
  });
  return { introduction, guide };
}
const find = (id) => { const r = published().find((x) => x.id === id); if (!r) throw err('RESOURCE_NOT_FOUND', 'Không tìm thấy học liệu'); return r; };
const page = (list, { page: p = 1, limit: l = 20 } = {}) => ({ items: list.slice((p - 1) * l, p * l), pagination: { page: p, limit: l, total: list.length, totalPages: Math.max(1, Math.ceil(list.length / l)) } });

/* ---------- Thông báo mẫu ---------- */
const defaultNotes = () => [
  { id: 'n1', title: 'Chào mừng bạn đến Thư viện số', message: 'Đây là bản chạy thử (demo). Dữ liệu chỉ lưu trên trình duyệt này.', isRead: false, createdAt: new Date(NOW - 3600e3).toISOString() },
  { id: 'n2', title: 'Học liệu mới', message: 'Bài giảng Hàm số bậc hai và đồ thị parabol vừa được cập nhật.', isRead: false, createdAt: new Date(NOW - day).toISOString() },
];
const notes = () => { let n = mine('notes'); if (!n) { n = defaultNotes(); setMine('notes', n); } return n; };

/* ---------- Tệp tải xuống giả (PDF hợp lệ tối giản) ---------- */
function demoPdf(title) {
  const t = norm(title).replace(/[()\\]/g, '');
  const body = `BT /F1 18 Tf 50 750 Td (${t}) Tj 0 -30 Td (Tai lieu demo - Thu vien so THPT) Tj ET`;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n'; const off = [];
  objs.forEach((o, i) => { off.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  return new Blob([out], { type: 'application/pdf' });
}

/* ---------- Nội dung trang chủ (THAY bằng thông tin thật của trường) ---------- */
const SCHOOL = {
  school: 'Thư viện Trường THPT Demo', tagline: 'Tri thức hôm nay – Kiến tạo tương lai',
  about: 'Thư viện là nơi học sinh tìm sách giấy và học liệu số phục vụ học tập, ôn thi và đọc mở rộng. Bạn có thể tra cứu học liệu trực tuyến, mượn sách và quản lý thẻ thư viện ngay trên ứng dụng này.',
  hours: ['Thứ 2 – Thứ 6: 7:00 – 17:00', 'Thứ 7: 7:00 – 11:30', 'Chủ nhật và ngày lễ: nghỉ'],
  address: 'Tầng 1, Nhà A, Trường THPT Demo (địa chỉ mẫu)', phone: '028 1234 5678', email: 'thuvien@thptdemo.edu.vn',
  rules: ['Mang theo thẻ thư viện khi mượn hoặc trả sách.', 'Mỗi bạn mượn tối đa 3 cuốn, thời hạn 14 ngày, gia hạn 1 lần thêm 7 ngày.', 'Giữ trật tự, không ăn uống trong phòng đọc.', 'Làm mất hoặc hư hỏng sách, vui lòng báo ngay cho thủ thư.'],
};
const GUIDE = [
  { title: 'Tìm học liệu', body: 'Chạm thanh tìm kiếm, gõ tên bài, môn học hoặc tác giả (có dấu hay không dấu đều được). Dùng bộ lọc để chọn môn, khối lớp và loại tài liệu.', go: 'search', cta: 'Tìm ngay' },
  { title: 'Xem và tải học liệu', body: 'Mở một học liệu để đọc mô tả, sau đó bấm nút xem. Học liệu có tệp đính kèm có thể tải về; học liệu dạng liên kết sẽ mở trang hoặc video của giáo viên.', go: 'library', cta: 'Mở Học liệu số' },
  { title: 'Lưu học liệu yêu thích', body: 'Chạm biểu tượng dấu trang trên học liệu để lưu. Xem lại trong Học liệu số, tab Yêu thích. Các học liệu bạn đã mở nằm ở tab Đã xem.', go: 'library', cta: 'Xem học liệu đã lưu' },
  { title: 'Mượn sách giấy', body: 'Vào Mượn/Trả, chọn tab Mượn sách, tìm cuốn cần mượn rồi bấm Mượn. Bạn mượn tối đa 3 cuốn cùng lúc, thời hạn 14 ngày.', go: 'loans', cta: 'Mượn sách' },
  { title: 'Gia hạn và trả sách', body: 'Trong tab Đang mượn, bấm Gia hạn để thêm 7 ngày (mỗi cuốn một lần, không áp dụng khi đã quá hạn) hoặc bấm Trả sách khi hoàn trả. Sách quá hạn cần trả trước khi mượn thêm.', go: 'loans', cta: 'Xem sách đang mượn' },
  { title: 'Thẻ thư viện và tài khoản', body: 'Mục Thẻ/Tài khoản hiển thị thẻ thư viện của bạn, nơi sửa thông tin cá nhân, đổi mật khẩu và bật hoặc tắt nhắc hạn trả sách.', go: 'account', cta: 'Mở thẻ của tôi' },
  { title: 'Cần hỗ trợ?', body: 'Liên hệ thủ thư trong giờ mở cửa hoặc qua số điện thoại và email ở tab Giới thiệu.' },
];
/* ---------- Sách giấy (Mượn/Trả) ---------- */
const COLORS = ['#5B4FD8', '#2FA56E', '#FFA447', '#4A7BE8', '#E5484D'];
const BOOKS = [['Dế Mèn phiêu lưu ký', 'Tô Hoài', 'Văn học', 3], ['Tắt đèn', 'Ngô Tất Tố', 'Văn học', 2], ['Số đỏ', 'Vũ Trọng Phụng', 'Văn học', 2],
  ['Lược sử thời gian', 'Stephen Hawking', 'Khoa học', 2], ['Nhà giả kim', 'Paulo Coelho', 'Văn học nước ngoài', 4], ['Sách giáo khoa Toán 10', 'Bộ GD&ĐT', 'Giáo khoa', 5],
  ['Sách giáo khoa Vật lý 11', 'Bộ GD&ĐT', 'Giáo khoa', 5], ['Lập trình Python cơ bản', 'Nguyễn Văn An', 'Tin học', 3], ['Đắc nhân tâm', 'Dale Carnegie', 'Kỹ năng', 3], ['Hóa học vui', 'Lê Thị Mai', 'Khoa học', 1],
].map(([title, author, category, copies], i) => ({ id: 'b' + (i + 1), title, author, category, copies, color: COLORS[i % 5] }));
const borrowedMap = () => store.get('borrowed', {});
const addBorrowed = (id, n) => store.set('borrowed', { ...borrowedMap(), [id]: Math.max(0, (borrowedMap()[id] || 0) + n) });
const loanList = () => mine('loans');
const isOver = (l) => new Date(l.dueDate) < Date.now();

/** Kiểm tra nội dung yêu cầu tài liệu (cùng quy tắc với P.normalizeRequest ở server). */
const reqText = (v) => {
  const t = String(v ?? '').replace(/<[^>]*>/g, '').trim();
  if (t.length < 5) throw err('VALIDATION_ERROR', 'Hãy mô tả học liệu cần tìm (tối thiểu 5 ký tự)');
  if (t.length > 300) throw err('VALIDATION_ERROR', 'Nội dung yêu cầu tối đa 300 ký tự');
  return t;
};
const RLS = ['STUDENT', 'TEACHER', 'ADMIN'];
/* ---------- Api ---------- */
const authListeners = [];
export const Api = {
  async login(identifier, password) {
    await wait(300);
    const id = normId(identifier);
    const acc = ACCOUNTS.find((a) => a.keys.includes(id)) || registered().find((a) => a.keys.includes(id));
    if (!acc || (store.get('pw:' + acc.u.id, acc.pw)) !== password) throw err('INVALID_CREDENTIALS', 'Tài khoản hoặc mật khẩu không đúng');
    const m = store.get('userMeta:' + acc.u.id, {});
    if (m.status === 'LOCKED') throw err('LOCKED', 'Tài khoản đã bị khóa, vui lòng liên hệ quản trị viên');
    const u = { ...acc.u, ...store.get('profile:' + acc.u.id, {}), ...(m.role ? { role: m.role } : {}) };
    store.set('prevLogin:' + u.id, store.get('lastLogin:' + u.id, null)); store.set('lastLogin:' + u.id, new Date().toISOString());
    store.set('session', u);
    return { ...u };
  },
  /** Đăng ký đơn giản: Email hoặc SĐT + mật khẩu. Không OTP, không cần admin duyệt, đăng nhập luôn. */
  async register({ identifier, password } = {}) {
    await wait(300);
    const raw = String(identifier || '').trim();
    const phone = normPhone(raw), email = EMAIL_RE.test(raw) ? raw.toLowerCase() : null;
    if (!phone && !email) throw err('VALIDATION_ERROR', 'Email hoặc số điện thoại không hợp lệ');
    if (String(password || '').length < 6) throw err('VALIDATION_ERROR', 'Mật khẩu phải có ít nhất 6 ký tự');
    const key = phone || email;
    if (ACCOUNTS.some((a) => a.keys.includes(key)) || registered().some((a) => a.keys.includes(key))) {
      throw err('ALREADY_EXISTS', phone ? 'Số điện thoại này đã được đăng ký' : 'Email này đã được đăng ký');
    }
    const u = { id: 'u-' + Date.now().toString(36), email: email, phone: phone, fullName: email ? email.split('@')[0] : phone, role: 'STUDENT', status: 'ACTIVE' };
    store.set('accounts', [...registered(), { keys: [key], pw: password, u }]); // DEMO: mật khẩu lưu thô trong trình duyệt, KHÔNG dùng cho thật
    store.set('session', u);
    return { ...u };
  },
  async logout() { store.del('session'); },
  onAuth(cb) { authListeners.push(cb); setTimeout(() => cb(sessionUser() ? { uid: sessionUser().id } : null), 0); return () => {}; },

  async me() { await wait(); return { ...need() }; },
  async updateProfile(data = {}) {
    await wait(200);
    const cur = need(), p = {};
    for (const k of ['fullName', 'phone', 'email', 'className', 'school']) if (data[k] !== undefined) p[k] = String(data[k]).trim();
    if (p.fullName !== undefined && p.fullName.length < 2) throw err('VALIDATION_ERROR', 'Họ tên phải có ít nhất 2 ký tự');
    if (p.phone && !normPhone(p.phone)) throw err('VALIDATION_ERROR', 'Số điện thoại không hợp lệ');
    if (p.email && !EMAIL_RE.test(p.email)) throw err('VALIDATION_ERROR', 'Email không hợp lệ');
    if (p.phone) p.phone = normPhone(p.phone);
    if (p.email) p.email = p.email.toLowerCase();
    const u = { ...cur, ...p };
    store.set('session', u); store.set('profile:' + cur.id, { ...store.get('profile:' + cur.id, {}), ...p }); if (cur.role === 'ADMIN') logA('Cập nhật thông tin cá nhân quản trị');
    return { ...u };
  },
  async changePassword(oldPw, newPw) {
    await wait(250);
    const u = need(), acc = ACCOUNTS.find((a) => a.u.id === u.id) || registered().find((a) => a.u.id === u.id);
    if (!acc || store.get('pw:' + u.id, acc.pw) !== oldPw) throw err('INVALID_CREDENTIALS', 'Mật khẩu hiện tại không đúng');
    if (String(newPw).length < 6) throw err('VALIDATION_ERROR', 'Mật khẩu mới phải có ít nhất 6 ký tự');
    if (newPw === oldPw) throw err('VALIDATION_ERROR', 'Mật khẩu mới phải khác mật khẩu cũ');
    store.set('pw:' + u.id, newPw); if (u.role === 'ADMIN') logA('Đổi mật khẩu quản trị');
    return { message: 'Đã đổi mật khẩu' };
  },
  async getSettings() { need(); const id = need().id; return { remind: true, notify: true, notifyPending: true, autoQueue: false, ...store.get(id + ':settings', {}), lastLogin: store.get('prevLogin:' + id, null) }; },
  async saveSettings(v) { const s = { ...(await Api.getSettings()), ...v }; setMine('settings', s); return s; },
  async accountStats() {
    need(); const ls = loanList(), cur = ls.filter((l) => l.status === 'BORROWING');
    return { borrowing: cur.length, overdue: cur.filter(isOver).length, totalBorrowed: ls.length, saved: mine('bookmarks').length, viewed: mine('history').length };
  },

  async home() {
    await wait();
    const u = need(), all = published();
    const name = String(u.fullName).trim().split(/\s+/).slice(-2).join(' ');
    const rec = all.filter((r) => !u.gradeId || r.gradeId === u.gradeId).sort((a, b) => b.viewCount - a.viewCount).slice(0, 6);
    return {
      greeting: `Chào ${name} 👋`, subtitle: 'Học tốt hôm nay, vững vàng tương lai!',
      user: { id: u.id, fullName: u.fullName, school: u.school ?? null, className: u.className ?? null, grade: u.gradeId ? { id: u.gradeId, name: u.gradeName } : null, unreadNotifications: notes().filter((n) => !n.isRead).length },
      recommended: rec.map((r) => ({ ...toItem(r), reason: 'Phù hợp với khối lớp của bạn' })),
      popular: [...all].sort((a, b) => b.viewCount - a.viewCount).slice(0, 6).map(toItem),
      latest: [...all].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 6).map(toItem),
      subjects: catAll('subjects').filter((x) => x.status === 'ACTIVE').map(({ id, name }) => ({ id, name })), grades: catAll('grades').filter((x) => x.status === 'ACTIVE').map(({ id, name }) => ({ id, name })),
      introduction: { ...homeContent().introduction, stats: [{ n: BOOKS.length, l: 'Đầu sách' }, { n: all.length, l: 'Học liệu số' }, { n: allUsers().length, l: 'Thành viên' }] }, guide: homeContent().guide,
    };
  },
  async recommendations() { return (await Api.home()).recommended; },

  /** Cùng thuật toán với searchResources ở server: khớp ≥ nửa số từ khóa, điểm = 0.75·từ khóa + 0.15·phổ biến + 0.10·độ mới. */
  async search({ q = '', subjectId, gradeId, topicId, resourceTypeId, author, sort, page: p = 1, limit: l = 20 } = {}) {
    await wait();
    need();
    const rows = rankSearch(published().map((r) => ({ ...r, ...derive(r) })), { q, filters: { subjectId, gradeId, topicId, resourceTypeId, author }, sort });
    return page(rows.map((r) => ({ ...toItem(r), ...(q ? { score: r._score } : {}) })), { page: p, limit: l });
  },

  async resource(id) {
    await wait();
    const r = find(id);
    return { ...toItem(r), description: r.description, onlineUrl: r.onlineUrl, updatedAt: r.publishedAt, files: r.files.map(({ id, name, format, size }) => ({ id, name, format, size })) };
  },
  async view(id) {
    const r = find(id);
    store.set('extraViews:' + id, store.get('extraViews:' + id, 0) + 1);
    const h = mine('history').filter((x) => x.resourceId !== id);
    h.unshift({ id: 'h-' + id, resourceId: id, viewedAt: new Date().toISOString() });
    setMine('history', h.slice(0, 50));
    return { ok: true, title: r.title };
  },
  async download(id, fileId) {
    await wait(300);
    const r = find(id), f = r.files.find((x) => x.id === fileId) || r.files[0];
    const blob = f.format === 'PDF' ? demoPdf(r.title) : new Blob([`Tệp demo: ${r.title}\n(Bản demo không chứa video thật.)`], { type: 'text/plain;charset=utf-8' });
    return { url: URL.createObjectURL(blob), expiresIn: 300, fileName: f.format === 'PDF' ? f.name : f.name.replace(/\.\w+$/, '') + '-demo.txt' };
  },

  async addBookmark(id) { find(id); const b = mine('bookmarks'); if (!b.includes(id)) setMine('bookmarks', [id, ...b]); return { ok: true }; },
  async removeBookmark(id) { setMine('bookmarks', mine('bookmarks').filter((x) => x !== id)); return { ok: true }; },
  async bookmarks({ page: p = 1, limit: l = 20 } = {}) {
    await wait();
    const all = published(), list = mine('bookmarks').map((id) => all.find((r) => r.id === id)).filter(Boolean).map(toItem);
    return page(list, { page: p, limit: l });
  },
  async viewHistory({ page: p = 1, limit: l = 20 } = {}) {
    await wait();
    const all = published();
    const list = mine('history').map((h) => ({ id: h.id, viewedAt: h.viewedAt, resource: all.find((r) => r.id === h.resourceId) })).filter((h) => h.resource).map((h) => ({ ...h, resource: toItem(h.resource) }));
    return page(list, { page: p, limit: l });
  },
  async deleteViewHistory(id) { setMine('history', mine('history').filter((h) => h.id !== id)); },

  async books({ q = '' } = {}) {
    await wait(); need();
    const w = norm(q).split(/\s+/).filter(Boolean), bm = borrowedMap();
    return BOOKS.filter((b) => w.every((x) => norm(b.title + ' ' + b.author + ' ' + b.category).includes(x))).map((b) => ({ ...b, available: b.copies - (bm[b.id] || 0) }));
  },
  async loans() { await wait(80); return [...loanList()].sort((a, b) => b.borrowedAt.localeCompare(a.borrowedAt)); },
  async borrow(bookId) {
    await wait(200);
    const b = BOOKS.find((x) => x.id === bookId), ls = loanList(), cur = ls.filter((l) => l.status === 'BORROWING');
    if (!b) throw err('NOT_FOUND', 'Không tìm thấy sách');
    if (cur.length >= 3) throw err('LIMIT', 'Bạn đã mượn tối đa 3 cuốn');
    if (cur.some(isOver)) throw err('OVERDUE', 'Bạn có sách quá hạn, vui lòng trả trước khi mượn thêm');
    if (cur.some((l) => l.bookId === bookId)) throw err('DUPLICATE', 'Bạn đang mượn cuốn này rồi');
    if ((borrowedMap()[bookId] || 0) >= b.copies) throw err('OUT_OF_STOCK', 'Sách đã hết, vui lòng quay lại sau');
    const due = new Date(NOW + 14 * day).toISOString();
    setMine('loans', [...ls, { id: 'l' + Date.now().toString(36), bookId, title: b.title, author: b.author, category: b.category, color: b.color, borrowedAt: new Date().toISOString(), dueDate: due, renewCount: 0, status: 'BORROWING', returnedAt: null }]);
    addBorrowed(bookId, 1);
    return { message: `Đã mượn "${b.title}". Hạn trả: ${new Date(due).toLocaleDateString('vi-VN')}` };
  },
  async returnBook(loanId) {
    await wait(200);
    const ls = loanList(), l = ls.find((x) => x.id === loanId && x.status === 'BORROWING');
    if (!l) throw err('NOT_FOUND', 'Không tìm thấy lượt mượn');
    setMine('loans', ls.map((x) => (x === l ? { ...x, status: 'RETURNED', returnedAt: new Date().toISOString() } : x)));
    addBorrowed(l.bookId, -1);
    return { message: `Đã trả "${l.title}"` };
  },
  async renew(loanId) {
    await wait(200);
    const ls = loanList(), l = ls.find((x) => x.id === loanId && x.status === 'BORROWING');
    if (!l) throw err('NOT_FOUND', 'Không tìm thấy lượt mượn');
    if (l.renewCount >= 1) throw err('RENEW_LIMIT', 'Mỗi cuốn chỉ được gia hạn 1 lần');
    if (isOver(l)) throw err('OVERDUE', 'Sách đã quá hạn, không thể gia hạn');
    const due = new Date(new Date(l.dueDate).getTime() + 7 * day).toISOString();
    setMine('loans', ls.map((x) => (x === l ? { ...x, dueDate: due, renewCount: 1 } : x)));
    return { message: `Đã gia hạn đến ${new Date(due).toLocaleDateString('vi-VN')}` };
  },

  async catalog(name) { await wait(60); return catAll(name).filter((x) => x.status === 'ACTIVE'); },
  async searchHistory() { return []; },
  async clearSearchHistory() {},
  async notifications(n = 30) { await wait(); return notes().slice(0, n); },
  async unreadCount() { return notes().filter((x) => !x.isRead).length; },
  async markRead(id) { setMine('notes', notes().map((x) => (x.id === id ? { ...x, isRead: true } : x))); },
  async markAllRead() { setMine('notes', notes().map((x) => ({ ...x, isRead: true }))); },

  /** Học sinh/giáo viên gửi yêu cầu bổ sung học liệu khi tìm không thấy. Gửi trùng nội dung đang chờ xử lý → { duplicate: true }. */
  async createRequest(data = {}) {
    await wait(120);
    const u = need(), text = reqText(data.text), list = store.get('requests', []);
    if (list.some((x) => x.userId === u.id && x.status === 'NEW' && norm(x.text) === norm(text))) return { duplicate: true };
    const r = { id: 'rq' + Date.now().toString(36), userId: u.id, userName: u.fullName || u.email || u.id, text,
      subjectId: data.subjectId || null, gradeId: data.gradeId || null, resourceTypeId: data.resourceTypeId || null, status: 'NEW', createdAt: new Date().toISOString() };
    store.set('requests', [r, ...list].slice(0, 200));
    return { id: r.id, status: 'NEW' };
  },

  teacher: {
    _me() { const u = need(); if (u.role !== 'TEACHER') throw err('FORBIDDEN', 'Chỉ giáo viên được dùng chức năng này'); return u; },
    async list() { await wait(80); const u = Api.teacher._me(); return tdocs().filter((d) => d.ownerId === u.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((d) => ({ ...d, views: store.get('extraViews:' + d.id, 0) })); },
    async dashboard() {
      const l = await Api.teacher.list(), n = (st) => l.filter((d) => d.status === st).length;
      return { total: l.length, pending: n('PENDING'), published: n('PUBLISHED'), draft: n('DRAFT'), rejected: n('REJECTED') };
    },
    async save(d = {}) {
      await wait(250); const u = Api.teacher._me(), draft = !!d.draft, v = (k) => String(d[k] ?? '').trim();
      if (v('title').length < 3) throw err('VALIDATION_ERROR', 'Tên tài liệu phải có ít nhất 3 ký tự');
      let url = v('url'); if (url || !draft) { let ok = false; try { ok = /^https?:$/.test(new URL(url).protocol); } catch {} if (!ok) throw err('VALIDATION_ERROR', 'Link không hợp lệ, cần bắt đầu bằng http:// hoặc https://'); }
      if (!draft) for (const [k, n] of [['author', 'tác giả'], ['subject', 'môn học'], ['grade', 'khối lớp'], ['topic', 'chủ đề'], ['type', 'loại tài liệu']]) if (!v(k)) throw err('VALIDATION_ERROR', 'Vui lòng nhập ' + n);
      const now = new Date().toISOString(), old = d.id ? tdocs().find((x) => x.id === d.id && x.ownerId === u.id) : null;
      if (d.id && !old) throw err('NOT_FOUND', 'Không tìm thấy tài liệu');
      if (old && !['DRAFT', 'REJECTED'].includes(old.status)) throw err('LOCKED', old.status === 'PENDING' ? 'Tài liệu đang chờ duyệt, không thể sửa' : 'Tài liệu đã đăng, không thể sửa');
      const doc = { ...(old || {}), id: old ? old.id : 'td-' + Date.now().toString(36), ownerId: u.id, title: v('title'), author: v('author') || u.fullName, subject: v('subject'), grade: v('grade'), topic: v('topic'), type: v('type'), url, description: v('description'), status: draft ? 'DRAFT' : 'PENDING', rejectReason: null, updatedAt: now };
      store.set('tdocs', old ? tdocs().map((x) => (x.id === doc.id ? doc : x)) : [...tdocs(), doc]);
      return { id: doc.id, status: doc.status };
    },
    async remove(id) {
      await wait(150); const u = Api.teacher._me(), d = tdocs().find((x) => x.id === id && x.ownerId === u.id);
      if (!d) throw err('NOT_FOUND', 'Không tìm thấy tài liệu');
      if (d.status === 'PUBLISHED') throw err('LOCKED', 'Tài liệu đã đăng, hãy liên hệ quản trị viên để gỡ');
      store.set('tdocs', tdocs().filter((x) => x.id !== id)); return { ok: true };
    },
    async stats() {
      const l = await Api.teacher.list(), pub = l.filter((d) => d.status === 'PUBLISHED');
      return { ...(await Api.teacher.dashboard()), views: pub.reduce((s, d) => s + d.views, 0), top: [...pub].sort((a, b) => b.views - a.views).slice(0, 5).map((d) => ({ title: d.title, views: d.views })) };
    },
  },
  admin: {
    async dashboard() {
      await wait();
      const pending = store.get('pending', PENDING);
      return { totalResources: published().length, totalStudents: allUsers().filter((u) => u.role === 'STUDENT').length, totalTeachers: allUsers().filter((u) => u.role === 'TEACHER').length, totalAdmins: allUsers().filter((u) => u.role === 'ADMIN').length, pendingResources: pending.length + tdocs().filter((d) => d.status === 'PENDING').length, totalViews: published().reduce((s, r) => s + r.viewCount, 0) };
    },
    async moderationQueue() { await wait(); const q = [...store.get('pending', PENDING), ...tdocs().filter((d) => d.status === 'PENDING').map((d) => ({ id: d.id, title: d.title, author: d.author, subject: d.subject, grade: d.grade, fileCount: 1 }))]; return { items: q, pagination: { page: 1, limit: 20, total: q.length, totalPages: 1 } }; },
    async approve({ id }) { if (setTdoc(id, { status: 'PUBLISHED', publishedAt: new Date().toISOString(), rejectReason: null })) { logA('Duyệt tài liệu ' + id); return { ok: true }; } store.set('pending', store.get('pending', PENDING).filter((x) => x.id !== id)); return { ok: true }; },
    async reject({ id, reason }) {
      if (!reason || reason.length < 5) throw err('VALIDATION_ERROR', 'Lý do từ chối tối thiểu 5 ký tự');
      if (setTdoc(id, { status: 'REJECTED', rejectReason: reason })) { logA('Từ chối tài liệu ' + id + ': ' + reason); return { ok: true }; }
      store.set('pending', store.get('pending', PENDING).filter((x) => x.id !== id)); return { ok: true };
    },
    async users({ q = '', role = '' } = {}) {
      adm(); const w = norm(q);
      return { items: allUsers().filter((u) => (!role || u.role === role) && (!w || norm([u.fullName, u.email, u.phone, u.studentCode, u.className].join(' ')).includes(w))) };
    },
    async createUser({ fullName, identifier, role, password } = {}) {
      await wait(250); adm(); const raw = String(identifier || '').trim(), phone = normPhone(raw), email = EMAIL_RE.test(raw) ? raw.toLowerCase() : null, key = phone || email;
      if (String(fullName || '').trim().length < 2) throw err('VALIDATION_ERROR', 'Họ tên phải có ít nhất 2 ký tự');
      if (!key) throw err('VALIDATION_ERROR', 'Email hoặc số điện thoại không hợp lệ');
      if (!RLS.includes(role)) throw err('VALIDATION_ERROR', 'Vai trò không hợp lệ');
      if (String(password || '').length < 6) throw err('VALIDATION_ERROR', 'Mật khẩu phải có ít nhất 6 ký tự');
      if (allUsers().some((u) => u.email === key || u.phone === key)) throw err('ALREADY_EXISTS', 'Email hoặc số điện thoại đã tồn tại');
      const u = { id: 'u-' + Date.now().toString(36), email, phone, fullName: fullName.trim(), role };
      store.set('accounts', [...registered(), { keys: [key], pw: password, u }]); logA(`Tạo tài khoản ${u.fullName} (${role})`);
      return { message: 'Đã tạo tài khoản ' + u.fullName };
    },
    async setUserStatus(id, status) {
      await wait(150); const me_ = adm(), u = allUsers().find((x) => x.id === id);
      if (!u) throw err('NOT_FOUND', 'Không tìm thấy tài khoản'); if (id === me_.id) throw err('FORBIDDEN', 'Bạn không thể khóa chính mình');
      store.set('userMeta:' + id, { ...store.get('userMeta:' + id, {}), status }); logA(`${status === 'LOCKED' ? 'Khóa' : 'Mở khóa'} tài khoản ${u.fullName}`);
      return { message: status === 'LOCKED' ? 'Đã khóa tài khoản' : 'Đã mở khóa tài khoản' };
    },
    async setUserRole(id, role) {
      await wait(150); const me_ = adm(), u = allUsers().find((x) => x.id === id);
      if (!u) throw err('NOT_FOUND', 'Không tìm thấy tài khoản'); if (id === me_.id) throw err('FORBIDDEN', 'Bạn không thể đổi vai trò của chính mình');
      if (!RLS.includes(role)) throw err('VALIDATION_ERROR', 'Vai trò không hợp lệ');
      store.set('userMeta:' + id, { ...store.get('userMeta:' + id, {}), role }); logA(`Đổi vai trò ${u.fullName} thành ${role}`);
      return { message: 'Đã đổi vai trò' };
    },
    async resetPassword(id) {
      await wait(150); adm(); const u = allUsers().find((x) => x.id === id); if (!u) throw err('NOT_FOUND', 'Không tìm thấy tài khoản');
      const tempPassword = 'Tl' + Math.random().toString(36).slice(2, 8) + '#1'; store.set('pw:' + id, tempPassword); logA('Đặt lại mật khẩu cho ' + u.fullName);
      return { tempPassword };
    },
    async resources({ q = '', status = '' } = {}) {
      adm(); const hid = hiddenIds(), w = norm(q), views = (id) => (RES.find((x) => x.id === id) || { viewCount: 0 }).viewCount + store.get('extraViews:' + id, 0);
      const rows = [...RES.filter((r) => !deletedIds().includes(r.id)).map((r) => ({ id: r.id, title: r.title, subject: r.subjectName, grade: r.gradeName, author: r.authorName, status: hid.includes(r.id) ? 'HIDDEN' : 'PUBLISHED', own: false })),
        ...tdocs().filter((d) => d.status !== 'DRAFT').map((d) => ({ id: d.id, title: d.title, subject: d.subject, grade: d.grade, author: d.author, status: d.status === 'PUBLISHED' && hid.includes(d.id) ? 'HIDDEN' : d.status, own: true }))]
        .filter((r) => (!status || r.status === status) && (!w || norm(r.title + ' ' + r.author + ' ' + r.subject).includes(w)));
      return { items: rows.map((r) => ({ ...r, views: views(r.id) })) };
    },
    async setResourceVisible(id, visible) {
      await wait(100); adm(); if (!RES.some((r) => r.id === id) && !tdocs().some((d) => d.id === id)) throw err('NOT_FOUND', 'Không tìm thấy tài liệu'); const h = hiddenIds().filter((x) => x !== id); store.set('hidden', visible ? h : [...h, id]); logA((visible ? 'Hiện' : 'Ẩn') + ' tài liệu ' + id);
      return { message: visible ? 'Đã hiện tài liệu' : 'Đã ẩn tài liệu khỏi học sinh' };
    },
    async deleteResource(id) {
      await wait(100); adm();
      if (tdocs().some((d) => d.id === id)) { store.set('tdocs', tdocs().filter((d) => d.id !== id)); logA('Xóa tài liệu ' + id); return { message: 'Đã xóa tài liệu' }; }
      if (!RES.some((r) => r.id === id)) throw err('NOT_FOUND', 'Không tìm thấy tài liệu hoặc đã bị xóa trước đó');
      store.set('deletedRes', [...deletedIds().filter((x) => x !== id), id]); store.set('hidden', hiddenIds().filter((x) => x !== id)); logA('Xóa tài liệu ' + id);
      return { message: 'Đã xóa tài liệu' };
    },
    async catalogList(name) { adm(); return { items: catAll(name) }; },
    async catalogAdd(name, label) {
      await wait(100); adm(); const t = String(label || '').trim(); if (t.length < 1 || t.length > 40) throw err('VALIDATION_ERROR', 'Tên danh mục từ 1 đến 40 ký tự');
      if (catAll(name).some((x) => norm(x.name) === norm(t))) throw err('ALREADY_EXISTS', 'Danh mục này đã tồn tại');
      const id = name === 'grades' ? t : slug(t), item = { id, name: t, ...(name === 'resourceTypes' ? { code: id.toUpperCase().replace(/-/g, '_') } : {}) };
      store.set('catExtra:' + name, [...store.get('catExtra:' + name, []), item]); logA(`Thêm danh mục "${t}"`); return { message: 'Đã thêm "' + t + '"' };
    },
    async catalogToggle(name, id) {
      await wait(100); adm(); const k = name + ':' + id, m = store.get('catMeta', {}), off = m[k] !== 'INACTIVE';
      store.set('catMeta', { ...m, [k]: off ? 'INACTIVE' : 'ACTIVE' }); logA((off ? 'Tắt' : 'Bật') + ' danh mục ' + id); return { message: off ? 'Đã tắt, học sinh không còn thấy mục này' : 'Đã bật lại' };
    },
    async homeContent() { adm(); await wait(80); return { ...homeContent(), updatedAt: store.get('homeContentAt', null) }; },
    async saveHomeContent(data) {
      await wait(150); adm(); const next = normalizeHomeContent(data);
      store.set('homeContent', next); store.set('homeContentAt', new Date().toISOString()); logA('Cập nhật nội dung trang chủ (Giới thiệu & Hướng dẫn)');
      return { message: 'Đã lưu nội dung trang chủ', ...next };
    },
    async statistics() {
      adm(); const all = published(), td = tdocs(), by = (k) => Object.entries(all.reduce((m, r) => { const x = (m[r[k]] ||= { count: 0, views: 0 }); x.count++; x.views += r.viewCount; return m; }, {})).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.count - a.count || b.views - a.views);
      const us = allUsers(), n = (r) => us.filter((u) => u.role === r).length;
      return { users: { students: n('STUDENT'), teachers: n('TEACHER'), admins: n('ADMIN'), locked: us.filter((u) => u.status === 'LOCKED').length },
        resources: { published: all.length, hidden: hiddenIds().filter((x) => !deletedIds().includes(x)).length, pending: td.filter((d) => d.status === 'PENDING').length + store.get('pending', PENDING).length, rejected: td.filter((d) => d.status === 'REJECTED').length },
        totalViews: all.reduce((s, r) => s + r.viewCount, 0), bySubject: by('subjectName'), byType: by('resourceTypeName'), top: [...all].sort((a, b) => b.viewCount - a.viewCount).slice(0, 5).map((r) => ({ title: r.title, views: r.viewCount })) };
    },
    async auditLogs() { adm(); return { items: store.get('audit', []) }; },
    async requests({ status, page: p = 1, limit: l = 20 } = {}) {
      await wait(80); adm();
      return page(store.get('requests', []).filter((x) => !status || x.status === status), { page: p, limit: l });
    },
    async updateRequest({ id, status, note } = {}) {
      await wait(100); adm();
      if (!['DONE', 'REJECTED'].includes(status)) throw err('VALIDATION_ERROR', 'status phải là DONE hoặc REJECTED');
      const list = store.get('requests', []), r = list.find((x) => x.id === id);
      if (!r) throw err('REQUEST_NOT_FOUND', 'Không tìm thấy yêu cầu');
      if (r.status !== 'NEW') throw err('REQUEST_ALREADY_HANDLED', 'Yêu cầu này đã được xử lý');
      const n = String(note || '').replace(/<[^>]*>/g, '').trim().slice(0, 300);
      store.set('requests', list.map((x) => (x.id === id ? { ...x, status, note: n, handledAt: new Date().toISOString() } : x)));
      const k = r.userId + ':notes', cur = store.get(k); // báo cho người gửi (giống thông báo ở server)
      store.set(k, [{ id: 'n' + Date.now(), title: status === 'DONE' ? 'Yêu cầu tài liệu đã được xử lý' : 'Yêu cầu tài liệu chưa thể đáp ứng', message: `“${r.text}”${n ? ' — ' + n : ''}`, isRead: false, createdAt: new Date().toISOString() }, ...(cur || defaultNotes())]);
      logA((status === 'DONE' ? 'Đã xử lý' : 'Từ chối') + ' yêu cầu tài liệu của ' + r.userName);
      return { message: 'Đã cập nhật yêu cầu' };
    },
    async notify() { return { ok: true }; },
  },
};
