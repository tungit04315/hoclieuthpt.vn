/**
 * LÕI TRỢ LÝ TÌM KIẾM (thuần JS, không DOM, không gọi AI bên ngoài).
 *
 * Quy trình: câu hỏi tự nhiên → parseIntent (tách môn/khối/loại/tác giả/sắp xếp + từ khóa)
 *            → gọi ĐÚNG hàm tìm kiếm của dự án (Api.search → rankSearch ở server/mock)
 *            → nếu rỗng thì nới lỏng bộ lọc từng bước → assessMatch (ok | weak | none).
 * Không tự chấm điểm riêng: thứ hạng, quyền xem (chỉ PUBLISHED) và quy tắc "khớp ≥ nửa số từ khóa" đều do thuật toán dự án quyết định.
 */
import { normalize, tokenize, assessMatch } from './search-core.js';

/** Từ đệm hội thoại (ngoài STOP của thuật toán) — chỉ dùng để làm sạch câu hỏi của trợ lý. */
const FILLER = new Set('ban oi nhe nha khong gi duoc xem giup ho tro biet'.split(' '));

/** [mã loại, các cụm từ nhận diện]. "tài liệu" quá chung nên KHÔNG ánh xạ sang loại DOCUMENT. */
const TYPE_ALIASES = [
  ['VIDEO', ['bai giang', 'video', 'clip']],
  ['EXERCISE', ['bai tap', 'luyen tap']],
  ['EXAM', ['de kiem tra', 'de thi', 'de on', 'kiem tra']],
  ['SUMMARY', ['so do tu duy', 'tom tat']],
];
/** Tên gọi tắt của môn — chỉ nhận khi đứng sau chữ "môn" để tránh nhầm (vd: "hoa" = bông hoa). */
const SUBJECT_SHORT = { 'vat ly': ['ly'], 'hoa hoc': ['hoa'], 'sinh hoc': ['sinh'], 'tin hoc': ['tin'], 'ngu van': ['van'], 'tieng anh': ['anh'] };
const SORT_NEWEST = ['moi nhat', 'moi cap nhat', 'moi dang', 'gan day', 'tai lieu moi', 'hoc lieu moi'];
const SORT_POPULAR = ['pho bien', 'xem nhieu', 'nhieu nguoi xem', 'hot nhat', 'yeu thich nhat'];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const code = (t) => String(t.code || t.id || '').toUpperCase();

