/**
 * GIAO DIỆN TRỢ LÝ AI (màn hình #ai) — gắn vào app.js bằng initAssistant(ctx).
 * Logic tìm kiếm nằm ở ai-engine.js; ở đây chỉ vẽ khung chat, thẻ liên hệ và form "gửi yêu cầu tài liệu".
 * Thông tin liên hệ lấy từ phần "Giới thiệu" mà quản trị viên đã chỉnh ở "Nội dung trang chủ" (không cấu hình riêng).
 */
import { ask, composeText, followUps, starterQuestions, describeFilters } from './ai-engine.js';

export function initAssistant(ctx) {
  const { Api, $, esc, icons, toast, fail, getCat, getContact, remember } = ctx;
  const log = $('#aiLog'), form = $('#aiForm'), input = $('#aiInput');
  let busy = false, welcomed = false;

  const scroll = () => { log.scrollTop = log.scrollHeight; };
  const add = (role, html) => {
    const el = document.createElement('div');
    el.className = `aib ${role}`; el.innerHTML = html; log.appendChild(el); icons(); scroll(); return el;
  };
  const chips = (list) => list.length ? `<div class="aichips">${list.map((q) => `<button type="button" class="aichip" data-ask="${esc(q)}">${esc(q)}</button>`).join('')}</div>` : '';

  const meta = (r) => [r.subject?.name, r.grade?.name && `Khối ${r.grade.name}`, r.resourceType?.name].filter(Boolean).map(esc).join(' · ');
  const itemsHtml = (items) => `<div class="aires-list">${items.map((r) => `<button type="button" class="aires" data-open="${esc(r.id)}"><b>${esc(r.title)}</b><span class="cap">${meta(r)}${r.author ? ` · ${esc(r.author)}` : ''}</span>${r.summary ? `<span class="aisum">${esc(r.summary)}</span>` : ''}</button>`).join('')}</div>`;

  function contactHtml() {
    const i = getContact() || {}, row = (ic, t) => `<div class="irow"><i data-lucide="${ic}"></i><span>${t}</span></div>`;
    const rows = [
      i.phone && row('phone', `<a href="tel:${esc(String(i.phone).replace(/[^\d+]/g, ''))}">${esc(i.phone)}</a>`),
      i.email && row('mail', `<a href="mailto:${esc(i.email)}">${esc(i.email)}</a>`),
      i.address && row('map-pin', esc(i.address)),
      ...(i.hours || []).slice(0, 3).map((h) => row('clock', esc(h))),
    ].filter(Boolean);
    return `<div class="aicontact"><b>${esc(i.school || 'Thư viện')}</b>${rows.join('') || '<p class="cap">Chưa có thông tin liên hệ — vui lòng hỏi trực tiếp thủ thư.</p>'}</div>`;
  }
  const canRequest = () => typeof Api.createRequest === 'function';
  const requestCta = (label) => canRequest() ? `<button type="button" class="mini line aireq-open" data-air="open">${esc(label)}</button>` : '';

  function requestForm(text, filters = {}, lead = true) {
    const el = add('bot', `${lead ? '<p>Mô tả học liệu bạn cần, mình gửi cho quản trị viên:</p>' : ''}
      <div class="aireq" data-filters='${esc(JSON.stringify(filters))}'><textarea rows="3" maxlength="300" aria-label="Nội dung yêu cầu">${esc(text)}</textarea>
      <div class="two"><button type="button" class="mini line" data-air="cancel">Để sau</button><button type="button" class="mini" data-air="send">Gửi yêu cầu</button></div></div>`);
    el.querySelector('textarea').focus();
  }

  function render(r) {
    const cat = getCat(), lv = r.level;
    let html = `<p>${esc(composeText(r, cat))}</p>`;
    if (r.items.length) { remember(r.items); html += itemsHtml(r.items); }
    if (lv === 'weak') html += `<p class="aiwarn"><i data-lucide="alert-triangle"></i>Độ khớp chưa cao — chưa đúng thứ bạn cần?</p>${requestCta('Gửi yêu cầu cho quản trị viên')}`;
    if (lv === 'none') html += contactHtml() + requestCta('Gửi yêu cầu tài liệu này');
    if (lv === 'contact') html += contactHtml();
    if (lv === 'greeting' || lv === 'help') html += chips(starterQuestions(cat));
    if (lv === 'ok') html += chips(followUps(r, cat));
    const el = add('bot', html);
    el.dataset.q = r.intent.raw; el.dataset.filters = JSON.stringify(r.intent.filters || {});
    if (lv === 'request') requestForm('', {}, false);
  }

  async function send(text) {
    text = String(text || '').trim();
    if (!text || busy) return;
    busy = true; input.value = ''; add('user', esc(text));
    const typing = add('bot', '<span class="dots"><i></i><i></i><i></i></span>');
    try {
      const r = await ask(text, { search: (p) => Api.search(p), cat: getCat() });
      typing.remove(); render(r);
    } catch (e) {
      typing.remove(); add('bot', `<p>Mình chưa tìm được lúc này: ${esc((e && e.message) || 'đã có lỗi xảy ra')}. Bạn thử lại sau nhé.</p>`); fail(e);
    } finally { busy = false; }
  }

  async function sendRequest(box) {
    const text = box.querySelector('textarea').value.trim();
    if (text.length < 5) return toast('Hãy mô tả học liệu cần tìm (tối thiểu 5 ký tự)', 'err');
    let filters = {}; try { filters = JSON.parse(box.dataset.filters || '{}'); } catch { /* bỏ qua */ }
    const btn = box.querySelector('[data-air="send"]'); btn.disabled = true;
    try {
      const res = await Api.createRequest({ text, ...filters });
      box.innerHTML = `<p class="aiok"><i data-lucide="check-circle"></i>${res && res.duplicate ? 'Bạn đã gửi yêu cầu này rồi — quản trị viên sẽ sớm xử lý.' : 'Đã gửi yêu cầu. Khi có phản hồi, bạn sẽ nhận thông báo trong ứng dụng.'}</p>`;
      icons(); toast(res && res.duplicate ? 'Yêu cầu này đã được gửi trước đó' : 'Đã gửi yêu cầu cho quản trị viên', res && res.duplicate ? 'info' : 'ok');
    } catch (e) { btn.disabled = false; fail(e); }
  }

  $('#ai').addEventListener('click', (e) => {
    const q = e.target.closest('[data-ask]'); if (q) return send(q.dataset.ask);
    const a = e.target.closest('[data-air]'); if (!a) return;
    const bubble = a.closest('.aib');
    if (a.dataset.air === 'open') { a.remove(); return requestForm(bubble.dataset.q || '', JSON.parse(bubble.dataset.filters || '{}')); }
    if (a.dataset.air === 'cancel') return a.closest('.aib').remove();
    if (a.dataset.air === 'send') sendRequest(a.closest('.aireq'));
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); send(input.value); });
  const reset = () => { log.innerHTML = ''; welcomed = false; };
  $('#aiClear').onclick = () => { reset(); open(); };

  function open() {
    if (!welcomed) {
      welcomed = true;
      add('bot', `<p>Xin chào! Mình là trợ lý tìm học liệu. Bạn cứ hỏi tự nhiên (gõ không dấu cũng được), mình sẽ tìm trong kho học liệu đã xuất bản của thư viện.</p>${chips(starterQuestions(getCat()))}`);
    }
    setTimeout(() => input.focus({ preventScroll: true }), 50);
  }
  return { open, send, reset, describeFilters };
}
