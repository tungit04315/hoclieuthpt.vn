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
    resources: call('adminListResources'), resource: call('adminGetResource'), createResource: call('adminCreateResource'),
    updateResource: call('adminUpdateResource'), changeStatus: call('adminChangeResourceStatus'),
    deleteResource: call('adminDeleteResource'), restoreResource: call('adminRestoreResource'),
    moderationQueue: call('adminModerationQueue'), approve: call('adminApprove'), reject: call('adminReject'),
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