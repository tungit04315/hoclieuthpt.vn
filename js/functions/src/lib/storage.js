'use strict';
const { admin } = require('./common');

const bucket = () => admin.storage().bucket();
const TTL = () => Number(process.env.SIGNED_URL_TTL || 300);

/**
 * URL tải có hạn dùng (mặc định 5 phút). Production cần cấp role "Service Account Token Creator"
 * cho service account của Functions để ký URL (xem README). Emulator không ký được nên trả URL của Storage Emulator.
 */
async function signedUrl(path, downloadName) {
  if (process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
    const host = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
    return { url: `http://${host}/v0/b/${bucket().name}/o/${encodeURIComponent(path)}?alt=media`, expiresIn: TTL() };
  }
  const [url] = await bucket().file(path).getSignedUrl({
    version: 'v4', action: 'read', expires: Date.now() + TTL() * 1000,
    ...(downloadName ? { responseDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}` } : {}),
  });
  return { url, expiresIn: TTL() };
}
module.exports = { bucket, signedUrl };
