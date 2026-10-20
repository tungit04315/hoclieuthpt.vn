// Chế độ DEMO (không cần Firebase). Muốn dùng Firebase thật, đổi thành: import { Api } from './firebase-api.js';
import { Api } from './mock-api.js';
import { initAssistant } from './ai-assistant.js';

/* ===== Tiện ích ===== */
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const icons = () => window.lucide && window.lucide.createIcons();
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = n => n >= 1000 ? (n / 1000).toFixed(1).replace('.0', '') + 'k' : String(n || 0);
const toDate = t => !t ? null : t.toDate ? t.toDate() : (t._seconds ?? t.seconds) != null ? new Date((t._seconds ?? t.seconds) * 1000) : new Date(t);
const fmtDate = t => { const d = toDate(t); return d && !isNaN(d) ? d.toLocaleDateString('vi-VN') : '—' };
const fmtDur = s => s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '';
const initial = n => (String(n || '?').trim().split(/\s+/).pop()[0] || '?').toUpperCase();
const ROLE = {STUDENT: 'Học sinh', TEACHER: 'Giáo viên', ADMIN: 'Quản trị viên'};

/* ===== Trạng thái ===== */
let me = null, current = null, stack = [], assistant = null, introCache = null, sortTitle = false, filters = {gradeId: '', subjectId: '', resourceTypeId: ''};
const saved = new Set(), items = new Map(), cat = {subjects: [], grades: [], resourceTypes: []};

/* ===== Toast + sheet ===== */
let tt;
const OK_RE = /^(Đã (?!hủy)|Đăng ký thành công|Đăng nhập thành công|Tìm thấy|Thành công)/;
/** kind: 'ok' (thành công) | 'err' (thất bại) | 'info'. Không truyền thì tự nhận diện thông báo thành công theo câu chữ. */
function toast(msg, kind) {
  const k = kind || (OK_RE.test(msg) ? 'ok' : 'info'), t = $('#toast');
  t.textContent = (k === 'ok' ? '✓ ' : k === 'err' ? '✕ ' : '') + msg; t.className = 'show ' + k; t.setAttribute('role', k === 'err' ? 'alert' : 'status');
  clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), k === 'err' ? 4000 : 2600);
}
function openSheet(html) { $('#sheet').innerHTML = html; $('#app').classList.add('open'); icons() }
function closeSheet() { $('#app').classList.remove('open') }
$('#sheetBg').onclick = closeSheet;
const fail = e => toast(!navigator.onLine ? 'Không có kết nối mạng, vui lòng kiểm tra và thử lại' : ((e && e.message) || 'Thao tác thất bại, vui lòng thử lại'), 'err');
// Lưới an toàn: lỗi không ai bắt cũng báo cho người dùng
window.addEventListener('unhandledrejection', e => { console.error(e.reason); fail(e.reason) });
window.addEventListener('offline', () => toast('Mất kết nối mạng', 'err'));
window.addEventListener('online', () => toast('Đã kết nối mạng trở lại', 'ok'));

/* ===== Điều hướng ===== */
const NAVS = ['home', 'search', 'library', 'loans', 'account'];
function go(id, back) {
  const cur = $('.screen.active');
  if (!back && cur && cur.id !== id) stack.push(cur.id);
  $$('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  $('#nav').classList.toggle('show', NAVS.includes(id) || id === 'detail');
  $$('#nav button').forEach(b => b.classList.toggle('on', b.dataset.go === id));
  if (id === 'library') renderLib();
  if (id === 'loans') renderLoans();
  if (id === 'account') { renderCard(); renderStats() }
  if (id === 'search' && !$('#results').children.length) runSearch();
  if (id === 'ai' && assistant) assistant.open();
  window.scrollTo(0, 0);
}
document.addEventListener('click', e => {
  const g = e.target.closest('[data-go]'); if (g) return go(g.dataset.go);
  if (e.target.closest('[data-back]')) return go(stack.pop() || 'home', true);
  if (e.target.closest('[data-logout]')) return logout();
  const t = e.target.closest('[data-toast]'); if (t) { e.preventDefault(); toast(t.dataset.toast) }
  if (e.target.closest('[data-act="notif"]')) showNotifs();
});

/* ===== Đăng nhập / đăng xuất ===== */
let entering = false;
async function doLogin() {
  const id = $('#acc').value.trim(), pw = $('#pw').value;
  mark('accBox', false); mark('pwBox', false);
  if (!id) { mark('accBox', true, 'Vui lòng nhập tài khoản'); $('#acc').focus() }
  if (!pw) { mark('pwBox', true, 'Vui lòng nhập mật khẩu'); if (id) $('#pw').focus() }
  if (!id || !pw) return toast('Vui lòng nhập tài khoản và mật khẩu', 'err');
  const b = $('#loginBtn'); b.disabled = true; b.textContent = 'Đang đăng nhập…';
  try { entering = true; await enter(await Api.login(id, pw)); toast('Đăng nhập thành công') }
  catch (e) { fail(e); mark('pwBox', true, (e && e.message) || 'Đăng nhập không thành công'); await Api.logout().catch(() => {}) }
  finally { entering = false; b.disabled = false; b.textContent = 'Đăng nhập' }
}
$('#loginForm').onsubmit = e => { e.preventDefault(); doLogin() };
// Dùng thử nhanh (chỉ hiện ở chế độ demo)
$('#demoBox').hidden = !Api.register;
$$('[data-demo]').forEach(b => b.onclick = () => { const [a, p] = b.dataset.demo.split('|'); $('#acc').value = a; $('#pw').value = p; mark('accBox', false); mark('pwBox', false); doLogin() });

async function enter(user) {
  me = user; stack = [];
  $('#accName').textContent = user.fullName || user.email || '—';
  $('#accSub').textContent = [ROLE[user.role], user.className && 'Lớp ' + user.className].filter(Boolean).join(' · ');
  $('#avBig').textContent = $('#avTop').textContent = initial(user.fullName);
  if (user.role === 'ADMIN') {
    setAdminHead(); go('admin'); const d = await loadAdmin();
    try { const st = Api.getSettings ? await Api.getSettings() : {}; if (d && d.pendingResources) { if (st.autoQueue) showQueue(); else if (st.notifyPending) toast(`Có ${d.pendingResources} tài liệu đang chờ duyệt`) } } catch {}
    return
  }
  if (user.role === 'TEACHER') { $('#tHello').textContent = 'Chào ' + (user.fullName || 'thầy/cô') + '!'; $('#tAv').textContent = initial(user.fullName); go('teacher'); loadTeacher(); return }
  await loadCatalogs(); await loadHome(); go('home');
}
async function logout() {
  try { await Api.logout() } catch (e) { return fail(e) }
  me = null; stack = []; saved.clear(); items.clear(); introCache = null; assistant && assistant.reset(); homeTab('over');
  $('#results').innerHTML = ''; $('#pw').value = ''; filters = {gradeId: '', subjectId: '', resourceTypeId: ''};
  go('login'); toast('Đã đăng xuất');
}
/* ===== Đăng ký (đơn giản: Email/SĐT + mật khẩu, không OTP, không cần duyệt) ===== */
$$('[data-eye]').forEach(b => b.onclick = () => {
  const p = $('#' + b.dataset.eye), show = p.type === 'password'; p.type = show ? 'text' : 'password';
  b.setAttribute('aria-pressed', show); b.setAttribute('aria-label', show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'); b.innerHTML = `<i data-lucide="${show ? 'eye-off' : 'eye'}"></i>`; icons(); p.focus();
});
const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
const isPhone = v => /^(0|\+?84)(3|5|7|8|9)\d{8}$/.test(v.replace(/[\s.-]/g, ''));
const mark = (box, bad, msg) => {
  $('#' + box).classList.toggle('bad', !!bad);
  const e = $('#' + box + 'Err'); if (e) { e.textContent = bad && msg ? msg : ''; e.hidden = !(bad && msg) }
  const i = $('input', $('#' + box)); if (i) i.setAttribute('aria-invalid', !!bad);
};
['regAcc', 'regPw', 'regPw2', 'acc', 'pw'].forEach(id => $('#' + id).addEventListener('input', () => mark(id + 'Box', false)));
// Thanh đo độ mạnh mật khẩu + cảnh báo Caps Lock
$('#regPw').addEventListener('input', () => {
  const v = $('#regPw').value, sc = !v ? 0 : Math.min(4, (v.length >= 6) + (v.length >= 10) + (/[a-z]/.test(v) && /[A-Z]/.test(v)) + (/\d/.test(v) && /[^A-Za-z0-9]/.test(v)) + (v.length < 6 ? -1 : 0)), m = $('#pwMeter');
  m.hidden = !v; m.dataset.s = Math.max(1, sc); $('#pwMeterTxt').textContent = ['', 'Yếu', 'Trung bình', 'Khá', 'Mạnh'][Math.max(1, sc)];
});
$('#pw').addEventListener('keyup', e => { if (e.getModifierState) $('#capsWarn').hidden = !e.getModifierState('CapsLock') });
$('#pw').addEventListener('blur', () => $('#capsWarn').hidden = true);
async function doRegister() {
  const acc = $('#regAcc').value.trim(), pw = $('#regPw').value, pw2 = $('#regPw2').value;
  ['regAccBox', 'regPwBox', 'regPw2Box'].forEach(b => mark(b, false));
  if (!acc) return mark('regAccBox', true, 'Vui lòng nhập Email hoặc Số điện thoại'), toast('Vui lòng nhập Email hoặc Số điện thoại', 'err');
  if (!isEmail(acc) && !isPhone(acc)) return mark('regAccBox', true, 'Email hoặc số điện thoại không hợp lệ'), toast('Email hoặc số điện thoại không hợp lệ', 'err');
  if (pw.length < 6) return mark('regPwBox', true, 'Mật khẩu phải có ít nhất 6 ký tự'), toast('Mật khẩu phải có ít nhất 6 ký tự', 'err');
  if (pw !== pw2) return mark('regPw2Box', true, 'Mật khẩu nhập lại không khớp'), toast('Mật khẩu nhập lại không khớp', 'err');
  if (!Api.register) return toast('Chế độ Firebase chưa hỗ trợ đăng ký — hãy dùng chế độ demo (mock-api.js)');
  const b = $('#regBtn'); b.disabled = true; b.textContent = 'Đang tạo tài khoản…';
  try { entering = true; const u = await Api.register({identifier: acc, password: pw}); toast('Đăng ký thành công!'); await enter(u) }
  catch (e) { fail(e); await Api.logout().catch(() => {}) }
  finally { entering = false; b.disabled = false; b.textContent = 'Đăng ký' }
}
$('#regForm').onsubmit = e => { e.preventDefault(); doRegister() };
// xóa dữ liệu form đăng ký khi quay lại đăng nhập
document.addEventListener('click', e => { if (e.target.closest('[data-go="login"]')) { ['regAcc', 'regPw', 'regPw2'].forEach(i => { $('#' + i).value = ''; mark(i + 'Box', false) }); $('#pwMeter').hidden = true } });
// Link dạng <a> điều hướng được bằng bàn phím
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('a[data-go]')) e.target.click() });