/** Tách ý định + bộ lọc + từ khóa. cat = { subjects:[{id,name}], grades:[{id,name}], resourceTypes:[{id,code,name}] }. */
export function parseIntent(raw, cat = {}) {
  const subjects = cat.subjects || [], grades = cat.grades || [], types = cat.resourceTypes || [];
  let t = ` ${normalize(raw).replace(/[^a-z0-9+# ]/g, ' ').replace(/\s+/g, ' ').trim()} `;
  const take = (re) => { const m = t.match(re); if (m) t = t.replace(re, ' '); return m; };
  const phrase = (p) => take(new RegExp(` ${esc(p)} `));
  const intent = { raw: String(raw || ''), kind: 'search', filters: {}, labels: {}, sort: '', author: '', unsupportedGrade: '', tokens: [], q: '' };

  const plain = t.trim();
  if (/^(xin chao|chao|hello|hi|alo)( ban| bot| tro ly)?$/.test(plain)) return { ...intent, kind: 'greeting' };
  if (/^(cam on|thanks|thank you|ok|oke|tuyet)( ban| nhe| nha)?$/.test(plain)) return { ...intent, kind: 'thanks' };
  // Chỉ coi là hỏi liên hệ khi câu BẮT ĐẦU bằng ý đó (tránh nhầm với tên học liệu như "Quản trị mạng")
  if (/^(cho (em|minh|toi) )?(muon )?(xin )?(thong tin )?(lien he|lien lac|so dien thoai|dia chi|gio mo cua|hotline|thu thu|gap quan tri)/.test(plain)) return { ...intent, kind: 'contact' };
  if (/(yeu cau tai lieu|de xuat tai lieu|gui yeu cau)/.test(plain)) return { ...intent, kind: 'request' };
  if (/^(huong dan|tro giup|help|ban lam duoc gi|lam duoc gi|ban la ai)/.test(plain)) return { ...intent, kind: 'help' };

  // 1) Sắp xếp
  if (SORT_NEWEST.some(phrase)) intent.sort = 'newest';
  else if (SORT_POPULAR.some(phrase)) intent.sort = 'popular';

  // 2) Khối lớp: "lớp 10", "khối 11", hoặc số 10-12 đứng riêng nếu có trong danh mục
  const gm = take(/ (?:lop|khoi) ?(\d{1,2}) /) || take(/ (\d{2}) /);
  if (gm) {
    const g = grades.find((x) => String(x.name) === gm[1]);
    if (g) { intent.filters.gradeId = g.id; intent.labels.grade = `Khối ${g.name}`; }
    else if (/(lop|khoi)/.test(gm[0]) || !/^\d{2}$/.test(gm[1])) intent.unsupportedGrade = gm[1];
    else t = t.replace(' ', ` ${gm[1]} `); // số 2 chữ số không phải khối (vd: "2024") → trả lại làm từ khóa
  }

  // 3) Loại học liệu
  for (const [c, words] of TYPE_ALIASES) {
    const found = words.some(phrase), ty = found && types.find((x) => code(x) === c);
    if (ty) { intent.filters.resourceTypeId = ty.id; intent.labels.type = ty.name; break; }
  }

  // 4) Môn học: tên đầy đủ ở bất kỳ đâu; tên gọi tắt chỉ khi đứng sau "môn"
  for (const s of subjects) {
    const n = normalize(s.name), short = SUBJECT_SHORT[n] || [];
    if (phrase(n) || short.some((w) => take(new RegExp(` mon ${esc(w)} `)))) { intent.filters.subjectId = s.id; intent.labels.subject = s.name; break; }
  }

  // 5) Tác giả: "tác giả X" / "của thầy|cô X" (tối đa 3 từ)
  const am = take(/ (?:tac gia|cua thay|cua co) ((?:[a-z]+ ?){1,3})/);
  if (am) intent.author = am[1].trim();

  // 6) Từ khóa còn lại — dùng đúng tokenize của thuật toán dự án
  intent.tokens = tokenize(t.split(' ').filter((w) => !FILLER.has(w)).join(' '));
  intent.q = intent.tokens.join(' ');
  return intent;
}

const nonEmpty = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v));
const RELAX_ORDER = ['resourceTypeId', 'gradeId', 'subjectId']; // bỏ bộ lọc ít quan trọng nhất trước
const LABEL_OF = { resourceTypeId: 'type', gradeId: 'grade', subjectId: 'subject' };

/**
 * Trả lời một câu hỏi tìm kiếm.
 * search(params) phải là Api.search (trả { items, pagination:{total} }). Trả về:
 *  { intent, level: 'ok'|'weak'|'none', items, total, filters, dropped:[tên bộ lọc đã nới], reason }
 */
export async function ask(text, { search, cat, limit = 5 }) {
  const intent = parseIntent(text, cat);
  const base = { intent, items: [], total: 0, filters: {}, dropped: [], reason: '' };
  if (intent.kind !== 'search') return { ...base, level: intent.kind }; // greeting | thanks | help | contact | request
  if (intent.unsupportedGrade) return { ...base, level: 'none', reason: 'grade' };
  if (!intent.tokens.length && !intent.author && !Object.keys(intent.filters).length && !intent.sort) return { ...base, level: 'empty' };

  const sort = intent.sort || (intent.tokens.length ? 'relevance' : intent.filters.subjectId || intent.filters.gradeId ? 'popular' : 'newest');
  const filters = { ...intent.filters }, dropped = [];
  for (;;) {
    const res = await search({ q: intent.q, ...nonEmpty(filters), author: intent.author || undefined, sort, limit });
    if (res.items.length) {
      const a = dropped.length ? { level: 'weak', missing: [] } : assessMatch(intent.tokens, res.items);
      return { ...base, level: a.level, missing: a.missing, items: res.items, total: res.pagination?.total ?? res.items.length, filters, dropped, reason: dropped.length ? 'relaxed' : '' };
    }
    const next = RELAX_ORDER.find((k) => filters[k]);
    // Không còn bộ lọc để nới: nếu không có từ khóa/tác giả thì dừng (tránh trả về "toàn bộ thư viện")
    if (!next || (!intent.tokens.length && !intent.author && Object.keys(filters).length <= 1)) break;
    delete filters[next]; dropped.push(LABEL_OF[next]);
  }
  return { ...base, level: 'none', filters, dropped, reason: 'empty' };
}

