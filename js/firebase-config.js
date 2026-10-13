export const firebaseConfig = {
  apiKey: "AIzaSyBsD-F8J4Rq_kY8QMyuJyjMki1BRh2o4U8",
  authDomain: "thpt-9fa17.firebaseapp.com",
  projectId: "thpt-9fa17",
  storageBucket: "thpt-9fa17.firebasestorage.app",
  messagingSenderId: "557952378082",
  appId: "1:557952378082:web:54ea6f3047baa479db2abb",
  measurementId: "G-GV9LJXJBTG"
};
export const REGION = 'asia-southeast1';

// true  = dùng Firebase Emulator trên máy (cần chạy `firebase emulators:start`)
// false = dùng Firebase thật (cần bật Authentication, tạo tài khoản và deploy Functions)
const FORCE_EMULATOR = true;
export const USE_EMULATOR = FORCE_EMULATOR && (location.hostname === 'localhost' || location.hostname === '127.0.0.1');