/* ===== Mượn / Trả sách (quy định: tối đa 3 cuốn, 14 ngày, gia hạn 1 lần +7 ngày) ===== */
let ltab = 'cur', lt;
$$('#loans .tabs button').forEach(b => b.onclick = () => { ltab = b.dataset.ltab; $$('#loans .tabs button').forEach(x => x.classList.toggle('on', x === b)); renderLoans() });
$('#bookQ').addEventListener('input', () => { clearTimeout(lt); lt = setTimeout(renderLoans, 250) });
const dueInfo = l => { const d = Math.ceil((new Date(l.dueDate) - Date.now()) / 864e5); return d < 0 ? `<span class="badge red">Quá hạn ${-d} ngày</span>` : `<span class="badge ${d <= 2 ? 'org' : 'grn'}">Còn ${d} ngày · hạn ${fmtDate(l.dueDate)}</span>` };
const bookRow = (b, right) => `<div class="book"><span class="bcover" style="background:${b.color}">${esc(initial(b.title))}</span><div><h4>${esc(b.title)}</h4><p class="cap">${esc(b.author)} · ${esc(b.category)}</p><div class="act">${right}</div></div></div>`;
async function renderLoans() {
  const box = $('#loanList'), mine = ltab, find = mine === 'find';
  $('#bookQBox').hidden = !find;
  if (!Api.loans) { $('#loanSum').textContent = ''; return box.innerHTML = '<p class="empty">Mượn/trả sách chỉ có ở chế độ demo (mock-api.js).</p>' }
  box.innerHTML = '<p class="empty">Đang tải…</p>';
  try {
    let html = '', sum = '';
    if (find) {
      const bs = await Api.books({q: $('#bookQ').value});
      html = bs.map(b => bookRow(b, `<span class="cap">Còn ${b.available}/${b.copies} cuốn</span><button class="mini" data-borrow="${b.id}" ${b.available ? '' : 'disabled'}>Mượn</button>`)).join('');
    } else {
      const all = await Api.loans(), cur = all.filter(l => l.status === 'BORROWING');
      const ls = mine === 'cur' ? cur : all.filter(l => l.status === 'RETURNED');
      if (mine === 'cur') sum = `Đang mượn ${cur.length}/3 cuốn`;
      html = ls.map(l => bookRow(l, mine === 'cur'
        ? `${dueInfo(l)}<button class="mini line" data-renew="${l.id}" ${l.renewCount ? 'disabled' : ''}>Gia hạn</button><button class="mini" data-return="${l.id}">Trả sách</button>`
        : `<span class="cap">Mượn ${fmtDate(l.borrowedAt)} · Đã trả ${fmtDate(l.returnedAt)}</span>`)).join('');
    }
    if (mine !== ltab) return;
    $('#loanSum').textContent = sum;
    box.innerHTML = html || `<p class="empty">${find ? 'Không tìm thấy sách phù hợp' : mine === 'cur' ? 'Bạn chưa mượn cuốn nào. Vào tab "Mượn sách" để chọn sách.' : 'Chưa có lịch sử mượn trả'}</p>`;
  } catch (e) { box.innerHTML = ''; fail(e) }
}
$('#loanList').addEventListener('click', async e => {
  const b = e.target.closest('[data-borrow],[data-return],[data-renew]'); if (!b) return;
  const act = b.dataset.borrow ? 'borrow' : b.dataset.return ? 'returnBook' : 'renew'; b.disabled = true;
  try { toast((await Api[act](b.dataset.borrow || b.dataset.return || b.dataset.renew)).message) } catch (er) { fail(er) }
  renderLoans();
});

/* ===== Thẻ thư viện ===== */
async function renderCard() {
  const c = $('#libCard'); c.hidden = !me || me.role !== 'STUDENT'; if (c.hidden) return;
  $('#cardName').textContent = me.fullName || me.email;
  $('#cardCls').textContent = [me.className && 'Lớp ' + me.className, me.school].filter(Boolean).join(' · ') || 'Học sinh';
  $('#cardNo').textContent = me.studentCode || 'TV' + String(me.id).replace(/\W/g, '').slice(-6).toUpperCase();
  $('#cardExp').textContent = '31/05/2027';
  try {
    if (!Api.loans) return;
    const cur = (await Api.loans()).filter(l => l.status === 'BORROWING'), od = cur.filter(l => new Date(l.dueDate) < Date.now()).length;
    $('#cardStat').textContent = `Đang mượn ${cur.length}/3 cuốn` + (od ? ` · ${od} cuốn quá hạn` : '');
  } catch {}
}

/* ===== Quản lý tài khoản ===== */
async function renderStats() {
  const box = $('#accStats'); box.hidden = !me || me.role !== 'STUDENT' || !Api.accountStats; if (box.hidden) return;
  try {
    const t = await Api.accountStats(), cell = (n, l, w) => `<div class="stat${w && n ? ' warn' : ''}"><b>${n}</b><span>${l}</span></div>`;
    box.innerHTML = cell(t.borrowing, 'Đang mượn') + cell(t.overdue, 'Quá hạn', 1) + cell(t.saved, 'Đã lưu') + cell(t.viewed, 'Đã xem');
  } catch {}
}
const fld = (id, icon, ph, type = 'text', val = '', ac = 'off') => `<div class="field"><i data-lucide="${icon}"></i><input id="${id}" type="${type}" value="${esc(val)}" placeholder="${ph}" autocomplete="${ac}" aria-label="${ph}"></div>`;
const sheetBtn = (id, t) => `<button class="btn" id="${id}">${t}</button>`;
async function busy(btn, label, fn) {
  const old = btn.textContent; btn.disabled = true; btn.textContent = label;
  try { await fn() } catch (e) { fail(e) } finally { btn.disabled = false; btn.textContent = old }
}
function profileSheet() {
  openSheet('<h3>Thông tin cá nhân</h3>' + fld('pfName', 'user', 'Họ và tên', 'text', me.fullName, 'name') + fld('pfPhone', 'phone', 'Số điện thoại', 'tel', me.phone || '', 'tel') + fld('pfMail', 'mail', 'Email', 'email', me.email || '', 'email')
    + (me.role === 'STUDENT' ? fld('pfClass', 'book-open', 'Lớp (ví dụ 10A1)', 'text', me.className || '') : '') + (me.role !== 'ADMIN' ? fld('pfSchool', 'landmark', 'Trường', 'text', me.school || '') : '') + sheetBtn('pfSave', 'Lưu thay đổi'));
  $('#pfSave').onclick = e => busy(e.target, 'Đang lưu…', async () => {
    const u = await Api.updateProfile({fullName: $('#pfName').value, phone: $('#pfPhone').value, email: $('#pfMail').value, className: $('#pfClass') ? $('#pfClass').value : undefined, school: $('#pfSchool') ? $('#pfSchool').value : undefined});
    me = {...me, ...u}; closeSheet(); $('#accName').textContent = me.fullName; $('#accSub').textContent = [ROLE[me.role], me.className && 'Lớp ' + me.className].filter(Boolean).join(' · '); $('#avBig').textContent = $('#avTop').textContent = initial(me.fullName); renderCard(); setAdminHead(); toast('Đã lưu thông tin');
  });
}
function passwordSheet() {
  openSheet('<h3>Đổi mật khẩu</h3>' + fld('pwOld', 'lock', 'Mật khẩu hiện tại', 'password', '', 'current-password') + fld('pwNew', 'lock', 'Mật khẩu mới (tối thiểu 6 ký tự)', 'password', '', 'new-password') + fld('pwNew2', 'lock', 'Nhập lại mật khẩu mới', 'password', '', 'new-password') + sheetBtn('pwSave', 'Đổi mật khẩu'));
  $('#pwSave').onclick = e => {
    const o = $('#pwOld').value, n = $('#pwNew').value;
    if (!o || !n) return toast('Vui lòng nhập đủ mật khẩu hiện tại và mật khẩu mới');
    if (n.length < 6) return toast('Mật khẩu mới phải có ít nhất 6 ký tự');
    if (n !== $('#pwNew2').value) return toast('Mật khẩu nhập lại không khớp');
    if (!Api.changePassword) return toast('Đổi mật khẩu chưa hỗ trợ ở chế độ Firebase');
    busy(e.target, 'Đang đổi…', async () => { const r = await Api.changePassword(o, n); closeSheet(); toast(r.message) });
  };
}
async function settingsSheet() {
  if (!Api.getSettings) return toast('Cài đặt chỉ có ở chế độ demo');
  let st; try { st = await Api.getSettings() } catch (e) { return fail(e) }
  openSheet(`<h3>Cài đặt nhắc nhở</h3><label class="chk"><input type="checkbox" id="stRemind" ${st.remind ? 'checked' : ''}> Nhắc trước hạn trả sách 2 ngày</label><label class="chk"><input type="checkbox" id="stNotify" ${st.notify ? 'checked' : ''}> Nhận thông báo học liệu mới</label>`);
  $$('#sheet input').forEach(i => i.onchange = () => Api.saveSettings({remind: $('#stRemind').checked, notify: $('#stNotify').checked}).then(() => toast('Đã lưu cài đặt'), fail));
}
const helpSheet = () => openSheet('<h3>Quy định mượn sách</h3><p class="hint">• Mỗi bạn mượn tối đa 3 cuốn cùng lúc.<br>• Thời hạn mượn 14 ngày, gia hạn 1 lần thêm 7 ngày.<br>• Sách quá hạn không thể gia hạn và bạn cần trả trước khi mượn thêm.<br>• Làm mất hoặc hư hỏng sách, vui lòng liên hệ thủ thư để được hướng dẫn.<br>• Thẻ thư viện dùng cho cả mượn sách giấy và học liệu số.</p>');
const openTab = (scr, tabAttr, val) => { go(scr); const b = $(`#${scr} [${tabAttr}="${val}"]`); b && b.click() };
$('#accMenu').addEventListener('click', e => {
  const b = e.target.closest('[data-acc]'); if (!b || !me) return;
  ({profile: profileSheet, password: passwordSheet, settings: settingsSheet, help: helpSheet, notif: showNotifs,
    loans: () => openTab('loans', 'data-ltab', 'cur'), history: () => openTab('loans', 'data-ltab', 'his'), saved: () => openTab('library', 'data-tab', 'fav')})[b.dataset.acc]();
});

