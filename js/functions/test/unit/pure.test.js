const P = require('../../src/lib/pure');

const R = (o) => ({ id: o.id, title: o.title, authorName: 'GV', subjectId: o.s || 'tin-hoc', subjectName: 'Tin học', gradeId: o.g || '10', gradeName: o.g || '10',
  topicId: o.t || null, topicName: o.tn || null, resourceTypeName: 'Video', viewCount: o.v || 0, downloadCount: 0, favoriteCount: 0,
  publishedAt: new Date(o.at || Date.now()), createdAt: new Date(), ...P.derive({ title: o.title, authorName: 'GV', subjectName: 'Tin học', gradeName: o.g || '10', topicName: o.tn, description: o.d }) });

describe('chuẩn hóa & token', () => {
  it('bỏ dấu tiếng Việt', () => expect(P.normalize('Vòng lặp ĐỒ THỊ')).toBe('vong lap do thi'));
  it('tokenize bỏ từ đệm, giữ từ khóa', () => expect(P.tokenize('Em cần tài liệu về vòng lặp Python lớp 10')).toEqual(['vong', 'lap', 'python', '10']));
});

describe('rankSearch (không AI)', () => {
  const items = [
    R({ id: 'a', title: 'Bài giảng Python - Vòng lặp (for, while)', v: 10, t: 'vl', tn: 'Vòng lặp' }),
    R({ id: 'b', title: 'Tóm tắt hàm số và đồ thị', s: 'toan', g: '11', v: 99999 }),
    R({ id: 'c', title: 'Python cơ bản - Lý thuyết', v: 5 }),
  ];
  it('tìm "python" chỉ ra tài liệu liên quan, không bị bài phổ biến lấn át', () => expect(P.rankSearch(items, { q: 'python' }).map((x) => x.id).sort()).toEqual(['a', 'c']));
  it('khớp nhiều từ xếp trên', () => expect(P.rankSearch(items, { q: 'python vòng lặp' })[0].id).toBe('a'));
  it('lọc theo khối', () => expect(P.rankSearch(items, { filters: { gradeId: '11' } }).map((x) => x.id)).toEqual(['b']));
  it('không từ khóa: mặc định mới nhất, trả đủ', () => expect(P.rankSearch(items, {}).length).toBe(3));
  it('sort không hợp lệ => lỗi', () => expect(() => P.rankSearch(items, { sort: 'x' })).toThrow());
});

describe('recommend (theo hành vi)', () => {
  const items = [R({ id: 'py', title: 'Python 1', g: '10' }), R({ id: 'toan', title: 'Hàm số', s: 'toan', g: '11', t: 'hs', tn: 'Hàm số' })];
  it('chưa có lịch sử: ưu tiên đúng khối', () => { const r = P.recommend(items, { gradeId: '10' }); expect(r.personalized).toBe(false); expect(r.list[0].id).toBe('py'); });
  it('chỉ xem 1 môn khác khối: khối vẫn nhỉnh hơn (khối là ưu tiên số 1)', () => {
    const r = P.recommend(items, { gradeId: '10', views: [{ subjectId: 'toan' }] });
    expect(r.personalized).toBe(true); expect(r.list[0].id).toBe('py');
  });
  it('xem nhiều cả môn lẫn chủ đề Toán: Toán lên đầu dù khác khối', () => {
    const v = { subjectId: 'toan', topicId: 'hs' };
    expect(P.recommend(items, { gradeId: '10', views: [v, v, v] }).list[0].id).toBe('toan');
  });
});

describe('trạng thái học liệu', () => {
  it('PENDING_REVIEW -> APPROVED/REJECTED/DRAFT', () => expect([...P.ALLOWED_TRANSITIONS.PENDING_REVIEW].sort()).toEqual(['APPROVED', 'DRAFT', 'REJECTED']));
  it('không nhảy REJECTED/ARCHIVED -> PUBLISHED', () => { expect(P.ALLOWED_TRANSITIONS.REJECTED).not.toContain('PUBLISHED'); expect(P.ALLOWED_TRANSITIONS.ARCHIVED).not.toContain('PUBLISHED'); });
});

