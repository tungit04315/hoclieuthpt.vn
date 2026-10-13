/** Chạy trong emulator: firebase emulators:exec --only firestore "npm --prefix functions run test:rules" */
const fs = require('fs');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, updateDoc, deleteDoc } = require('firebase/firestore');

let env;
beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: 'rules-test', firestore: { rules: fs.readFileSync('../firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 } });
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, 'resources/pub'), { status: 'PUBLISHED', deleted: false, title: 'x' });
    await setDoc(doc(d, 'resources/draft'), { status: 'DRAFT', deleted: false });
    await setDoc(doc(d, 'resources/pub/files/f'), { storagePath: 'secret' });
    await setDoc(doc(d, 'users/s1'), { role: 'STUDENT' });
    await setDoc(doc(d, 'users/s2'), { role: 'STUDENT' });
    await setDoc(doc(d, 'users/s1/notifications/n'), { title: 't', isRead: false });
    await setDoc(doc(d, 'subjects/on'), { status: 'ACTIVE' });
    await setDoc(doc(d, 'subjects/off'), { status: 'INACTIVE' });
    await setDoc(doc(d, 'audit_logs/a'), { action: 'X' });
  });
});
afterAll(() => env.cleanup());
const student = () => env.authenticatedContext('s1', { role: 'STUDENT' }).firestore();
const adminDb = () => env.authenticatedContext('a1', { role: 'ADMIN' }).firestore();

describe('Firestore rules', () => {
  it('chưa đăng nhập không đọc được gì', () => assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'resources/pub'))));
  it('đăng nhập nhưng không có role (tự đăng ký) bị chặn', () => assertFails(getDoc(doc(env.authenticatedContext('x').firestore(), 'resources/pub'))));
  it('student đọc được học liệu PUBLISHED', () => assertSucceeds(getDoc(doc(student(), 'resources/pub'))));
  it('student KHÔNG đọc được học liệu DRAFT', () => assertFails(getDoc(doc(student(), 'resources/draft'))));
  it('admin đọc được DRAFT', () => assertSucceeds(getDoc(doc(adminDb(), 'resources/draft'))));
  it('student KHÔNG đọc được đường dẫn file (subcollection files)', () => assertFails(getDoc(doc(student(), 'resources/pub/files/f'))));
  it('student không ghi được resources/users/danh mục', async () => {
    await assertFails(setDoc(doc(student(), 'resources/pub'), { status: 'PUBLISHED', deleted: false }));
    await assertFails(updateDoc(doc(student(), 'users/s1'), { role: 'ADMIN' }));
    await assertFails(setDoc(doc(student(), 'subjects/new'), { status: 'ACTIVE' }));
  });
  it('student không đọc được hồ sơ người khác', () => assertFails(getDoc(doc(student(), 'users/s2'))));
  it('danh mục INACTIVE ẩn với student, hiện với admin', async () => {
    await assertSucceeds(getDoc(doc(student(), 'subjects/on'))); await assertFails(getDoc(doc(student(), 'subjects/off'))); await assertSucceeds(getDoc(doc(adminDb(), 'subjects/off')));
  });
  it('thông báo: chỉ đổi được isRead', async () => {
    await assertSucceeds(updateDoc(doc(student(), 'users/s1/notifications/n'), { isRead: true }));
    await assertFails(updateDoc(doc(student(), 'users/s1/notifications/n'), { title: 'hack' }));
  });
  it('audit_logs: không ai (kể cả admin) truy cập từ client', async () => {
    await assertFails(getDoc(doc(adminDb(), 'audit_logs/a'))); await assertFails(deleteDoc(doc(adminDb(), 'audit_logs/a')));
  });
});