let booted = false;
Api.onAuth(async u => {
  if (booted) return; booted = true;
  if (u && !entering) { try { await enter(await Api.me()) } catch (e) { fail(e); Api.logout().catch(() => {}) } }
});

/* ===== Component học liệu ===== */
const kindOf = r => {
  const f = `${r.fileFormat || ''} ${r.resourceType?.code || ''} ${r.resourceType?.name || ''}`.toLowerCase();
  return /mp4|video|webm|mov/.test(f) ? 'Video' : /pdf/.test(f) ? 'PDF' : 'DOC';
};
const remember = list => list.forEach(r => { items.set(r.id, r); r.isFavorite ? saved.add(r.id) : saved.delete(r.id) });
const thumb = r => `<div class="thumb t-${kindOf(r)}"><i data-lucide="${kindOf(r) === 'Video' ? 'play' : 'file-text'}"></i></div>`;
const tags = r => `<span class="tag s">${esc(r.subject?.name)}</span><span class="tag">Khối ${esc(r.grade?.name)}</span><span class="tag ${kindOf(r) === 'Video' ? 'v' : ''}">${kindOf(r)}</span>`;
const bmBtn = r => `<button class="bm ${saved.has(r.id) ? 'on' : ''}" data-bm="${esc(r.id)}" aria-label="Lưu vào tủ sách"><i data-lucide="bookmark"></i></button>`;
const cardHtml = r => `<button class="card" data-open="${esc(r.id)}">${thumb(r)}<div style="margin-top:6px">${tags(r)}</div><h4>${esc(r.title)}</h4><span class="views"><i data-lucide="eye"></i>${num(r.viewCount)}</span></button>`;

/* ===== Danh mục + Trang chủ ===== */
async function loadCatalogs() {
  const [subjects, grades, resourceTypes] = await Promise.all(['subjects', 'grades', 'resourceTypes'].map(n => Api.catalog(n).catch(() => [])));
  Object.assign(cat, {subjects, grades: grades.sort((a, b) => a.name - b.name), resourceTypes});
}
async function loadHome() {
  try {
    const h = await Api.home();
    $('#greet').textContent = h.greeting; $('#greetSub').textContent = h.subtitle;
    const n = h.user.unreadNotifications; $('#unread').hidden = !n; $('#unread').textContent = n;
    const list = (h.recommended.length ? h.recommended : h.latest).slice(0, 4); remember([...list, ...h.popular, ...h.latest]);
    $('#homeGrid').innerHTML = list.map(cardHtml).join('') || '<p class="empty" style="grid-column:1/-1">Chưa có học liệu nào.</p>';
    $('#gradeChips').innerHTML = h.grades.map(g => `<button class="chip" data-g="${esc(g.id)}">Khối ${esc(g.name)}</button>`).join('');
    $$('#gradeChips .chip').forEach(c => c.onclick = () => { filters = {gradeId: c.dataset.g, subjectId: '', resourceTypeId: ''}; $('#results').innerHTML = ''; go('search') });
    introCache = h.introduction; renderIntro(h.introduction); renderGuide(h.guide); dueBanner();
    icons();
  } catch (e) { fail(e) }
}

/* ===== Trang chủ: tab Tổng quan / Giới thiệu / Hướng dẫn, liên kết nhanh ===== */
function homeTab(name) {
  $$('#homeTabs button').forEach(b => b.classList.toggle('on', b.dataset.htab === name));
  [['over', '#hpOver'], ['intro', '#hpIntro'], ['guide', '#hpGuide']].forEach(([k, id]) => $(id).hidden = k !== name);
  window.scrollTo(0, 0);
}
$$('#homeTabs button').forEach(b => b.onclick = () => homeTab(b.dataset.htab));
document.addEventListener('click', e => { const g = e.target.closest('[data-hgo]'); if (g) homeTab(g.dataset.hgo) });
function renderIntro(i) {
  const box = $('#hpIntro'); if (!i) return box.innerHTML = '<p class="empty">Chưa có nội dung giới thiệu.</p>';
  const row = (ic, t) => `<div class="irow"><i data-lucide="${ic}"></i><span>${t}</span></div>`;
  box.innerHTML = `<div class="hero"><i data-lucide="landmark"></i><h3>${esc(i.school)}</h3><p>${esc(i.tagline)}</p></div><p class="ptxt">${esc(i.about)}</p>
    <div class="stats" style="grid-template-columns:repeat(${Math.max(1, (i.stats || []).length)},1fr)">${(i.stats || []).map(s => `<div class="stat"><b>${num(s.n)}</b><span>${esc(s.l)}</span></div>`).join('')}</div>
    <h3 class="sub">Giờ mở cửa</h3>${(i.hours || []).map(h => row('clock', esc(h))).join('')}
    <h3 class="sub">Liên hệ</h3>${row('map-pin', esc(i.address))}${row('phone', `<a href="tel:${esc(String(i.phone).replace(/\s/g, ''))}">${esc(i.phone)}</a>`)}${row('mail', `<a href="mailto:${esc(i.email)}">${esc(i.email)}</a>`)}
    <h3 class="sub">Nội quy thư viện</h3><ul class="rules">${(i.rules || []).map(r => `<li>${esc(r)}</li>`).join('')}</ul>`;
}
function renderGuide(g) {
  $('#hpGuide').innerHTML = (g && g.length) ? g.map((x, k) => `<details class="gd" ${k ? '' : 'open'}><summary>${esc(x.title)}</summary><p>${esc(x.body)}</p>${x.go ? `<button class="mini" data-go="${esc(x.go)}">${esc(x.cta || 'Mở')}</button>` : ''}</details>`).join('') : '<p class="empty">Chưa có nội dung hướng dẫn.</p>';
}
async function dueBanner() {
  const b = $('#dueBanner'); b.hidden = true; if (!Api.loans) return;
  try {
    const st = Api.getSettings ? await Api.getSettings() : {}, cur = (await Api.loans()).filter(l => l.status === 'BORROWING');
    const od = cur.filter(l => new Date(l.dueDate) < Date.now()).length, soon = cur.filter(l => { const d = (new Date(l.dueDate) - Date.now()) / 864e5; return d >= 0 && d <= 2 }).length;
    if (od) { b.className = 'alert red'; b.textContent = `Bạn có ${od} cuốn sách quá hạn. Hãy trả sớm nhé ›`; b.hidden = false }
    else if (soon && st.remind !== false) { b.className = 'alert'; b.textContent = `${soon} cuốn sách sắp đến hạn trả trong 2 ngày ›`; b.hidden = false }
  } catch {}
}

/* ===== Thông báo ===== */
async function showNotifs() {
  try {
    const list = await Api.notifications(30);
    openSheet('<h3>Thông báo</h3>' + (list.map(n => `<div class="note"><i data-lucide="${n.isRead ? 'check-circle' : 'bell'}"></i><div><b>${esc(n.title)}</b><br>${esc(n.message)}<p class="cap">${fmtDate(n.createdAt)}</p></div></div>`).join('') || '<p class="empty">Chưa có thông báo.</p>'));
    if (list.some(n => !n.isRead)) { await Api.markAllRead(); $('#unread').hidden = true }
  } catch (e) { fail(e) }
}

/* ===== Tìm kiếm ===== */
let sTok = 0, userSearch = false;
async function runSearch(byUser) {
  userSearch = byUser === true;
  const tok = ++sTok, q = $('#q').value.trim();
  $('#aiCard').innerHTML = '<span class="ai"><i data-lucide="search"></i></span><div><b>Đang tìm kiếm…</b><br><span class="dots"><i></i><i></i><i></i></span></div>'; icons();
  $('#results').innerHTML = '';
  const active = Object.fromEntries(Object.entries(filters).filter(([, v]) => v));
  $('#fcount').textContent = Object.keys(active).length;
  try {
    const res = await Api.search({q, ...active, sort: sortTitle ? 'title' : q ? 'relevance' : 'newest', limit: 30});
    if (tok !== sTok) return;
    remember(res.items);
    const name = (list, id) => list.find(x => x.id === id)?.name;
    const chips = [q && `Từ khóa: ${q}`, active.subjectId && `Môn: ${name(cat.subjects, active.subjectId)}`, active.gradeId && `Khối: ${name(cat.grades, active.gradeId)}`, active.resourceTypeId && `Loại: ${name(cat.resourceTypes, active.resourceTypeId)}`].filter(Boolean);
    $('#aiCard').innerHTML = `<span class="ai"><i data-lucide="search"></i></span><div><b>Tìm thấy ${res.pagination.total} học liệu</b>${chips.length ? `<div style="margin-top:6px">${chips.map(x => `<span class="tag">${esc(x)}</span>`).join('')}</div>` : ''}</div>`;
    $('#results').innerHTML = res.items.map(r => `<div class="res" data-open="${esc(r.id)}">${thumb(r)}<div><h4>${esc(r.title)}</h4><div>${tags(r)}</div><p>${esc(r.summary)}</p><div class="act"><button class="sm-btn" data-open="${esc(r.id)}">Xem</button>${bmBtn(r)}</div></div></div>`).join('') || '<p class="empty">Không tìm thấy học liệu phù hợp. Hãy thử đổi từ khóa hoặc bỏ bớt bộ lọc.</p>';
    icons(); if (userSearch) toast(`Tìm thấy ${res.pagination.total} học liệu`);
  } catch (e) { if (tok !== sTok) return; fail(e); $('#aiCard').innerHTML = `<span class="ai"><i data-lucide="alert-circle"></i></span><div><b>Không tìm kiếm được</b><p>${esc(e.message)}</p></div>`; icons() }
}
$('#q').addEventListener('keydown', e => e.key === 'Enter' && runSearch(true));
$('#sortBtn').onclick = () => { sortTitle = !sortTitle; toast(sortTitle ? 'Đã sắp xếp theo tên A–Z' : 'Đã sắp xếp theo mức phù hợp / mới nhất'); runSearch() };
$('#filterBtn').onclick = () => {
  const sel = (k, lab, list, label = x => x.name) => `<label>${lab}<select data-f="${k}"><option value="">Tất cả</option>${list.map(o => `<option value="${esc(o.id)}" ${filters[k] === o.id ? 'selected' : ''}>${esc(label(o))}</option>`).join('')}</select></label>`;
  openSheet(`<h3>Bộ lọc</h3>${sel('gradeId', 'Khối lớp', cat.grades, g => 'Khối ' + g.name)}${sel('subjectId', 'Môn học', cat.subjects)}${sel('resourceTypeId', 'Loại tài liệu', cat.resourceTypes)}<div class="two"><button class="btn alt" id="fReset">Đặt lại</button><button class="btn" id="fApply">Áp dụng</button></div>`);
  $('#fApply').onclick = () => { $$('#sheet [data-f]').forEach(s => filters[s.dataset.f] = s.value); closeSheet(); toast('Đã áp dụng bộ lọc'); runSearch() };
  $('#fReset').onclick = () => { filters = {gradeId: '', subjectId: '', resourceTypeId: ''}; closeSheet(); toast('Đã đặt lại bộ lọc'); runSearch() };
};