describe('resolveCatalog', () => {
  const cat = { subjects: { a: { status: 'ACTIVE', name: 'A' }, b: { status: 'INACTIVE', name: 'B' } }, grades: { 10: { status: 'ACTIVE', name: '10' } },
    topics: { t: { status: 'ACTIVE', name: 'T', subjectId: 'a' } }, resourceTypes: { v: { status: 'ACTIVE', name: 'V', code: 'VIDEO' } } };
  const code = (i) => { try { P.resolveCatalog(i, cat); } catch (e) { return e.code; } return 'OK'; };
  it('hợp lệ', () => expect(code({ subjectId: 'a', gradeId: '10', resourceTypeId: 'v', topicId: 't' })).toBe('OK'));
  it('môn INACTIVE bị từ chối', () => expect(code({ subjectId: 'b', gradeId: '10', resourceTypeId: 'v' })).toBe('INVALID_SUBJECT'));
  it('chủ đề không thuộc môn', () => expect(code({ subjectId: 'a', gradeId: '10', resourceTypeId: 'v', topicId: 'zzz' })).toBe('INVALID_TOPIC'));
});

describe('validateFileMeta', () => {
  const ok = { name: 'a.pdf', mime: 'application/pdf', size: 100, head: Buffer.from('%PDF-1.7') };
  const code = (o) => { try { P.validateFileMeta({ ...ok, ...o }); } catch (e) { return e.code; } return 'OK'; };
  it('PDF hợp lệ', () => expect(code({})).toBe('OK'));
  it('đuôi .exe', () => expect(code({ name: 'a.exe' })).toBe('FILE_TYPE_NOT_ALLOWED'));
  it('MIME sai', () => expect(code({ mime: 'text/html' })).toBe('FILE_MIME_MISMATCH'));
  it('đổi đuôi (nội dung không phải PDF)', () => expect(code({ head: Buffer.from('<script>x</script>') })).toBe('FILE_CONTENT_INVALID'));
  it('quá dung lượng', () => expect(code({ size: 60 * 1048576 })).toBe('FILE_TOO_LARGE'));
});

describe('khoảng ngày', () => {
  it('daysBetween gồm hai đầu', () => expect(P.daysBetween('2026-01-30', '2026-02-02')).toEqual(['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']));
  it('7d = 7 ngày', () => expect(P.resolveRange({ range: '7d' }, new Date('2026-10-09T05:00:00Z')).length).toBe(7));
  it('custom sai thứ tự', () => expect(() => P.resolveRange({ range: 'custom', from: '2026-02-02', to: '2026-01-01' })).toThrow());
  it('quá 92 ngày', () => expect(() => P.daysBetween('2026-01-01', '2026-12-31')).toThrow());
});

describe('normalizeHomeContent (nội dung trang chủ do admin quản trị)', () => {
  const ok = { introduction: { school: ' Thư viện <b>A</b> ', hours: ['T2', '', 'T3'], email: 'a@b.vn', phone: '028 123 4567' }, guide: [{ title: 'T', body: 'B', go: 'search' }, { title: 'U', body: 'V' }] };
  it('làm sạch HTML, bỏ dòng trống, mặc định nhãn nút', () => {
    const r = P.normalizeHomeContent(ok);
    expect(r.introduction.school).toBe('Thư viện A'); expect(r.introduction.hours).toEqual(['T2', 'T3']);
    expect(r.guide[0]).toEqual({ title: 'T', body: 'B', go: 'search', cta: 'Mở' }); expect(r.guide[1].go).toBeUndefined();
  });
  it('từ chối đích không hợp lệ, thiếu tên, email sai, quá 20 mục', () => {
    expect(() => P.normalizeHomeContent({ ...ok, guide: [{ title: 'T', body: 'B', go: 'admin' }] })).toThrow();
    expect(() => P.normalizeHomeContent({ introduction: {}, guide: [] })).toThrow();
    expect(() => P.normalizeHomeContent({ ...ok, introduction: { school: 'A', email: 'x' } })).toThrow();
    expect(() => P.normalizeHomeContent({ ...ok, guide: Array(21).fill({ title: 'T', body: 'B' }) })).toThrow();
  });
});

describe('yêu cầu bổ sung học liệu', () => {
  it('làm sạch HTML, giữ id lọc, id rỗng → null', () => {
    expect(P.normalizeRequest({ text: '  <b>Đề thi</b> Java  ', subjectId: 'tin-hoc', gradeId: '' }))
      .toEqual({ text: 'Đề thi Java', subjectId: 'tin-hoc', gradeId: null, resourceTypeId: null });
  });
  it('từ chối nội dung quá ngắn / quá dài / không phải chuỗi', () => {
    expect(() => P.normalizeRequest({ text: 'abc' })).toThrow('tối thiểu 5');
    expect(() => P.normalizeRequest({ text: 'x'.repeat(301) })).toThrow('tối đa 300');
    expect(() => P.normalizeRequest({ text: 123 })).toThrow('phải là chuỗi');
    expect(() => P.normalizeRequest({})).toThrow('bắt buộc');
  });
});
