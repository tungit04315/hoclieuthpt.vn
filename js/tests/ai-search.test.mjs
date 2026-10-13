// Chạy: node tests/ai-search.test.mjs   (không cần Firebase, không cần cài thêm gói)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as core from '../search-core.js';
import { parseIntent, ask, composeText } from '../ai-engine.js';

const require = createRequire(import.meta.url);
const P = require('../functions/src/lib/pure.js'); // thuật toán server
let pass = 0; const t = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('  ✓', name); }, (e) => { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; });

/* ---- Dữ liệu mẫu (cùng mô hình với Firestore `resources`) ---- */
const NOW = Date.now(), day = 864e5;
const mk = (id, title, sub, grade, type, author, desc, views, ago) => ({
  id, title, description: desc, authorName: author, subjectId: sub.toLowerCase().replace(/\s/g, '-'), subjectName: sub, gradeId: grade, gradeName: grade,
  topicId: null, topicName: null, resourceTypeId: type[0], resourceTypeName: type[1], viewCount: views, downloadCount: 0, favoriteCount: 0,
  publishedAt: new Date(NOW - ago * day).toISOString(), status: 'PUBLISHED',
});
const RAW = [
  mk('a', 'Hàm số bậc hai và đồ thị parabol', 'Toán', '10', ['VIDEO', 'Video bài giảng'], 'Nguyễn Văn An', 'Bài giảng hàm số bậc hai', 900, 5),
  mk('b', 'Bài tập bất phương trình bậc nhất hai ẩn', 'Toán', '10', ['EXERCISE', 'Bài tập'], 'Trần Thị Bình', 'Luyện tập bất phương trình', 300, 40),
  mk('c', 'Đề thi giữa kỳ Vật lý 11', 'Vật lý', '11', ['EXAM', 'Đề thi'], 'Lê Văn Cường', 'Đề thi động học', 120, 10),
  mk('d', 'Vòng lặp trong Python', 'Tin học', '10', ['VIDEO', 'Video bài giảng'], 'Phạm Thu Dung', 'Học lập trình Python cơ bản với vòng lặp', 500, 3),
  mk('e', 'Tóm tắt Hóa học 12', 'Hóa học', '12', ['SUMMARY', 'Tài liệu tóm tắt'], 'Võ Minh Em', 'Tóm tắt kiến thức', 50, 90),
];
const items = RAW.map((r) => ({ ...r, ...P.derive(r) })); // `derive` của server
const catalog = {
  subjects: [...new Set(RAW.map((r) => r.subjectName))].map((n) => ({ id: n.toLowerCase().replace(/\s/g, '-'), name: n })),
  grades: ['10', '11', '12'].map((n) => ({ id: n, name: n })),
  resourceTypes: [['VIDEO', 'Video bài giảng'], ['EXERCISE', 'Bài tập'], ['EXAM', 'Đề thi'], ['SUMMARY', 'Tài liệu tóm tắt']].map(([id, name]) => ({ id, name, code: id })),
};
/** Giả lập Api.search: gọi rankSearch của SERVER (pure.js) → chứng minh trợ lý dùng đúng thuật toán dự án. */
const search = async ({ q = '', subjectId, gradeId, topicId, resourceTypeId, author, sort, limit = 20 }) => {
  const rows = P.rankSearch(items, { q, filters: { subjectId, gradeId, topicId, resourceTypeId, author }, sort, now: NOW });
  return { items: rows.slice(0, limit).map((r) => ({ id: r.id, title: r.title, author: r.authorName, subject: { name: r.subjectName }, grade: { name: r.gradeName }, resourceType: { name: r.resourceTypeName }, summary: r.description })), pagination: { total: rows.length } };
};
const run = (q) => ask(q, { search, cat: catalog });

console.log('1) search-core.js ≡ pure.js (cùng thuật toán)');
await t('normalize & tokenize giống nhau', () => {
  for (const s of ['Em cần tài liệu về vòng lặp Python lớp 10', 'ĐỒ THỊ hàm số', 'lập trình java', 'C++ và C# cơ bản', '  ']) {
    assert.equal(core.normalize(s), P.normalize(s)); assert.deepEqual(core.tokenize(s), P.tokenize(s));
  }
});
await t('rankSearch cho thứ tự và điểm giống hệt', () => {
  for (const q of ['ham so', 'bat phuong trinh', 'vong lap python', 'lap trinh java', 'toan', '']) {
    for (const sort of [undefined, 'newest', 'popular', 'title']) {
      const a = core.rankSearch(items, { q, sort, now: NOW }), b = P.rankSearch(items, { q, sort, now: NOW });
      assert.deepEqual(a.map((r) => [r.id, r._score]), b.map((r) => [r.id, r._score]), `q="${q}" sort=${sort}`);
    }
  }
  assert.deepEqual(core.rankSearch(items, { q: 'ham so', filters: { gradeId: '10', subjectId: 'toán'.normalize() }, now: NOW }).map((r) => r.id), P.rankSearch(items, { q: 'ham so', filters: { gradeId: '10', subjectId: 'toán'.normalize() }, now: NOW }).map((r) => r.id));
});

