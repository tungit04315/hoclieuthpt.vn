/**
 * Lớp gọi backend cho frontend HTML/JS (thay thế dữ liệu mock trong app.js).
 * Dùng: <script type="module">import { Api } from './js/firebase-api.js'; ...</script>
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, connectAuthEmulator } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFunctions, httpsCallable, connectFunctionsEmulator } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';
import { getFirestore, collection, doc, getDocs, getDoc, query, where, orderBy, limit, updateDoc, deleteDoc, writeBatch, getCountFromServer, connectFirestoreEmulator } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getStorage, ref, uploadBytes, connectStorageEmulator } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js';
import { firebaseConfig, REGION, USE_EMULATOR } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app), fns = getFunctions(app, REGION), db = getFirestore(app), storage = getStorage(app);
if (USE_EMULATOR) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true }); connectFunctionsEmulator(fns, '127.0.0.1', 5001);
  connectFirestoreEmulator(db, '127.0.0.1', 8080); connectStorageEmulator(storage, '127.0.0.1', 9199);
}

/** Chuẩn hóa lỗi: { code: 'RESOURCE_NOT_FOUND' | 'INVALID_CREDENTIALS' | ..., message } */
const fail = (e) => {
  const authMsg = ['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found', 'auth/invalid-email'].includes(e.code);
  if (authMsg) return { code: 'INVALID_CREDENTIALS', message: 'Tài khoản hoặc mật khẩu không đúng' };
  if (e.code === 'auth/user-disabled') return { code: 'ACCOUNT_DISABLED', message: 'Tài khoản đã bị khóa' };
  if (e.code === 'auth/network-request-failed') {
    return { code: 'NETWORK_ERROR', message: USE_EMULATOR ? 'Không kết nối được Firebase Emulator. Hãy chạy: firebase emulators:start' : 'Không có kết nối mạng tới Firebase' };
  }
  if (e.code === 'functions/not-found' || e.code === 'functions/unavailable') {
    return { code: 'FUNCTIONS_UNAVAILABLE', message: USE_EMULATOR ? 'Chưa chạy Functions Emulator (cổng 5001) hoặc chưa seed dữ liệu' : 'Cloud Functions chưa được triển khai' };
  }
  if (e.code === 'auth/too-many-requests') return { code: 'TOO_MANY_REQUESTS', message: 'Thử quá nhiều lần, vui lòng đợi' };
  return { code: (e.details && e.details.code) || e.code || 'UNKNOWN', message: e.message || 'Đã có lỗi xảy ra' };
};
const call = (name) => async (data = {}) => {
  try { return (await httpsCallable(fns, name)(data)).data; } catch (e) { throw fail(e); }
};
const uid = () => auth.currentUser.uid;

/* ---- Bộ chuyển đổi: giao diện admin dùng chung 1 kiểu dữ liệu với mock-api.js ---- */
const fbStatus = (s) => (s === 'PENDING_REVIEW' || s === 'APPROVED' ? 'PENDING' : s); // UI chỉ có 1 trạng thái "Chờ duyệt"
const fbDetail = (r) => ({
  id: r.id, title: r.title, author: r.authorName, subjectId: r.subjectId, subject: r.subjectName, gradeId: r.gradeId, grade: r.gradeName,
  topic: r.topicName || '', resourceTypeId: r.resourceTypeId, type: r.resourceTypeName, description: r.description || '',
  url: r.onlineUrl || '', videoUrl: r.videoUrl || '', status: fbStatus(r.status),
  rejectReason: r.status === 'REJECTED' ? ((r.reviews || []).find((x) => x.decision === 'REJECTED') || {}).reason || null : null,
  views: r.viewCount || 0, createdAt: r.createdAt, updatedAt: r.updatedAt, ownerId: r.createdBy,
  files: (r.fileSummaries || []).map(({ name, format, size }) => ({ name, format, size })),
});
const fbTopicId = async (subjectId, name) => { // chủ đề nhập tay -> id trong danh mục (không có thì bỏ trống)
  const t = String(name || '').trim().toLowerCase(); if (!t) return null;
  try {
    const snap = await getDocs(query(collection(db, 'topics'), where('status', '==', 'ACTIVE')));
    const m = snap.docs.find((d) => d.data().subjectId === subjectId && String(d.data().name).trim().toLowerCase() === t);
    return m ? m.id : null;
  } catch { return null; }
};
const fbBody = async (d) => ({
  title: d.title, authorName: d.author, subjectId: d.subjectId, gradeId: d.gradeId, resourceTypeId: d.resourceTypeId,
  topicId: await fbTopicId(d.subjectId, d.topic), description: d.description ?? '', onlineUrl: d.url ?? '', videoUrl: d.videoUrl ?? '',
});
const withErr = async (fn) => { try { return await fn(); } catch (e) { throw e.code && e.message && !e.name ? e : fail(e); } };