/* ===== Bookmark + mở chi tiết ===== */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-bm]');
  if (b) { e.stopPropagation(); toggleSave(b.dataset.bm); return }
  const o = e.target.closest('[data-open]');
  if (o && !e.target.closest('[data-del]')) openDetail(o.dataset.open);
}, true);
function paintSave(id) {
  $$(`[data-bm="${id}"]`).forEach(x => x.classList.toggle('on', saved.has(id)));
  if (current === id) $('#dBm').classList.toggle('on', saved.has(id));
}
async function toggleSave(id) {
  const was = saved.has(id);
  was ? saved.delete(id) : saved.add(id); paintSave(id); // cập nhật ngay, lỗi thì hoàn lại
  try {
    await (was ? Api.removeBookmark(id) : Api.addBookmark(id));
    toast(was ? 'Đã bỏ khỏi tủ sách' : 'Đã lưu vào tủ sách');
    if ($('#library').classList.contains('active')) renderLib();
  } catch (e) { was ? saved.add(id) : saved.delete(id); paintSave(id); fail(e) }
}

/* ===== Chi tiết ===== */
const isYoutube = v => { try { const u = new URL(v); return /^https?:$/.test(u.protocol) && /^(www\.|m\.|music\.)?(youtube\.com|youtube-nocookie\.com|youtu\.be)$/i.test(u.hostname) } catch { return false } };
// Tương thích dữ liệu cũ: học liệu cũ chỉ có onlineUrl (có thể là link YouTube)
const videoLink = r => r.videoUrl || (isYoutube(r.onlineUrl) ? r.onlineUrl : '');
const docLink = r => (r.onlineUrl && r.onlineUrl !== videoLink(r)) ? r.onlineUrl : '';
function openLink(url, msg) { window.open(url, '_blank', 'noopener'); toast(msg) }
async function fetchFile(r, file, btn) {
  const old = btn && btn.innerHTML; if (btn) { btn.disabled = true; btn.textContent = 'Đang tạo liên kết…' }
  try {
    const d = await Api.download(r.id, file.id);
    const a = document.createElement('a'); a.href = d.url; a.download = d.fileName || file.name; a.target = '_blank'; a.rel = 'noopener'; a.click();
    toast('Đã bắt đầu tải xuống');
  } catch (e) { fail(e) } finally { if (btn) { btn.disabled = false; btn.innerHTML = old; icons() } }
}
function withFile(r, btn) {
  const files = r.files || [];
  if (!files.length) return toast('Học liệu này chưa có tệp đính kèm');
  if (files.length === 1) return fetchFile(r, files[0], btn);
  openSheet('<h3>Chọn tệp</h3>' + files.map((f, i) => `<button class="menu" data-file="${i}">${esc(f.name)}</button>`).join(''));
  $$('#sheet [data-file]').forEach(b => b.onclick = () => { closeSheet(); fetchFile(r, files[+b.dataset.file], btn) });
}
async function openDetail(id) {
  let r; try { r = await Api.resource(id) } catch (e) { return fail(e) }
  current = id; items.set(id, r); r.isFavorite ? saved.add(id) : saved.delete(id);
  const k = kindOf(r), dur = fmtDur(r.durationSeconds), vUrl = videoLink(r), dUrl = docLink(r);
  const row = (i, key, v) => `<div><i data-lucide="${i}"></i><dt>${key}</dt><dd>${esc(v)}</dd></div>`;
  $('#detailBody').innerHTML = `<div class="hero t-${k}">${k === 'Video' ? `<span class="play"><i data-lucide="play"></i></span>${dur ? `<span class="dur">${dur}</span>` : ''}` : '<i data-lucide="file-text"></i>'}</div>
  <h2>${esc(r.title)}</h2><dl class="info">${row('user', 'Tác giả', r.author)}${row('book-open', 'Môn học', r.subject?.name)}${row('graduation-cap', 'Khối lớp', r.grade?.name)}${row('tag', 'Chủ đề', r.topic?.name || '—')}${row('file', 'Loại tài liệu', r.resourceType?.name)}${row('calendar', 'Ngày cập nhật', fmtDate(r.updatedAt || r.publishedAt))}${row('file-video', 'Định dạng tài nguyên', r.fileFormat || '—')}${row('youtube', 'Link video YouTube', vUrl ? 'Có' : 'Không có')}${row('link', 'Link tài liệu', dUrl || (r.files || []).length ? 'Có' : 'Không có')}</dl>
  <h3>Mô tả</h3><p class="desc">${esc(r.description || r.summary || 'Chưa có mô tả.')}</p>
  <div class="dbtns"><button class="btn" id="view"><i data-lucide="play"></i>Xem học liệu</button><div class="two"><button class="btn alt dl" id="dl"><i data-lucide="download"></i>Tải xuống</button><button class="btn line" id="save"><i data-lucide="bookmark"></i>Lưu vào tủ sách</button></div></div>`;
  $('#dBm').classList.toggle('on', saved.has(id));
  $('#view').onclick = () => { // Xem học liệu -> mở link YouTube
    if (!vUrl) return toast('Học liệu này chưa có link video YouTube', 'info');
    Api.view(id).catch(() => {}); openLink(vUrl, 'Đã mở video YouTube');
  };
  $('#save').onclick = () => toggleSave(id);
  $('#dl').onclick = e => { // Tải xuống -> mở link tài liệu (dữ liệu cũ chỉ có tệp thì vẫn tải tệp)
    if (dUrl) return openLink(dUrl, 'Đã mở link tài liệu');
    if ((r.files || []).length) return withFile(r, e.currentTarget);
    toast('Học liệu này chưa có link tài liệu để tải xuống', 'info');
  };
  go('detail'); icons();
  Api.view(id).catch(() => {}); // ghi lượt xem (backend chống đếm trùng 30 phút)
}
$('#dBm').onclick = () => current && toggleSave(current);

/* ===== Tủ sách ===== */
let tab = 'all';
$$('#library .tabs button').forEach(b => b.onclick = () => { tab = b.dataset.tab; $$('.tabs button').forEach(x => x.classList.toggle('on', x === b)); renderLib() });
async function renderLib() {
  const box = $('#libList'), mine = tab; box.innerHTML = '<p class="empty">Đang tải…</p>';
  try {
    const res = await (mine === 'fav' ? Api.bookmarks({limit: 50}) : mine === 'all' ? Api.search({sort: 'newest', limit: 50}) : Api.viewHistory({limit: 50}));
    if (mine !== tab) return;
    const list = res.items.map(x => mine === 'hist' ? {...x.resource, key: x.id} : {...x, key: x.id});
    remember(list);
    box.innerHTML = list.map(r => `<div class="lib">${thumb(r)}<div><h4>${esc(r.title)}</h4><p class="cap">${esc(r.subject?.name)} | Khối ${esc(r.grade?.name)} | ${kindOf(r)}</p><div class="act"><button class="sm-btn o" data-open="${esc(r.id)}">Mở</button><button class="del" data-del="${esc(r.key)}" aria-label="Xóa"><i data-lucide="trash-2"></i></button></div></div></div>`).join('')
      || `<p class="empty">${mine === 'fav' ? 'Chưa có học liệu nào. Hãy lưu học liệu để xem lại tại đây.' : 'Bạn chưa xem học liệu nào.'}</p>`;
    $$('[data-del]', box).forEach(b => b.onclick = async () => {
      try { mine === 'fav' ? await Api.removeBookmark(b.dataset.del) : await Api.deleteViewHistory(b.dataset.del); if (mine === 'fav') saved.delete(b.dataset.del); toast('Đã xóa khỏi danh sách'); renderLib() } catch (e) { fail(e) }
    });
    icons();
  } catch (e) { box.innerHTML = `<p class="empty">${esc(e.message)}</p>`; fail(e) }
}