console.log('2) Tách ý định (parseIntent)');
await t('môn + khối + loại → bộ lọc, không lẫn vào từ khóa', () => {
  const i = parseIntent('cho em bài tập Toán lớp 10 về bất phương trình', catalog);
  assert.equal(i.filters.subjectId, 'toán'); assert.equal(i.filters.gradeId, '10'); assert.equal(i.filters.resourceTypeId, 'EXERCISE');
  assert.deepEqual(i.tokens, ['bat', 'phuong', 'trinh']);
});
await t('gõ không dấu + tên môn gọi tắt sau chữ "môn"', () => {
  const i = parseIntent('tim video mon ly khoi 11', catalog);
  assert.equal(i.filters.subjectId, 'vật-lý'); assert.equal(i.filters.gradeId, '11'); assert.equal(i.filters.resourceTypeId, 'VIDEO'); assert.deepEqual(i.tokens, []);
});
await t('"lý"/"hóa" đứng riêng KHÔNG bị hiểu là môn học', () => {
  assert.equal(parseIntent('hoa tuoi cham soc', catalog).filters.subjectId, undefined);
});
await t('sắp xếp & tác giả', () => {
  assert.equal(parseIntent('toán mới nhất', catalog).sort, 'newest');
  assert.equal(parseIntent('video phổ biến', catalog).sort, 'popular');
  assert.equal(parseIntent('tài liệu của thầy Văn An', catalog).author, 'van an');
});
await t('khối không có trong thư viện → báo rõ', () => assert.equal(parseIntent('toán lớp 9', catalog).unsupportedGrade, '9'));
await t('chào hỏi / cảm ơn / liên hệ / hướng dẫn', () => {
  assert.equal(parseIntent('xin chào', catalog).kind, 'greeting'); assert.equal(parseIntent('cảm ơn bạn', catalog).kind, 'thanks');
  assert.equal(parseIntent('thông tin liên hệ thư viện', catalog).kind, 'contact'); assert.equal(parseIntent('bạn làm được gì', catalog).kind, 'help');
  assert.equal(parseIntent('sách quản trị mạng', catalog).kind, 'search'); // không nhầm tên học liệu với "liên hệ quản trị"
});

console.log('3) Trả lời đúng theo thuật toán dự án');
await t('"lập trình java" khi thư viện chỉ có sách Toán → KHÔNG có học liệu (ảnh lỗi trước đây gợi ý nhầm Toán 10)', async () => {
  const mathOnly = async (p) => { const r = await search({ ...p, limit: 1000 }); const m = r.items.filter((x) => x.subject.name === 'Toán'); return { items: m.slice(0, p.limit || 20), pagination: { total: m.length } }; };
  const r = await ask('lập trình java', { search: mathOnly, cat: catalog });
  assert.equal(r.level, 'none'); assert.equal(r.items.length, 0);
  assert.match(composeText(r, catalog), /chưa có học liệu phù hợp/);
});
await t('"lập trình java" khi có sách Python về lập trình → chỉ "gần đúng" (weak), không khẳng định', async () => {
  const r = await run('lập trình java'); assert.equal(r.level, 'weak'); assert.equal(r.items[0].id, 'd');
  assert.match(composeText(r, catalog), /chưa chắc chắn/);
});
await t('khớp đủ từ khóa → ok', async () => {
  const r = await run('vòng lặp python'); assert.equal(r.level, 'ok'); assert.equal(r.items[0].id, 'd');
});
await t('khớp một phần từ khóa → weak', async () => {
  const r = await run('hàm số bậc hai java'); assert.equal(r.level, 'weak'); assert.equal(r.items[0].id, 'a');
  assert.deepEqual(r.missing, ['java']); assert.match(composeText(r, catalog), /chưa thấy từ khóa “java”/);
});
await t('lọc môn/khối/loại → ok, đúng quyền lọc', async () => {
  const r = await run('bài tập toán lớp 10'); assert.equal(r.level, 'ok'); assert.deepEqual(r.items.map((x) => x.id), ['b']);
});
await t('không có đúng bộ lọc → nới lỏng từng bước và báo rõ (weak)', async () => {
  const r = await run('đề thi toán lớp 10'); // chưa có đề thi Toán 10
  assert.equal(r.level, 'weak'); assert.equal(r.reason, 'relaxed'); assert.deepEqual(r.dropped, ['type']); assert.ok(r.items.length > 0);
  assert.match(composeText(r, catalog), /bỏ bớt bộ lọc loại/);
});
await t('chỉ có bộ lọc mà rỗng → none (không trả về cả thư viện)', async () => {
  const r = await ask('video hóa học', { search: async (p) => (p.subjectId || p.resourceTypeId ? { items: [], pagination: { total: 0 } } : search(p)), cat: catalog });
  assert.equal(r.level, 'none');
});
await t('khối ngoài danh mục → none + lý do', async () => {
  const r = await run('toán lớp 9'); assert.equal(r.level, 'none'); assert.equal(r.reason, 'grade'); assert.match(composeText(r, catalog), /khối 10, 11, 12/);
});
await t('câu hỏi trống nghĩa → hỏi lại', async () => assert.equal((await run('cho em xin')).level, 'empty'));
await t('"mới nhất" sắp theo ngày đăng', async () => {
  const r = await run('học liệu mới nhất'); assert.equal(r.items[0].id, 'd');
});

console.log(`\n${process.exitCode ? 'CÓ LỖI' : 'TẤT CẢ ĐẠT'} (${pass} test đạt)`);
