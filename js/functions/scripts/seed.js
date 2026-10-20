'use strict';
/**
 * Seed dữ liệu mẫu (idempotent). Dùng được cho Emulator hoặc dự án thật.
 *  - Emulator:  emulators đang chạy (hoặc chạy qua `firebase emulators:exec`) rồi `npm run seed`
 *  - Dự án thật: đặt GOOGLE_APPLICATION_CREDENTIALS (service account) + GCLOUD_PROJECT + SEED_ADMIN_PASSWORD, SEED_STUDENT_PASSWORD
 */
const admin = require('firebase-admin');
const P = require('../src/lib/pure');

const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'thu-vien-so-thpt';
const emulator = !!process.env.FIRESTORE_EMULATOR_HOST;
admin.initializeApp({ projectId: project, storageBucket: process.env.STORAGE_BUCKET || `${project}.appspot.com` });
const db = admin.firestore(), auth = admin.auth(), now = admin.firestore.FieldValue.serverTimestamp();

async function main() {
  const adminPw = process.env.SEED_ADMIN_PASSWORD, studentPw = process.env.SEED_STUDENT_PASSWORD;
  if (!emulator && (!adminPw || !studentPw)) throw new Error('Dự án thật: phải đặt SEED_ADMIN_PASSWORD và SEED_STUDENT_PASSWORD (không có mật khẩu mặc định)');
  const A = adminPw || 'Admin@12345', S = studentPw || 'Student@12345'; // mật khẩu DEMO chỉ cho emulator

  // ---- Danh mục ----
  for (const n of ['10', '11', '12']) await db.doc(`grades/${n}`).set({ name: n, status: 'ACTIVE' }, { merge: true });
  const subjects = ['Toán', 'Vật lý', 'Hóa học', 'Sinh học', 'Tin học', 'Ngữ văn', 'Tiếng Anh'];
  for (const name of subjects) await db.doc(`subjects/${P.slugify(name)}`).set({ name, slug: P.slugify(name), description: null, status: 'ACTIVE' }, { merge: true });
  const topics = [['tin-hoc', 'Vòng lặp'], ['tin-hoc', 'Biến và kiểu dữ liệu'], ['vat-ly', 'Dao động & Sóng điện từ'], ['toan', 'Hàm số và đồ thị'], ['tieng-anh', 'Ôn thi THPT Quốc gia']];
  for (const [sid, name] of topics) await db.doc(`topics/${sid}-${P.slugify(name)}`).set({ subjectId: sid, name, slug: P.slugify(name), description: null, status: 'ACTIVE' }, { merge: true });
  const types = [['VIDEO', 'Video bài giảng'], ['EXERCISE', 'Bài tập'], ['EXAM', 'Đề thi'], ['SUMMARY', 'Tài liệu tóm tắt'], ['DOCUMENT', 'Tài liệu học tập']];
  for (const [code, name] of types) await db.doc(`resourceTypes/${code.toLowerCase()}`).set({ code, name, description: null, status: 'ACTIVE' }, { merge: true });
  await db.doc('settings/home').set({
    introduction: { school: 'Thư viện Trường THPT Nguyễn Thị Minh Khai', tagline: 'Tri thức hôm nay – Kiến tạo tương lai',
      about: 'Thư viện số THPT kết nối tri thức, đồng hành cùng học sinh trong học tập và ôn thi.',
      hours: ['Thứ 2 – Thứ 6: 7:00 – 17:00', 'Thứ 7: 7:00 – 11:30'], address: 'Tầng 1, Nhà A', phone: '028 1234 5678', email: 'thuvien@example.edu.vn',
      rules: ['Mang theo thẻ khi đến thư viện.', 'Giữ trật tự trong phòng đọc.'] },
    guide: [
      { title: 'Tìm học liệu', body: 'Vào tab Tìm kiếm, gõ tên bài, môn học hoặc tác giả (có dấu hay không dấu đều được) rồi dùng bộ lọc.', go: 'search', cta: 'Tìm ngay' },
      { title: 'Xem, tải và lưu học liệu', body: 'Mở học liệu để xem mô tả; bấm Xem học liệu để mở video YouTube, bấm Tải xuống để mở link tài liệu (nếu chưa có sẽ có thông báo), hoặc chạm dấu trang để lưu vào Học liệu số.', go: 'library', cta: 'Mở Học liệu số' },
    ],
  }, { merge: true });

  // ---- Người dùng ----
  async function user(email, password, role, fullName, extra = {}) {
    let rec;
    try { rec = await auth.getUserByEmail(email); } catch { rec = await auth.createUser({ email, password, displayName: fullName }); }
    await auth.setCustomUserClaims(rec.uid, { role });
    await db.doc(`users/${rec.uid}`).set({ email, contactEmail: null, phone: null, studentCode: null, fullName, role, status: 'ACTIVE', avatarUrl: null,
      createdAt: now, updatedAt: now, lastLoginAt: null, ...extra }, { merge: true });
    return rec.uid;
  }
  const adminUid = await user('admin@thuvien.vn', A, 'ADMIN', 'Quản trị viên');
  await user('student01@thuvien.vn', S, 'STUDENT', 'Nguyễn Như Ý', { studentCode: 'HS0001', school: 'THPT Nguyễn Thị Minh Khai', gradeId: '10', gradeName: '10', className: '10A2' });
  // Đăng nhập bằng mã học sinh: email nội bộ <mã>@hs.thuvien.vn (client tự ghép)
  await user('hs0002@hs.thuvien.vn', S, 'STUDENT', 'Trần Minh Khang', { studentCode: 'HS0002', school: 'THPT Nguyễn Thị Minh Khai', gradeId: '12', gradeName: '12', className: '12A1' });

  // ---- Học liệu ----
  const cat = await require('../src/lib/common').loadCatalogs();
  const rows = [
    ['Video Bài Giảng Vật Lý 12: Thí Nghiệm Giao Thoa Ánh Sáng', 'PGS. TS. Vũ Văn Hùng', 'vat-ly', '12', 'vat-ly-dao-dong-song-dien-tu', 'video', 'https://www.youtube.com/watch?v=demo-giao-thoa', 1200, 150, 756],
    ['Bài giảng Python - Vòng lặp (for, while)', 'Cô Lê Minh Anh', 'tin-hoc', '10', 'tin-hoc-vong-lap', 'video', 'https://www.youtube.com/watch?v=demo-python-loop', 980, 120, 1100],
    ['Bài tập Python cơ bản về vòng lặp', 'Thầy Trần Quốc Bảo', 'tin-hoc', '10', 'tin-hoc-vong-lap', 'exercise', null, 640, 210],
    ['Python cơ bản - Lý thuyết và ví dụ', 'Cô Lê Minh Anh', 'tin-hoc', '10', 'tin-hoc-bien-va-kieu-du-lieu', 'document', null, 512, 90],
    ['Tóm tắt hàm số và đồ thị', 'Thầy Nguyễn Văn Nam', 'toan', '11', 'toan-ham-so-va-do-thi', 'summary', null, 856, 300],
    ['Đề thi thử THPT Quốc gia', 'Tổ Tiếng Anh', 'tieng-anh', '12', 'tieng-anh-on-thi-thpt-quoc-gia', 'exam', null, 2100, 800],
  ];
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
  const ids = [];
  for (const [i, [title, authorName, subjectId, gradeId, topicId, resourceTypeId, onlineUrl, viewCount, downloadCount, durationSeconds]] of rows.entries()) {
    const id = P.slugify(title).slice(0, 60); // id cố định => seed chạy lại không nhân đôi
    const names = P.resolveCatalog({ subjectId, gradeId, topicId, resourceTypeId }, cat);
    const r = { title, authorName, description: `${title}. Tài liệu ${names.subjectName} lớp ${gradeId}, chủ đề ${names.topicName}, do ${authorName} biên soạn.`,
      subjectId, gradeId, topicId, resourceTypeId, ...names, slug: id, thumbnailUrl: null, onlineUrl, durationSeconds: durationSeconds ?? null,
      status: 'PUBLISHED', viewCount, downloadCount, favoriteCount: 0, fileSummaries: [], createdBy: adminUid, deleted: false, deletedAt: null,
      publishedAt: admin.firestore.Timestamp.fromMillis(Date.now() - i * 3 * 864e5), createdAt: now, updatedAt: now };
    if (!onlineUrl) { // học liệu dạng file: tải 1 PDF mẫu lên Storage để thử tải xuống
      const path = `resources/${id}/seedfile000000000${i}.pdf`.replace(/\/seedfile/, '/seedfile');
      await admin.storage().bucket().file(path).save(pdf, { contentType: 'application/pdf' }).catch((e) => console.warn('Bỏ qua upload (Storage chưa sẵn sàng):', e.message));
      r.fileSummaries = [{ id: `seedfile000000000${i}`, name: `${id}.pdf`, format: 'PDF', size: pdf.length }];
      await db.doc(`resources/${id}/files/seedfile000000000${i}`).set({ originalName: `${id}.pdf`, storagePath: path, fileFormat: 'PDF', mimeType: 'application/pdf', fileSize: pdf.length, checksum: null, createdAt: now });
    }
    await db.doc(`resources/${id}`).set({ ...r, ...P.derive(r) });
    await db.collection(`resources/${id}/statusHistory`).doc('seed').set({ fromStatus: null, toStatus: 'PUBLISHED', changedBy: adminUid, reason: 'Seed', createdAt: now });
    ids.push(id);
  }
  // 1 học liệu chờ duyệt (có link) để thử luồng kiểm duyệt; học sinh không thấy
  const pn = P.resolveCatalog({ subjectId: 'toan', gradeId: '11', topicId: 'toan-ham-so-va-do-thi', resourceTypeId: 'document' }, cat);
  const pending = { title: 'Đề cương ôn tập Toán 11 (chờ duyệt)', authorName: 'Thầy Nguyễn Văn Nam', description: null, subjectId: 'toan', gradeId: '11', topicId: 'toan-ham-so-va-do-thi',
    resourceTypeId: 'document', ...pn, slug: 'de-cuong-on-tap-toan-11-cho-duyet', thumbnailUrl: null, onlineUrl: 'https://example.com/de-cuong', durationSeconds: null,
    status: 'PENDING_REVIEW', viewCount: 0, downloadCount: 0, favoriteCount: 0, fileSummaries: [], createdBy: adminUid, deleted: false, deletedAt: null, publishedAt: null, createdAt: now, updatedAt: now };
  await db.doc('resources/de-cuong-on-tap-toan-11-cho-duyet').set({ ...pending, ...P.derive(pending) });
  console.log('Seed OK', { project, emulator, admin: 'admin@thuvien.vn', student: 'student01@thuvien.vn / HS0002', resources: ids.length + 1 });
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