export const Api = {
  /* ---- Auth ---- */
  /** identifier: email hoặc mã học sinh (vd HS0001) */
  async login(identifier, password) {
    const id = identifier.trim();
    const email = id.includes('@') ? id : `${id.toLowerCase()}@hs.thuvien.vn`; // mã học sinh -> email nội bộ
    try { await signInWithEmailAndPassword(auth, email, password); } catch (e) { throw fail(e); }
    return call('me')(); // trả hồ sơ + role (lấy từ DB)
  },
  logout: () => signOut(auth),
  onAuth: (cb) => onAuthStateChanged(auth, cb),

  /* ---- Học sinh ---- */
  me: call('me'), updateProfile: call('updateProfile'),
  home: call('getHome'), recommendations: call('getRecommendations'),
  search: call('searchResources'),                 // {q, subjectId, gradeId, topicId, resourceTypeId, author, sort, page, limit}
  resource: (id) => call('getResource')({ id }), view: (id, durationSeconds) => call('recordView')({ id, durationSeconds }),
  download: (id, fileId) => call('getDownloadUrl')({ id, fileId }),                // -> { url, expiresIn, fileName }
  addBookmark: (id) => call('addBookmark')({ id }), removeBookmark: (id) => call('removeBookmark')({ id }),
  bookmarks: call('listBookmarks'), viewHistory: call('listViewHistory'),
  /** Gửi yêu cầu bổ sung học liệu khi tìm không thấy: {text, subjectId?, gradeId?, resourceTypeId?} → { id } | { duplicate: true } */
  createRequest: call('createResourceRequest'),

  /* ---- Đọc trực tiếp Firestore (Security Rules bảo vệ) ---- */
  async catalog(name) { // 'subjects' | 'grades' | 'topics' | 'resourceTypes'
    return withErr(async () => (await getDocs(query(collection(db, name), where('status', '==', 'ACTIVE')))).docs.map((d) => ({ id: d.id, ...d.data() })));
  },
  async searchHistory(n = 20) {
    return withErr(async () => (await getDocs(query(collection(db, `users/${uid()}/searchHistory`), orderBy('createdAt', 'desc'), limit(n)))).docs.map((d) => ({ id: d.id, ...d.data() })));
  },
  async clearSearchHistory() {
    return withErr(async () => { const s = await getDocs(collection(db, `users/${uid()}/searchHistory`)); const b = writeBatch(db); s.docs.forEach((d) => b.delete(d.ref)); await b.commit(); });
  },
  deleteViewHistory: (id) => withErr(() => deleteDoc(doc(db, `users/${uid()}/viewHistory/${id}`))),
  async notifications(n = 30) {
    return withErr(async () => (await getDocs(query(collection(db, `users/${uid()}/notifications`), orderBy('createdAt', 'desc'), limit(n)))).docs.map((d) => ({ id: d.id, ...d.data() })));
  },
  async unreadCount() {
    return withErr(async () => (await getCountFromServer(query(collection(db, `users/${uid()}/notifications`), where('isRead', '==', false)))).data().count);
  },
  markRead: (id) => withErr(() => updateDoc(doc(db, `users/${uid()}/notifications/${id}`), { isRead: true })),
  async markAllRead() {
    return withErr(async () => { const s = await getDocs(query(collection(db, `users/${uid()}/notifications`), where('isRead', '==', false))); const b = writeBatch(db); s.docs.forEach((d) => b.update(d.ref, { isRead: true })); await b.commit(); });
  },

  /* ---- Admin ---- */
  admin: {
    dashboard: call('adminDashboard'), statistics: call('adminStatistics'), auditLogs: call('adminListAuditLogs'),
    users: call('adminListUsers'), user: call('adminGetUser'), createUser: call('adminCreateUser'), updateUser: call('adminUpdateUser'),
    setUserStatus: call('adminSetUserStatus'), resetPassword: call('adminResetPassword'),
    changeStatus: call('adminChangeResourceStatus'), restoreResource: call('adminRestoreResource'),
    approve: call('adminApprove'), reject: call('adminReject'),
    /** Danh sách tài liệu (UI: PENDING = chờ duyệt). */
    async resources({ q, status } = {}) {
      const r = await call('adminListResources')({ q: q || undefined, status: status ? (status === 'PENDING' ? 'PENDING_REVIEW' : status) : undefined, limit: 50 });
      return { items: r.items.map((i) => ({ id: i.id, title: i.title, author: i.author, subject: i.subject && i.subject.name, grade: i.grade && i.grade.name, status: fbStatus(i.status), views: i.viewCount || 0 })), pagination: r.pagination };
    },
    resource: async (id) => fbDetail(await call('adminGetResource')({ id })),
    async createResource(d) { // tạo nháp rồi (nếu chọn) đăng ngay
      const r = await call('adminCreateResource')(await fbBody(d));
      if (!d.publish) return { id: r.id, message: 'Đã lưu bản nháp' };
      try { await call('adminChangeResourceStatus')({ id: r.id, status: 'PUBLISHED' }); return { id: r.id, message: 'Đã đăng tài liệu' }; }
      catch (e) { return { id: r.id, message: 'Đã lưu nháp, chưa đăng được: ' + e.message }; }
    },
    async updateResource(id, d) {
      await call('adminUpdateResource')({ id, ...(await fbBody(d)) });
      if (d.publish) { try { await call('adminChangeResourceStatus')({ id, status: 'PUBLISHED' }); return { message: 'Đã lưu và đăng tài liệu' }; } catch (e) { return { message: 'Đã lưu, chưa đăng được: ' + e.message }; } }
      return { message: 'Đã lưu thay đổi' };
    },
    async setResourceVisible(id, visible) { await call('adminChangeResourceStatus')({ id, status: visible ? 'PUBLISHED' : 'HIDDEN' }); return { message: visible ? 'Đã hiện tài liệu' : 'Đã ẩn tài liệu khỏi học sinh' }; },
    async deleteResource(id) { await call('adminDeleteResource')({ id }); return { message: 'Đã xóa tài liệu' }; },
    async moderationQueue() {
      const r = await call('adminModerationQueue')({ limit: 50 });
      return { ...r, items: r.items.map((i) => ({ id: i.id, title: i.title, author: i.author, subject: i.subject, grade: i.grade, fileCount: i.fileCount, hasUrl: !!i.hasOnlineUrl, hasVideo: !!i.hasVideoUrl })) };
    },
    catalog: call('adminListCatalog'), saveCatalog: call('adminSaveCatalog'), disableCatalog: call('adminDisableCatalog'),
    homeContent: call('adminGetHomeContent'), saveHomeContent: call('adminSaveHomeContent'),
    requests: call('adminListResourceRequests'), updateRequest: call('adminUpdateResourceRequest'), // yêu cầu tài liệu từ học sinh
    notify: call('adminSendNotification'), removeFile: call('adminRemoveFile'), filePreviewUrl: call('adminFilePreviewUrl'),
    /** Tải file lên Storage rồi nhờ Function kiểm tra (đuôi/MIME/magic bytes/dung lượng) và ghi nhận. */
    async uploadFile(resourceId, file) {
      const fileId = crypto.randomUUID().replace(/-/g, ''), ext = file.name.split('.').pop().toLowerCase();
      try { await uploadBytes(ref(storage, `resources/${resourceId}/${fileId}.${ext}`), file, { contentType: file.type }); } catch (e) { throw fail(e); }
      return call('adminRegisterFile')({ resourceId, fileId, originalName: file.name });
    },
  },
};