/* ===== Quản trị ===== */
async function loadAdmin() {
  try {
    const d = await Api.admin.dashboard({});
    $('#aTotal').textContent = d.totalResources.toLocaleString('en-US');
    $('#aUsers').textContent = (d.totalStudents + d.totalTeachers + (d.totalAdmins || 0)).toLocaleString('en-US');
    $('#aPending').textContent = d.pendingResources;
    $('#aViews').textContent = num(d.totalViews);
    $('#aQ').hidden = !d.pendingResources; $('#aQ').textContent = d.pendingResources;
    loadReqBadge();
    return d;
  } catch (e) { fail(e) }
}
async function showQueue() {
  try {
    const q = await Api.admin.moderationQueue({});
    openSheet('<h3>Kiểm duyệt tài liệu</h3>' + (q.items.map(r => `<div class="note"><div style="flex:1;min-width:0"><b>${esc(r.title)}</b><p class="cap">${esc(r.author)} · ${esc(r.subject)} · Khối ${esc(r.grade)}</p>
      <p class="cap">${r.hasVideo ? '▶ Có video YouTube' : 'Không có video'} · ${r.hasUrl || r.fileCount ? 'Có link tài liệu' : 'Chưa có link tài liệu'}</p>
      <div class="three"><button class="mini line" data-qv="${esc(r.id)}">Xem chi tiết</button><button class="mini line red" data-rej="${esc(r.id)}">Từ chối</button><button class="mini" data-ok="${esc(r.id)}">Duyệt</button></div></div></div>`).join('') || '<p class="empty">Không có tài liệu chờ duyệt.</p>'));
    $$('#sheet [data-qv]').forEach(b => b.onclick = () => docDetail(b.dataset.qv, showQueue));
    $$('#sheet [data-ok]').forEach(b => b.onclick = () => approveDoc(b.dataset.ok, showQueue));
    $$('#sheet [data-rej]').forEach(b => b.onclick = () => rejectDoc(b.dataset.rej, showQueue));
  } catch (e) { fail(e) }
}
const approveDoc = (id, back) => decide(() => Api.admin.approve({id}), 'Đã duyệt tài liệu', back);
function rejectDoc(id, back) {
  const raw = prompt('Lý do từ chối (tối thiểu 5 ký tự):'); if (raw === null) return toast('Đã hủy, tài liệu chưa bị từ chối');
  const reason = raw.trim(); if (reason.length < 5) return toast('Lý do từ chối cần tối thiểu 5 ký tự', 'err');
  return decide(() => Api.admin.reject({id, reason}), 'Đã từ chối tài liệu', back);
}
async function decide(fn, msg, back) { try { await fn(); toast(msg); loadAdmin(); back && back() } catch (e) { fail(e) } }
/* ===== Quản trị: tài khoản, tài liệu, danh mục, thống kê, nhật ký ===== */
const ADM = () => Api.admin && Api.admin.users ? Api.admin : (toast('Quản trị đầy đủ chỉ có ở chế độ demo (mock-api.js)'), null);
const RL = {STUDENT: 'Học sinh', TEACHER: 'Giáo viên', ADMIN: 'Quản trị'};
const RS = {PUBLISHED: ['Đang hiển thị', 'grn'], HIDDEN: ['Đã ẩn', 'org'], PENDING: ['Chờ duyệt', 'org'], REJECTED: ['Bị từ chối', 'red'], DRAFT: ['Bản nháp', 'org'], ARCHIVED: ['Lưu trữ', 'org']};
const searchBox = (ph, extra = '') => `<div class="field"><i data-lucide="search"></i><input id="aq" placeholder="${ph}" aria-label="${ph}"></div>${extra}<div id="aList"></div>`;
let aTimer;
const bindList = render => { $('#aq').oninput = () => { clearTimeout(aTimer); aTimer = setTimeout(render, 250) }; render() };
const doAdm = async (fn, again) => { try { const r = await fn(); toast((r && r.message) || 'Đã thực hiện thành công'); loadAdmin(); again && again(); return r } catch (e) { fail(e) } };
function setAdminHead() { if (me && me.role === 'ADMIN') { $('#admin .who h2').textContent = me.fullName || 'Quản trị viên'; $('#admin .avatar').textContent = initial(me.fullName) } }
async function adminSettings() {
  let st = {}; try { st = Api.getSettings ? await Api.getSettings() : {} } catch (e) { return fail(e) }
  const last = st.lastLogin ? new Date(st.lastLogin) : null;
  openSheet(`<h3>Cài đặt cá nhân</h3><p class="hint"><b>${esc(me.fullName)}</b> · ${esc(me.email || me.phone || '')}<br>Đăng nhập gần nhất: ${last ? last.toLocaleDateString('vi-VN') + ' ' + last.toLocaleTimeString('vi-VN') : 'đây là lần đăng nhập đầu tiên'}</p>
    <button class="menu" data-as="profile"><i data-lucide="user"></i>Thông tin cá nhân</button><button class="menu" data-as="password"><i data-lucide="lock"></i>Đổi mật khẩu</button>
    <label class="chk"><input type="checkbox" id="asPend" ${st.notifyPending !== false ? 'checked' : ''}> Nhắc khi có tài liệu chờ duyệt lúc đăng nhập</label>
    <label class="chk"><input type="checkbox" id="asAuto" ${st.autoQueue ? 'checked' : ''}> Tự mở mục Kiểm duyệt nếu có tài liệu chờ</label>
    <button class="menu" data-as="logout"><i data-lucide="log-out"></i>Đăng xuất</button>`);
  $$('#sheet input[type=checkbox]').forEach(i => i.onchange = () => Api.saveSettings ? Api.saveSettings({notifyPending: $('#asPend').checked, autoQueue: $('#asAuto').checked}).then(() => toast('Đã lưu cài đặt'), fail) : toast('Cài đặt chỉ có ở chế độ demo'));
  $$('#sheet [data-as]').forEach(b => b.onclick = () => ({profile: profileSheet, password: passwordSheet, logout: () => confirm('Đăng xuất khỏi trang quản trị?') ? (closeSheet(), logout()) : toast('Đã hủy đăng xuất')})[b.dataset.as]());
}
$('#aSet').onclick = adminSettings;

