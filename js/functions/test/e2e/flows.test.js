/**
 * E2E qua Firebase Emulator (Auth + Firestore + Functions + Storage), gọi callable bằng HTTP.
 * Chạy (từ thư mục gốc):
 *   firebase emulators:exec --only auth,firestore,functions,storage \
 *     "npm --prefix functions run seed && npm --prefix functions run test:e2e"
 */
const PROJECT = process.env.GCLOUD_PROJECT || 'thu-vien-so-thpt', REGION = 'asia-southeast1';
const FN = (n) => `http://127.0.0.1:5001/${PROJECT}/${REGION}/${n}`;
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake';
const SP = process.env.SEED_STUDENT_PASSWORD || 'Student@12345', AP = process.env.SEED_ADMIN_PASSWORD || 'Admin@12345';

const signIn = async (email, password) => {
  const r = await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
  const j = await r.json(); if (!j.idToken) throw new Error('signIn failed ' + JSON.stringify(j)); return j.idToken;
};
/** Trả { ok, data, code, status } thay vì ném lỗi để test kiểm tra được cả trường hợp bị từ chối. */
const call = async (name, data = {}, token) => {
  const r = await fetch(FN(name), { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ data }) });
  const j = await r.json();
  return j.error ? { ok: false, status: j.error.status, code: j.error.details && j.error.details.code, message: j.error.message } : { ok: true, data: j.result };
};

let s, a, newId, aiId;
beforeAll(async () => { s = await signIn('student01@thuvien.vn', SP); a = await signIn('admin@thuvien.vn', AP); });

describe('Xác thực / phân quyền', () => {
  it('chưa đăng nhập => UNAUTHENTICATED', async () => expect((await call('getHome')).status).toBe('UNAUTHENTICATED'));
  it('đăng nhập bằng mã học sinh (email nội bộ)', async () => expect(typeof (await signIn('hs0002@hs.thuvien.vn', SP))).toBe('string'));
  it.each(['adminDashboard', 'adminListUsers', 'adminListAuditLogs', 'adminModerationQueue', 'adminListResources'])('STUDENT gọi %s => PERMISSION_DENIED', async (fn) => {
    const r = await call(fn, {}, s); expect(r.ok).toBe(false); expect(r.code).toBe('FORBIDDEN');
  });
  it('STUDENT không duyệt/sửa user được', async () => {
    expect((await call('adminApprove', { id: 'x' }, s)).code).toBe('FORBIDDEN');
    expect((await call('adminSetUserStatus', { uid: 'x', status: 'SUSPENDED' }, s)).code).toBe('FORBIDDEN');
  });
});