/** Mô tả bộ lọc bằng tiếng Việt, vd: "môn Toán · Khối 10 · Bài tập". */
export function describeFilters(intent, dropped = []) {
  const l = intent.labels, out = [];
  if (l.subject && !dropped.includes('subject')) out.push(`môn ${l.subject}`);
  if (l.grade && !dropped.includes('grade')) out.push(l.grade);
  if (l.type && !dropped.includes('type')) out.push(l.type);
  if (intent.author) out.push(`tác giả ${intent.author}`);
  return out.join(' · ');
}

/** Lời dẫn của trợ lý cho từng mức độ. Trả về chuỗi thuần (UI tự escape khi hiển thị). */
export function composeText(r, cat = {}) {
  const { intent } = r, kw = intent.q ? `“${intent.q}”` : '', f = describeFilters(intent, r.dropped);
  const what = [kw, f].filter(Boolean).join(' · ');
  const names = (cat.grades || []).map((g) => g.name).join(', ');
  switch (r.level) {
    case 'greeting': return 'Xin chào! Mình là trợ lý tìm học liệu của thư viện. Bạn cứ hỏi tự nhiên, ví dụ: “bài tập Toán lớp 10” hay “video Vật lý mới nhất”.';
    case 'thanks': return 'Rất vui được giúp bạn! Cần tìm thêm học liệu nào cứ hỏi mình nhé.';
    case 'help': return 'Mình tìm học liệu theo môn, khối, loại (video, bài tập, đề thi, tóm tắt), tác giả và từ khóa — gõ không dấu cũng được. Mình chỉ tìm trong học liệu đã xuất bản; nếu thư viện chưa có, mình giúp bạn gửi yêu cầu cho quản trị viên.';
    case 'contact': return 'Đây là thông tin liên hệ của thư viện:';
    case 'request': return 'Bạn muốn thư viện bổ sung học liệu nào? Mô tả ngắn gọn rồi gửi cho quản trị viên nhé.';
    case 'empty': return 'Bạn muốn tìm học liệu gì? Hãy cho mình biết môn, khối lớp hoặc từ khóa nhé.';
    case 'ok': return `Mình tìm thấy ${r.total} học liệu${what ? ` cho ${what}` : ''}. Gợi ý hàng đầu:`;
    case 'weak': return r.reason === 'relaxed'
      ? `Chưa có học liệu khớp đủ điều kiện${what ? ` (${what})` : ''}. Mình đã bỏ bớt bộ lọc ${r.dropped.map((d) => ({ subject: 'môn', grade: 'khối', type: 'loại' }[d])).join(', ')} — đây là kết quả gần nhất:`
      : `Mình chưa chắc chắn${(r.missing || []).length ? `, vì chưa thấy từ khóa ${r.missing.map((m) => `“${m}”`).join(', ')} trong các học liệu này` : ', vì chỉ khớp một phần từ khóa'}. Học liệu gần nhất:`;
    case 'none': return r.reason === 'grade'
      ? `Thư viện hiện chỉ có học liệu khối ${names || '10, 11, 12'}, chưa có khối ${intent.unsupportedGrade}.`
      : `Thư viện hiện chưa có học liệu phù hợp${what ? ` với ${what}` : ''}.`;
    default: return '';
  }
}

/** Gợi ý câu hỏi tiếp theo, sinh từ danh mục + kết quả (tối đa 3). */
export function followUps(r, cat = {}) {
  const out = [], s = r.intent?.labels?.subject, g = r.intent?.labels?.grade;
  if (r.level === 'ok' || r.level === 'weak') {
    if (s) { out.push(`${s} mới nhất`); out.push(`${s} phổ biến nhất`); }
    else if (r.items[0]?.subject?.name) out.push(`${r.items[0].subject.name} mới nhất`);
    if (!g && r.items[0]?.grade?.name) out.push(`${s || r.items[0]?.subject?.name || 'Tài liệu'} lớp ${r.items[0].grade.name}`);
  }
  return [...new Set(out)].slice(0, 3);
}

/** Câu hỏi mẫu cho màn hình chào, lấy từ danh mục thật. */
export function starterQuestions(cat = {}) {
  const s = (cat.subjects || [])[0]?.name, g = (cat.grades || [])[0]?.name, v = (cat.subjects || [])[1]?.name;
  return [s && g ? `Bài tập ${s} lớp ${g}` : 'Học liệu mới nhất', v ? `Video ${v}` : 'Học liệu phổ biến nhất', 'Đề thi mới nhất'].filter(Boolean);
}