function usersSheet() {
  const A = ADM(); if (!A) return;
  openSheet('<h3>Quản lý tài khoản</h3>' + searchBox('Tìm tên, email, SĐT, mã HS…', `<div class="two"><select id="ar" aria-label="Vai trò"><option value="">Tất cả vai trò</option>${Object.entries(RL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select><button class="mini" id="aNew">+ Thêm</button></div>`));
  const render = async () => {
    try {
      const r = await A.users({q: $('#aq').value, role: $('#ar').value});
      $('#aList').innerHTML = r.items.map(u => `<div class="book"><div style="flex:1"><h4>${esc(u.fullName)}</h4><p class="cap">${esc(u.studentCode || u.email || u.phone || '')} · ${RL[u.role]}${u.className ? ' · Lớp ' + esc(u.className) : ''}</p>
        <div class="act"><span class="badge ${u.status === 'LOCKED' ? 'red' : 'grn'}">${u.status === 'LOCKED' ? 'Đã khóa' : 'Hoạt động'}</span><button class="mini line" data-lock="${u.id}" data-to="${u.status === 'LOCKED' ? 'ACTIVE' : 'LOCKED'}">${u.status === 'LOCKED' ? 'Mở khóa' : 'Khóa'}</button><button class="mini line" data-rp="${u.id}">Đặt lại MK</button>
        <select data-role="${u.id}" aria-label="Vai trò">${Object.entries(RL).map(([k, v]) => `<option value="${k}" ${k === u.role ? 'selected' : ''}>${v}</option>`).join('')}</select></div></div></div>`).join('') || '<p class="empty">Không có tài khoản phù hợp</p>';
    } catch (e) { fail(e) }
  };
  bindList(render); $('#ar').onchange = render; $('#aNew').onclick = newUserSheet;
  $('#aList').onclick = async e => {
    const l = e.target.closest('[data-lock]'), r = e.target.closest('[data-rp]');
    if (l) await doAdm(() => A.setUserStatus(l.dataset.lock, l.dataset.to), render);
    if (r && !confirm('Đặt lại mật khẩu cho tài khoản này?')) toast('Đã hủy đặt lại mật khẩu');
    else if (r) { const x = await doAdm(() => A.resetPassword(r.dataset.rp)); if (x) { toast('Đã đặt lại mật khẩu'); prompt('Mật khẩu tạm (sao chép và gửi cho người dùng):', x.tempPassword) } }
  };
  $('#aList').onchange = e => { const s = e.target.closest('[data-role]'); if (s) doAdm(() => A.setUserRole(s.dataset.role, s.value), render).then(render) };
}
function newUserSheet() {
  const A = ADM(); if (!A) return;
  openSheet('<h3>Thêm tài khoản</h3>' + fld('nuName', 'user', 'Họ và tên', 'text', '', 'off') + fld('nuId', 'mail', 'Email hoặc số điện thoại') + `<div class="field"><select id="nuRole" aria-label="Vai trò" style="width:100%;border:0">${Object.entries(RL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>` + fld('nuPw', 'lock', 'Mật khẩu (tối thiểu 6 ký tự)', 'text') + sheetBtn('nuSave', 'Tạo tài khoản'));
  $('#nuSave').onclick = e => busy(e.target, 'Đang tạo…', async () => { const r = await A.createUser({fullName: $('#nuName').value, identifier: $('#nuId').value, role: $('#nuRole').value, password: $('#nuPw').value}); toast(r.message); loadAdmin(); usersSheet() });
}
function resSheet() {
  const A = ADM(); if (!A) return;
  openSheet('<h3>Quản lý tài liệu</h3>' + searchBox('Tìm tên, tác giả, môn học…', `<div class="two"><select id="as" aria-label="Trạng thái"><option value="">Mọi trạng thái</option>${Object.entries(RS).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join('')}</select><button class="mini" id="aNewDoc">+ Thêm tài liệu</button></div>`));
  const render = async () => {
    try {
      const r = await A.resources({q: $('#aq').value, status: $('#as').value});
      $('#aList').innerHTML = r.items.map(d => `<div class="book"><div style="flex:1;min-width:0"><h4>${esc(d.title)}</h4><p class="cap">${esc(d.author)} · ${esc(d.subject)} · Khối ${esc(d.grade)} · ${num(d.views)} lượt xem</p>
        <div class="act"><span class="badge ${(RS[d.status] || RS.DRAFT)[1]}">${(RS[d.status] || [d.status])[0]}</span><button class="mini line" data-det="${esc(d.id)}">Chi tiết</button><button class="mini line" data-edit="${esc(d.id)}">Sửa</button>${['PUBLISHED', 'HIDDEN'].includes(d.status) ? `<button class="mini line" data-vis="${esc(d.id)}" data-to="${d.status === 'HIDDEN' ? 1 : 0}">${d.status === 'HIDDEN' ? 'Hiện lại' : 'Ẩn'}</button>` : ''}<button class="mini line red" data-del="${esc(d.id)}">Xóa</button></div></div></div>`).join('') || '<p class="empty">Không có tài liệu phù hợp</p>';
    } catch (e) { fail(e) }
  };
  bindList(render); $('#as').onchange = render; $('#aNewDoc').onclick = () => docForm(null, resSheet, resSheet);
  $('#aList').onclick = e => {
    const v = e.target.closest('[data-vis]'), d = e.target.closest('[data-del]'), i = e.target.closest('[data-det]'), ed = e.target.closest('[data-edit]');
    if (i) docDetail(i.dataset.det, resSheet);
    if (ed) docForm(ed.dataset.edit, resSheet, resSheet);
    if (v) doAdm(() => A.setResourceVisible(v.dataset.vis, v.dataset.to === '1'), render);
    if (d) { if (confirm('Xóa tài liệu này? Học sinh sẽ không còn thấy tài liệu.')) doAdm(() => A.deleteResource(d.dataset.del), render); else toast('Đã hủy xóa tài liệu') }
  };
}
/** Xem chi tiết 1 tài liệu (dùng chung cho Kiểm duyệt và Quản lý tài liệu). `back` = hàm quay về danh sách đã mở. */
async function docDetail(id, back) {
  const A = ADM(); if (!A) return;
  let d; try { d = await A.resource(id) } catch (e) { return fail(e) }
  const st = RS[d.status] || RS.DRAFT, row = (k, v) => `<div class="drow"><span>${k}</span><b>${v}</b></div>`;
  const open = (u, label) => u && isUrl(u) ? `<button class="mini line" data-lnk="${esc(u)}">${label}</button>` : '<span class="cap">Chưa có</span>';
  openSheet(`<button class="mini line" id="ddBack">‹ Quay lại</button><h3 style="margin:10px 0 6px">${esc(d.title)}</h3><span class="badge ${st[1]}">${st[0]}</span>
    ${d.rejectReason ? `<p class="hint">Lý do từ chối: ${esc(d.rejectReason)}</p>` : ''}
    <div style="margin:8px 0">${row('Tác giả', esc(d.author))}${row('Môn học', esc(d.subject))}${row('Khối lớp', esc(d.grade))}${row('Chủ đề', esc(d.topic || '—'))}${row('Loại tài liệu', esc(d.type || '—'))}${row('Người đăng', esc(d.ownerName || '—'))}
      ${row('Lượt xem', num(d.views))}${row('Cập nhật', fmtDate(d.updatedAt))}${row('Link video YouTube', open(d.videoUrl, 'Mở video'))}${row('Link tài liệu', open(d.url, 'Mở tài liệu'))}
      ${row('Tệp đính kèm', (d.files || []).length ? (d.files || []).map(f => esc(f.name)).join(', ') : 'Không có')}</div>
    <h4 style="margin:10px 0 4px">Mô tả</h4><p class="desc">${esc(d.description || 'Chưa có mô tả.')}</p>
    ${d.status === 'PENDING' ? '<div class="two"><button class="btn alt red" id="ddRej">Từ chối</button><button class="btn" id="ddOk">Duyệt</button></div>' : ''}
    <div class="dbar"><button class="mini line" id="ddEdit">Sửa</button>${['PUBLISHED', 'HIDDEN'].includes(d.status) ? `<button class="mini line" id="ddVis">${d.status === 'HIDDEN' ? 'Hiện lại' : 'Ẩn'}</button>` : ''}<button class="mini line red" id="ddDel">Xóa</button></div>`);
  const again = () => docDetail(id, back);
  $$('#sheet [data-lnk]').forEach(b => b.onclick = () => openLink(b.dataset.lnk, 'Đã mở liên kết'));
  $('#ddBack').onclick = () => back && back();
  $('#ddEdit').onclick = () => docForm(id, again, again);
  if ($('#ddOk')) $('#ddOk').onclick = () => approveDoc(id, back);
  if ($('#ddRej')) $('#ddRej').onclick = () => rejectDoc(id, back);
  if ($('#ddVis')) $('#ddVis').onclick = () => doAdm(() => A.setResourceVisible(id, d.status === 'HIDDEN'), again);
  $('#ddDel').onclick = () => { if (confirm('Xóa tài liệu này? Học sinh sẽ không còn thấy tài liệu.')) doAdm(() => A.deleteResource(id), back); else toast('Đã hủy xóa tài liệu') };
}
/** Form thêm / sửa tài liệu của admin. id = null => thêm mới. */
async function docForm(id, done, cancel) {
  const A = ADM(); if (!A) return;
  if (!(cat.subjects || []).length) await loadCatalogs();
  let d = {title: '', author: '', subjectId: '', gradeId: '', resourceTypeId: '', topic: '', url: '', videoUrl: '', description: '', status: 'DRAFT'};
  if (id) { try { d = await A.resource(id) } catch (e) { return fail(e) } }
  const sel = (i, list, val, ph) => `<select id="${i}"><option value="">${ph}</option>${(list || []).map(x => `<option value="${esc(x.id)}" ${x.id === val ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`;
  const draftable = !id || d.status === 'DRAFT';
  openSheet(`<button class="mini line" id="dfBack">‹ Quay lại</button><h3 style="margin:10px 0 8px">${id ? 'Sửa tài liệu' : 'Thêm tài liệu'}</h3>`
    + lbl('Tên tài liệu *', cin('dfTitle', d.title, 'VD: Hàm số bậc hai và đồ thị parabol', 200)) + lbl('Tác giả *', cin('dfAuthor', d.author, 'VD: Cô Lan Anh', 120))
    + `<div class="two2">${lbl('Môn học *', sel('dfSubject', cat.subjects, d.subjectId, 'Chọn môn'))}${lbl('Khối lớp *', sel('dfGrade', cat.grades, d.gradeId, 'Chọn khối'))}</div>`
    + lbl('Loại tài liệu *', sel('dfType', cat.resourceTypes, d.resourceTypeId, 'Chọn loại')) + lbl('Chủ đề', cin('dfTopic', d.topic, 'VD: Hàm số, Vòng lặp…', 100))
    + lbl('Link video YouTube (không bắt buộc)', cin('dfVideo', d.videoUrl, 'https://www.youtube.com/watch?v=…', 1000)) + '<p class="cap" style="margin:-4px 0 8px">Học sinh bấm "Xem học liệu" sẽ mở link này.</p>'
    + lbl('Link tài liệu *', cin('dfUrl', d.url, 'https://…', 1000)) + '<p class="cap" style="margin:-4px 0 8px">Học sinh bấm "Tải xuống" sẽ mở link này.</p>'
    + lbl('Mô tả', cta('dfDesc', d.description, 4, 5000))
    + (draftable ? '<div class="two"><button class="btn alt" id="dfDraft">Lưu nháp</button><button class="btn" id="dfPub">Đăng ngay</button></div>' : '<button class="btn" id="dfSave">Lưu thay đổi</button>'));
  const submit = (btn, publish) => {
    const v = {title: $('#dfTitle').value.trim(), author: $('#dfAuthor').value.trim(), subjectId: $('#dfSubject').value, gradeId: $('#dfGrade').value, resourceTypeId: $('#dfType').value,
      topic: $('#dfTopic').value.trim(), url: $('#dfUrl').value.trim(), videoUrl: $('#dfVideo').value.trim(), description: $('#dfDesc').value.trim(), publish};
    if (v.title.length < 3) return toast('Tên tài liệu phải có ít nhất 3 ký tự', 'err');
    if (v.url && !isUrl(v.url)) return toast('Link tài liệu phải bắt đầu bằng http:// hoặc https://', 'err');
    if (v.videoUrl && !isYoutube(v.videoUrl)) return toast('Link video phải là đường dẫn YouTube hợp lệ (youtube.com hoặc youtu.be)', 'err');
    return busy(btn, 'Đang lưu…', async () => { const r = id ? await A.updateResource(id, v) : await A.createResource(v); toast(r.message || 'Đã lưu'); loadAdmin(); done && done(r.id || id) });
  };
  $('#dfBack').onclick = () => cancel && cancel();
  if ($('#dfDraft')) $('#dfDraft').onclick = e => submit(e.currentTarget, false);
  if ($('#dfPub')) $('#dfPub').onclick = e => submit(e.currentTarget, true);
  if ($('#dfSave')) $('#dfSave').onclick = e => submit(e.currentTarget, false);
}

/* ===== Quản trị: nội dung trang chủ học sinh (tab Giới thiệu + Hướng dẫn) ===== */
const GO_LABEL = {'': 'Không có nút', home: 'Trang chủ', search: 'Tìm kiếm', library: 'Học liệu số', loans: 'Mượn/Trả', account: 'Thẻ/Tài khoản'};
let ctab = 'intro', cdraft = null, cdirty = false, cedit = -1;
const lines = v => String(v || '').split('\n').map(x => x.trim()).filter(Boolean);
const lbl = (t, inner) => `<label class="cl"><span>${t}</span>${inner}</label>`;
const cin = (id, v, ph, max) => `<input id="${id}" value="${esc(v)}" placeholder="${esc(ph || '')}" maxlength="${max}">`;
const cta = (id, v, rows, max) => `<textarea id="${id}" rows="${rows}" maxlength="${max}">${esc(v)}</textarea>`;
function readIntro() {
  if (!$('#ciSchool')) return;
  Object.assign(cdraft.introduction, {school: $('#ciSchool').value, tagline: $('#ciTag').value, about: $('#ciAbout').value, hours: lines($('#ciHours').value),
    address: $('#ciAddr').value, phone: $('#ciPhone').value, email: $('#ciMail').value, rules: lines($('#ciRules').value)});
}
function readGuideItem() {
  if (cedit < 0 || !$('#cgTitle')) return;
  Object.assign(cdraft.guide[cedit], {title: $('#cgTitle').value, body: $('#cgBody').value, go: $('#cgGo').value, cta: $('#cgCta').value});
}
async function contentSheet() {
  const A = ADM(); if (!A || !A.homeContent) return toast('Chức năng này chưa có ở backend hiện tại');
  try { const c = await A.homeContent(); cdraft = {introduction: {school: '', tagline: '', about: '', hours: [], address: '', phone: '', email: '', rules: [], ...(c.introduction || {})}, guide: (c.guide || []).map(x => ({go: '', cta: '', ...x}))}; ctab = 'intro'; cdirty = false; cedit = -1; paintContent(c.updatedAt) } catch (e) { fail(e) }
}
function paintContent(updatedAt) {
  const i = cdraft.introduction, g = cdraft.guide;
  const head = `<h3>Nội dung trang chủ</h3><p class="hint">Nội dung hiển thị ở hai tab <b>Giới thiệu</b> và <b>Hướng dẫn</b> trên trang chủ của học sinh.${updatedAt ? ' Cập nhật lần cuối: ' + fmtDate(updatedAt) + '.' : ''}</p>
    <div class="tabs" id="cTabs"><button data-ct="intro" class="${ctab === 'intro' ? 'on' : ''}">Giới thiệu</button><button data-ct="guide" class="${ctab === 'guide' ? 'on' : ''}">Hướng dẫn (${g.length})</button></div>`;
  let body;
  if (ctab === 'intro') {
    body = lbl('Tên trường / thư viện *', cin('ciSchool', i.school, 'VD: Thư viện Trường THPT …', 120)) + lbl('Khẩu hiệu', cin('ciTag', i.tagline, '', 160))
      + lbl('Giới thiệu chung', cta('ciAbout', i.about, 4, 2000)) + lbl('Giờ mở cửa (mỗi dòng một khung giờ)', cta('ciHours', (i.hours || []).join('\n'), 3, 1200))
      + lbl('Địa chỉ', cin('ciAddr', i.address, '', 250)) + `<div class="two2">${lbl('Số điện thoại', cin('ciPhone', i.phone, '', 30))}${lbl('Email', cin('ciMail', i.email, '', 120))}</div>`
      + lbl('Nội quy thư viện (mỗi dòng một điều)', cta('ciRules', (i.rules || []).join('\n'), 5, 6000))
      + '<p class="hint">Các số liệu (số học liệu, môn học…) tự động cập nhật, không cần nhập.</p>';
  } else if (cedit >= 0) {
    const x = g[cedit];
    body = `<button class="mini line" id="cgBack">‹ Danh sách mục</button><h4 style="margin:12px 0 4px">${x.title ? 'Sửa mục' : 'Mục mới'}</h4>` + lbl('Tiêu đề *', cin('cgTitle', x.title, 'VD: Tìm học liệu', 120)) + lbl('Nội dung *', cta('cgBody', x.body, 6, 1500))
      + lbl('Nút chuyển nhanh tới', `<select id="cgGo">${Object.entries(GO_LABEL).map(([k, v]) => `<option value="${k}" ${x.go === k ? 'selected' : ''}>${v}</option>`).join('')}</select>`) + `<div id="cgCtaBox" ${x.go ? '' : 'hidden'}>${lbl('Chữ trên nút', cin('cgCta', x.cta, 'VD: Tìm ngay', 40))}</div>`
      + '<button class="btn" id="cgOk">Xong</button>';
  } else {
    body = (g.map((x, k) => `<div class="gitem"><div class="gnum">${k + 1}</div><div style="flex:1;min-width:0"><b>${esc(x.title) || '(chưa có tiêu đề)'}</b><p class="cap" style="margin:2px 0 0">${esc((x.body || '').slice(0, 70))}${(x.body || '').length > 70 ? '…' : ''}${x.go ? ` · Nút: ${esc(GO_LABEL[x.go])}` : ''}</p></div>
      <div class="gact"><button data-gu="${k}" aria-label="Lên" ${k ? '' : 'disabled'}>↑</button><button data-gd="${k}" aria-label="Xuống" ${k < g.length - 1 ? '' : 'disabled'}>↓</button><button data-ge="${k}" aria-label="Sửa">Sửa</button><button data-gx="${k}" aria-label="Xóa">Xóa</button></div></div>`).join('') || '<p class="empty">Chưa có mục hướng dẫn nào.</p>')
      + `<button class="mini" id="cgAdd" ${g.length >= 20 ? 'disabled' : ''}>+ Thêm mục</button>`;
  }
  const foot = cedit >= 0 && ctab === 'guide' ? '' : `<div class="cfoot"><span class="cap">${cdirty ? '● Có thay đổi chưa lưu' : 'Đã đồng bộ'}</span><button class="btn" id="cSave" style="height:40px" ${cdirty ? '' : 'disabled'}>Lưu thay đổi</button></div>`;
  openSheet(head + body + foot);
  const dirty = () => { if (!cdirty) { cdirty = true; const s = $('#cSave'); if (s) s.disabled = false; const c = $('#cSave') && $('#cSave').previousElementSibling; if (c) c.textContent = '● Có thay đổi chưa lưu' } };
  $$('#sheet input, #sheet textarea, #sheet select').forEach(el => el.addEventListener('input', dirty));
  $$('#cTabs [data-ct]').forEach(b => b.onclick = () => { readIntro(); readGuideItem(); ctab = b.dataset.ct; cedit = -1; paintContent(updatedAt) });
  if ($('#cgGo')) $('#cgGo').onchange = () => { $('#cgCtaBox').hidden = !$('#cgGo').value; dirty() };
  if ($('#cgBack')) $('#cgBack').onclick = () => { readGuideItem(); cedit = -1; paintContent(updatedAt) };
  if ($('#cgOk')) $('#cgOk').onclick = () => {
    readGuideItem(); const x = g[cedit];
    if (!x.title.trim() || !x.body.trim()) return toast('Tiêu đề và nội dung là bắt buộc');
    cedit = -1; paintContent(updatedAt); toast('Đã cập nhật mục, nhớ bấm Lưu thay đổi');
  };
  if ($('#cgAdd')) $('#cgAdd').onclick = () => { g.push({title: '', body: '', go: '', cta: ''}); cedit = g.length - 1; cdirty = true; paintContent(updatedAt) };
  $$('#sheet [data-ge]').forEach(b => b.onclick = () => { cedit = +b.dataset.ge; paintContent(updatedAt) });
  $$('#sheet [data-gu],#sheet [data-gd]').forEach(b => b.onclick = () => { const k = +(b.dataset.gu ?? b.dataset.gd), j = b.dataset.gu !== undefined ? k - 1 : k + 1; [g[k], g[j]] = [g[j], g[k]]; cdirty = true; paintContent(updatedAt) });
  $$('#sheet [data-gx]').forEach(b => b.onclick = () => { if (confirm('Xóa mục hướng dẫn này?')) { g.splice(+b.dataset.gx, 1); cdirty = true; paintContent(updatedAt); toast('Đã xóa mục, nhớ bấm Lưu thay đổi') } else toast('Đã hủy xóa mục') });
  if ($('#cSave')) $('#cSave').onclick = async () => {
    readIntro(); readGuideItem();
    const bad = cdraft.guide.findIndex(x => !x.title.trim() || !x.body.trim());
    if (bad >= 0) { ctab = 'guide'; cedit = bad; paintContent(updatedAt); return toast('Mục hướng dẫn cần có tiêu đề và nội dung') }
    const b = $('#cSave'); b.disabled = true; b.textContent = 'Đang lưu…';
    try {
      const r = await ADM().saveHomeContent({introduction: cdraft.introduction, guide: cdraft.guide.map(x => ({title: x.title, body: x.body, go: x.go || undefined, cta: x.cta || undefined}))});
      cdraft = {introduction: {...cdraft.introduction, ...r.introduction}, guide: r.guide.map(x => ({go: '', cta: '', ...x}))}; cdirty = false; cedit = -1;
      paintContent(new Date()); toast('Đã lưu nội dung trang chủ');
    } catch (e) { b.disabled = false; b.textContent = 'Lưu thay đổi'; fail(e) }
  };
}
let cname = 'subjects';
function catSheet() {
  const A = ADM(); if (!A) return;
  const names = {subjects: 'Môn học', grades: 'Khối lớp', resourceTypes: 'Loại tài liệu'};
  openSheet('<h3>Quản lý danh mục</h3><div class="chips">' + Object.entries(names).map(([k, v]) => `<button class="chip ${k === cname ? 'on' : ''}" data-c="${k}">${v}</button>`).join('') + `</div><div class="two" style="margin-top:10px"><div class="field" style="margin:0"><input id="cNew" placeholder="Thêm ${names[cname].toLowerCase()} mới" aria-label="Tên danh mục"></div><button class="mini" id="cAdd">+ Thêm</button></div><div id="aList"></div>`);
  A.catalogList(cname).then(r => { $('#aList').innerHTML = r.items.map(x => `<div class="between" style="padding:10px 0;border-bottom:1px solid var(--border)"><span>${esc(x.name)} ${x.status === 'INACTIVE' ? '<span class="badge org">Đang tắt</span>' : ''}</span><button class="mini line" data-t="${esc(x.id)}">${x.status === 'INACTIVE' ? 'Bật' : 'Tắt'}</button></div>`).join('') }, fail);
  $$('#sheet [data-c]').forEach(b => b.onclick = () => { cname = b.dataset.c; catSheet() });
  $('#cAdd').onclick = () => doAdm(() => A.catalogAdd(cname, $('#cNew').value), catSheet);
  $('#aList').onclick = e => { const t = e.target.closest('[data-t]'); if (t) doAdm(() => A.catalogToggle(cname, t.dataset.t), catSheet) };
}
async function adminStats() {
  const A = ADM(); if (!A) return;
  try {
    const t = await A.statistics(), c = (n, l) => `<div class="stat"><b>${num(n)}</b><span>${l}</span></div>`, mx = Math.max(1, ...t.bySubject.map(x => x.count)), mt = Math.max(1, ...t.byType.map(x => x.count));
    const bars = (l, m) => l.map(x => `<div class="brow"><span>${esc(x.name)}</span><i style="width:${Math.max(6, x.count / m * 100)}%"></i><b>${x.count}</b></div>`).join('');
    openSheet('<h3>Thống kê hệ thống</h3><div class="stats">' + c(t.users.students, 'Học sinh') + c(t.users.teachers, 'Giáo viên') + c(t.resources.published, 'Đang hiển thị') + c(t.totalViews, 'Lượt xem') + '</div>'
      + `<p class="hint">${t.resources.pending} chờ duyệt · ${t.resources.hidden} đã ẩn · ${t.resources.rejected} bị từ chối · ${t.users.locked} tài khoản bị khóa</p><h3 style="font-size:14px;margin:8px 0">Tài liệu theo môn</h3>${bars(t.bySubject, mx)}<h3 style="font-size:14px;margin:12px 0 4px">Tài liệu theo loại</h3>${bars(t.byType, mt)}<h3 style="font-size:14px;margin:12px 0 4px">Xem nhiều nhất</h3>`
      + t.top.map(x => `<div class="between" style="padding:8px 0;border-bottom:1px solid var(--border)"><span>${esc(x.title)}</span><b>${num(x.views)}</b></div>`).join(''));
  } catch (e) { fail(e) }
}
async function auditSheet() {
  const A = ADM(); if (!A) return;
  try { const r = await A.auditLogs(); openSheet('<h3>Nhật ký hoạt động</h3>' + (r.items.map(x => `<div class="note"><div><b>${esc(x.action)}</b><p class="cap">${esc(x.actor)} · ${fmtDate(x.at)} ${new Date(x.at).toLocaleTimeString('vi-VN')}</p></div></div>`).join('') || '<p class="empty">Chưa có hoạt động nào được ghi lại</p>')) } catch (e) { fail(e) }
}
$('#admin').addEventListener('click', e => { const b = e.target.closest('[data-adm]'); if (b) ({users: usersSheet, res: resSheet, cat: catSheet, content: contentSheet, queue: showQueue, stats: adminStats, log: auditSheet, req: requestsSheet})[b.dataset.adm]() });

/* ===== Quản trị: yêu cầu tài liệu từ học sinh (gửi qua Trợ lý AI khi tìm không thấy) ===== */
const RQ = {NEW: ['Chờ xử lý', 'org'], DONE: ['Đã xử lý', 'grn'], REJECTED: ['Từ chối', 'red']};
async function loadReqBadge() {
  const b = $('#aReq'); if (!b || !Api.admin || !Api.admin.requests) return;
  try { const r = await Api.admin.requests({status: 'NEW', limit: 1}); b.hidden = !r.pagination.total; b.textContent = r.pagination.total } catch { b.hidden = true }
}
async function requestsSheet() {
  const A = ADM(); if (!A) return;
  if (!A.requests) return toast('Chưa hỗ trợ xem yêu cầu tài liệu');
  try {
    const r = await A.requests({limit: 30}), nm = (list, id) => (list.find(x => x.id === id) || {}).name;
    openSheet('<h3>Yêu cầu tài liệu từ học sinh</h3>' + (r.items.map(x => {
      const f = [nm(cat.subjects, x.subjectId), x.gradeId && 'Khối ' + nm(cat.grades, x.gradeId), nm(cat.resourceTypes, x.resourceTypeId)].filter(Boolean).map(esc).join(' · '), [lab, cls] = RQ[x.status] || [x.status, 'org'];
      return `<div class="note"><div style="flex:1"><b>${esc(x.text)}</b><p class="cap">${esc(x.userName)} · ${fmtDate(x.createdAt)}${f ? ' · ' + f : ''}</p>${x.note ? `<p class="cap">Ghi chú: ${esc(x.note)}</p>` : ''}<span class="badge ${cls}">${lab}</span></div>${x.status === 'NEW' ? `<div class="two"><button class="mini line" data-rq-rej="${esc(x.id)}">Từ chối</button><button class="mini" data-rq-ok="${esc(x.id)}">Đã xử lý</button></div>` : ''}</div>`;
    }).join('') || '<p class="empty">Chưa có yêu cầu nào.</p>'));
    const act = async (id, status, note) => { try { await A.updateRequest({id, status, note}); toast('Đã cập nhật yêu cầu'); loadReqBadge(); requestsSheet() } catch (e) { fail(e) } };
    $$('#sheet [data-rq-ok]').forEach(b => b.onclick = () => act(b.dataset.rqOk, 'DONE', ''));
    $$('#sheet [data-rq-rej]').forEach(b => b.onclick = () => {
      const raw = prompt('Ghi chú cho học sinh (không bắt buộc):'); if (raw === null) return toast('Đã hủy, yêu cầu chưa thay đổi');
      act(b.dataset.rqRej, 'REJECTED', raw.trim());
    });
  } catch (e) { fail(e) }
}

/* ===== Giáo viên: đăng học liệu bằng LINK (không tải tệp), quản lý, thống kê, cài đặt ===== */
const ST = {DRAFT: ['Nháp', 'org'], PENDING: ['Chờ duyệt', 'org'], PUBLISHED: ['Đã đăng', 'grn'], REJECTED: ['Bị từ chối', 'red']};
const tNeed = () => Api.teacher || (toast('Chức năng giáo viên chỉ có ở chế độ demo (mock-api.js)'), null);
async function loadTeacher() {
  if (!Api.teacher) return;
  try { const d = await Api.teacher.dashboard(); $('#tcMineN').textContent = d.total + ' tài liệu'; $('#tcPendN').textContent = d.pending + ' tài liệu' } catch (e) { fail(e) }
}
const isUrl = v => { try { return /^https?:$/.test(new URL(v).protocol) } catch { return false } };
const f = $('#tForm'), val = n => f.elements[n].value.trim();
$('[name=ty]', f).onchange = () => {}; // giữ lại để resetForm/sửa gọi được; 2 ô link luôn hiển thị cố định
function resetForm() { f.reset(); $('#editId').value = ''; $('#tFormTitle').textContent = 'Thêm học liệu mới'; $$('#tForm .err').forEach(x => x.classList.remove('err')); $('[name=ty]', f).onchange({target: f.elements.ty}) }
async function submitDoc(draft) {
  if (!tNeed()) return;
  let ok = true;
  $$('#tForm [name]:not([data-opt])').forEach(x => { const bad = draft ? (x.name === 't' && !x.value.trim()) || (x.name === 'u' && x.value.trim() && !isUrl(x.value.trim())) : !x.value.trim() || (x.name === 'u' && !isUrl(x.value.trim())); x.classList.toggle('err', bad); if (bad) ok = false });
  const vEl = f.elements.v, vv = vEl.value.trim(), vBad = !!vv && !isYoutube(vv); // link YouTube không bắt buộc, nhưng nếu nhập thì phải đúng
  vEl.classList.toggle('err', vBad);
  if (vBad) return toast('Link video phải là đường dẫn YouTube hợp lệ (youtube.com hoặc youtu.be)');
  if (!ok) return toast(draft ? 'Cần nhập tên tài liệu và link tài liệu hợp lệ (https://…)' : 'Vui lòng điền đủ các trường (*) và link tài liệu hợp lệ bắt đầu bằng https://');
  const btn = $(draft ? '#draft' : '#send'), old = btn.textContent; btn.disabled = true; btn.textContent = 'Đang lưu…';
  try {
    await Api.teacher.save({id: $('#editId').value || undefined, draft, title: val('t'), author: val('a'), subject: val('s'), grade: val('g'), topic: val('c'), type: val('ty'), url: val('u'), videoUrl: val('v'), description: val('d')});
    toast(draft ? 'Đã lưu nháp' : 'Đã gửi kiểm duyệt'); resetForm(); loadTeacher();
  } catch (e) { fail(e) } finally { btn.disabled = false; btn.textContent = old }
}
$('#addDoc').onclick = () => f.scrollIntoView({behavior: 'smooth'});
$('#draft').onclick = () => submitDoc(true);
f.onsubmit = e => { e.preventDefault(); submitDoc(false) };
async function docsSheet(only) {
  if (!tNeed()) return;
  try {
    const all = await Api.teacher.list(), ls = only ? all.filter(d => d.status === only) : all;
    openSheet(`<h3>${only ? 'Chờ kiểm duyệt' : 'Học liệu của tôi'}</h3>` + (ls.map(d => `<div class="book"><div><h4>${esc(d.title)}</h4><p class="cap">${esc(d.subject)} · Khối ${esc(d.grade)} · ${d.type === 'VIDEO' ? 'Video' : 'Tài liệu'}${d.status === 'PUBLISHED' ? ' · ' + num(d.views) + ' lượt xem' : ''}</p>
      <div class="act"><span class="badge ${ST[d.status][1]}">${ST[d.status][0]}</span>${d.rejectReason ? `<span class="cap">Lý do: ${esc(d.rejectReason)}</span>` : ''}</div>
      <div class="act">${d.videoUrl ? `<button class="mini line" data-open="${esc(d.videoUrl)}">Mở video</button>` : ''}${d.url ? `<button class="mini line" data-open="${esc(d.url)}">Mở tài liệu</button>` : ''}${['DRAFT', 'REJECTED'].includes(d.status) ? `<button class="mini line" data-edit="${d.id}">Sửa</button>` : ''}${d.status !== 'PUBLISHED' ? `<button class="mini line" data-del="${d.id}">Xóa</button>` : ''}</div></div></div>`).join('') || `<p class="empty">${only ? 'Không có tài liệu nào đang chờ duyệt' : 'Chưa có tài liệu. Hãy bấm "Thêm tài liệu" để đăng bài đầu tiên.'}</p>`));
    $$('#sheet [data-open]').forEach(b => b.onclick = () => { window.open(b.dataset.open, '_blank', 'noopener'); toast('Đã mở liên kết tài liệu') });
    $$('#sheet [data-del]').forEach(b => b.onclick = async () => { if (!confirm('Xóa tài liệu này?')) return toast('Đã hủy xóa tài liệu'); try { await Api.teacher.remove(b.dataset.del); toast('Đã xóa tài liệu'); loadTeacher(); docsSheet(only) } catch (e) { fail(e) } });
    $$('#sheet [data-edit]').forEach(b => b.onclick = () => {
      const d = all.find(x => x.id === b.dataset.edit); if (!d) return;
      Object.entries({t: d.title, a: d.author, s: d.subject, g: d.grade, c: d.topic, ty: d.type, u: d.url, v: d.videoUrl, d: d.description}).forEach(([k, v]) => f.elements[k].value = v || '');
      $('#editId').value = d.id; $('#tFormTitle').textContent = 'Sửa học liệu'; toast('Đang sửa: ' + d.title, 'info'); $('[name=ty]', f).onchange({target: f.elements.ty}); closeSheet(); f.scrollIntoView({behavior: 'smooth'});
    });
  } catch (e) { fail(e) }
}
async function statsSheet() {
  if (!tNeed()) return;
  try {
    const t = await Api.teacher.stats(), c = (n, l) => `<div class="stat"><b>${num(n)}</b><span>${l}</span></div>`;
    openSheet('<h3>Thống kê</h3><div class="stats">' + c(t.total, 'Tổng') + c(t.published, 'Đã đăng') + c(t.pending, 'Chờ duyệt') + c(t.views, 'Lượt xem') + '</div>'
      + (t.rejected ? `<p class="hint">${t.rejected} tài liệu bị từ chối, hãy xem lý do và sửa lại.</p>` : '') + '<h3 style="font-size:14px;margin:8px 0">Tài liệu được xem nhiều nhất</h3>'
      + (t.top.map(x => `<div class="between" style="padding:8px 0;border-bottom:1px solid var(--border)"><span>${esc(x.title)}</span><b>${num(x.views)}</b></div>`).join('') || '<p class="empty">Chưa có lượt xem. Số liệu xuất hiện khi học sinh xem tài liệu đã đăng của bạn.</p>'));
  } catch (e) { fail(e) }
}
async function teacherSettings() {
  let st = {}; try { st = Api.getSettings ? await Api.getSettings() : {} } catch (e) { return fail(e) }
  openSheet(`<h3>Cài đặt</h3><button class="menu" data-ts="profile"><i data-lucide="user"></i>Thông tin cá nhân</button><button class="menu" data-ts="password"><i data-lucide="lock"></i>Đổi mật khẩu</button>
    <label class="chk"><input type="checkbox" id="tsNotify" ${st.notify !== false ? 'checked' : ''}> Thông báo khi tài liệu được duyệt hoặc bị từ chối</label>
    <button class="menu" data-ts="logout"><i data-lucide="log-out"></i>Đăng xuất</button>`);
  $('#tsNotify').onchange = e => Api.saveSettings ? Api.saveSettings({notify: e.target.checked}).then(() => toast('Đã lưu cài đặt'), fail) : toast('Cài đặt chỉ có ở chế độ demo');
  $$('#sheet [data-ts]').forEach(b => b.onclick = () => ({profile: profileSheet, password: passwordSheet, logout: () => { closeSheet(); logout() }})[b.dataset.ts]());
}
$('#tcMine').onclick = () => docsSheet(); $('#tcPend').onclick = () => docsSheet('PENDING'); $('#tcStat').onclick = statsSheet; $('#tSet').onclick = teacherSettings;
resetForm();

/* ===== Trợ lý AI: dùng chung Api.search + danh mục + thông tin liên hệ của trang chủ ===== */
assistant = initAssistant({Api, $, esc, icons, toast, fail, remember, getCat: () => cat, getContact: () => introCache});

icons();