describe('Luồng STUDENT: home → search → detail → view → bookmark → download → history', () => {
  it('home', async () => { const r = await call('getHome', {}, s); expect(r.ok).toBe(true); expect(r.data.greeting).toContain('Như Ý'); expect(r.data.recommended.length).toBeGreaterThan(0); });
  it('search "python" + phân trang', async () => {
    const r = await call('searchResources', { q: 'python', limit: 5 }, s);
    expect(r.ok).toBe(true); expect(r.data.items.length).toBeGreaterThan(0); expect(r.data.pagination.limit).toBe(5);
    r.data.items.forEach((i) => expect(i.subject.name).toBe('Tin học')); aiId = r.data.items[0].id;
  });
  it('lọc khối 12', async () => { const r = await call('searchResources', { gradeId: '12' }, s); r.data.items.forEach((i) => expect(i.grade.name).toBe('12')); expect(r.data.items.length).toBeGreaterThan(0); });
  it('chi tiết không lộ đường dẫn lưu trữ', async () => { const r = await call('getResource', { id: aiId }, s); expect(r.ok).toBe(true); expect(JSON.stringify(r.data)).not.toContain('storagePath'); });
  it('view: lần 2 không đếm lại', async () => {
    const r1 = await call('recordView', { id: aiId }, s), r2 = await call('recordView', { id: aiId }, s);
    expect(r2.data.counted).toBe(false); expect(r2.data.viewCount).toBeGreaterThanOrEqual(r1.data.viewCount);
  });
  it('bookmark idempotent, bỏ lưu không âm', async () => {
    const b1 = await call('addBookmark', { id: aiId }, s), b2 = await call('addBookmark', { id: aiId }, s);
    expect(b2.data.favoriteCount).toBe(b1.data.favoriteCount);
    expect((await call('listBookmarks', {}, s)).data.items.some((i) => i.id === aiId)).toBe(true);
    const d1 = await call('removeBookmark', { id: aiId }, s), d2 = await call('removeBookmark', { id: aiId }, s);
    expect(d2.data.favoriteCount).toBe(d1.data.favoriteCount); expect(d2.data.favoriteCount).toBeGreaterThanOrEqual(0);
  });
  it('download: có file => URL; chỉ có link online => FILE_NOT_FOUND', async () => {
    const list = await call('searchResources', { q: 'bai tap python' }, s);
    const r = await call('getDownloadUrl', { id: list.data.items[0].id }, s);
    if (r.ok) { expect(r.data.url).toMatch(/^https?:\/\//); expect(r.data.expiresIn).toBeGreaterThan(0); } else expect(r.code).toBe('FILE_NOT_FOUND');
  });
  it('lịch sử xem', async () => expect((await call('listViewHistory', {}, s)).data.items.some((i) => i.resource.id === aiId)).toBe(true));
});

describe('Luồng ADMIN: dashboard → tạo → duyệt → danh mục → thống kê → audit', () => {
  it('dashboard', async () => { const r = await call('adminDashboard', { range: '7d' }, a); expect(r.ok).toBe(true); expect(typeof r.data.totalResources).toBe('number'); });
  it('tạo học liệu (DRAFT) => student chưa thấy', async () => {
    const r = await call('adminCreateResource', { title: 'Tài liệu e2e kiểm duyệt', authorName: 'Tester', subjectId: 'toan', gradeId: '10', resourceTypeId: 'document', onlineUrl: 'https://example.com/e2e' }, a);
    expect(r.ok).toBe(true); newId = r.data.id;
    expect((await call('getResource', { id: newId }, s)).code).toBe('RESOURCE_NOT_FOUND');
  });
  it('môn học không hợp lệ bị từ chối', async () => expect((await call('adminCreateResource', { title: 'x', authorName: 'y', subjectId: 'khong-co', gradeId: '10', resourceTypeId: 'document' }, a)).code).toBe('INVALID_SUBJECT'));
  it('gửi duyệt → từ chối thiếu lý do → duyệt => PUBLISHED, student thấy', async () => {
    expect((await call('adminChangeResourceStatus', { id: newId, status: 'PENDING_REVIEW' }, a)).ok).toBe(true);
    expect((await call('adminReject', { id: newId }, a)).code).toBe('VALIDATION_ERROR');
    expect((await call('adminModerationQueue', {}, a)).data.items.some((i) => i.id === newId)).toBe(true);
    const ok = await call('adminApprove', { id: newId }, a);
    expect(ok.data.status).toBe('PUBLISHED'); expect(ok.data.statusHistory.length).toBeGreaterThanOrEqual(3);
    expect((await call('getResource', { id: newId }, s)).ok).toBe(true);
  });
  it('chuyển trạng thái không hợp lệ => INVALID_STATUS_TRANSITION', async () => expect((await call('adminChangeResourceStatus', { id: newId, status: 'DRAFT' }, a)).code).toBe('INVALID_STATUS_TRANSITION'));
  it('ẩn → xóa mềm → khôi phục', async () => {
    await call('adminChangeResourceStatus', { id: newId, status: 'HIDDEN' }, a);
    expect((await call('getResource', { id: newId }, s)).code).toBe('RESOURCE_NOT_FOUND');
    expect((await call('adminDeleteResource', { id: newId }, a)).ok).toBe(true);
    expect((await call('adminRestoreResource', { id: newId }, a)).ok).toBe(true);
  });
  it('audit log có ADMIN_PUBLISH_RESOURCE; admin không tự khóa mình', async () => {
    expect((await call('adminListAuditLogs', { action: 'ADMIN_PUBLISH_RESOURCE', entityId: newId }, a)).data.items.length).toBe(1);
    const me = (await call('me', {}, a)).data;
    expect((await call('adminSetUserStatus', { uid: me.uid, status: 'SUSPENDED' }, a)).code).toBe('CANNOT_MODIFY_SELF');
  });
  it('khóa học sinh => bị từ chối ngay; mở lại => dùng được', async () => {
    const me = (await call('me', {}, s)).data;
    expect((await call('adminSetUserStatus', { uid: me.uid, status: 'SUSPENDED', reason: 'e2e' }, a)).ok).toBe(true);
    expect((await call('getHome', {}, s)).code).toBe('ACCOUNT_DISABLED');
    expect((await call('adminSetUserStatus', { uid: me.uid, status: 'ACTIVE' }, a)).ok).toBe(true);
    s = await signIn('student01@thuvien.vn', SP);
    expect((await call('getHome', {}, s)).ok).toBe(true);
  });
  it('danh mục: "xóa" = INACTIVE; thống kê trả dữ liệu', async () => {
    expect((await call('adminSaveCatalog', { entity: 'topics', subjectId: 'toan', name: 'Chủ đề e2e' }, a)).ok).toBe(true);
    expect((await call('adminDisableCatalog', { entity: 'topics', id: 'toan-chu-de-e2e' }, a)).data.status).toBe('INACTIVE');
    for (const kind of ['overview', 'resources', 'users', 'search', 'downloads', 'views']) expect((await call('adminStatistics', { kind }, a)).ok).toBe(true);
  });
});
