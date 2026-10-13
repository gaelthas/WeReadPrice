// ==UserScript==
// @name         WeReadPrice
// @namespace    https://greasyfork.org/zh-CN/scripts/572301-wereadprice
// @homepage     https://github.com/gaelthas/WeReadPrice
// @version      1.1.2
// @description  在微信读书书架页面显示书籍价格，并支持按推荐值/书名/分类/字数/付费情况分组浏览
// @author       Galois
// @match        https://weread.qq.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      weread.qq.com
// @connect      cdn.jsdelivr.net
// @run-at       document-idle
// @license      MIT
// @updateURL    https://update.greasyfork.org/scripts/572301/WeReadPrice.user.js
// @downloadURL  https://update.greasyfork.org/scripts/572301/WeReadPrice.user.js
// ==/UserScript==

'use strict';

// ─── 配置 ────────────────────────────────────────────────────────────────────

const PRICE_CLASS = 'viberead-price';
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 200;

const CARD_SELECTORS = ['.shelfBook'];
const BOOKID_FROM_HREF_RE = /\/(?:reader|book)\/([^/?#]+)/;

// ─── 缓存分层 ────────────────────────────────────────────────────────────────
// A 层「书籍档案」：书名/作者/分类/字数/评分 —— 基本不变，永久缓存，过期只后台静默刷新
// B 层「购买状态」：已购/免费/价格/类型 —— 会变，来自 shelf/sync 一次拿全量，短 TTL
// 价格只存在 B 层，绝不写进 A 层，避免永久读到旧价

const SORT_STORAGE_KEY = 'weread-shelf-sort-v1';    // 当前排序方式
const STATIC_STORE_KEY = 'weread-book-static-v1';   // A 层：书籍档案（永久）
const STATIC_STORE_MAX = 5000;
const STATIC_SOFT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天后后台静默刷新
const STATIC_SOFT_BATCH = 60;                        // 每轮最多后台刷新本数
const STATE_STORE_KEY = 'weread-shelf-state-v3';    // B 层：购买状态(含 payType) + 书架成员 + 封面 + 分组归属
const STATE_TTL_MS = 24 * 60 * 60 * 1000;           // 24h：进书架或页面切回前台时超过则刷新
const GROUP_CLASS = 'wrp-group-header';
const CAT_CLASS = 'wrp-cat';
const PRICE_SPAN_CLASS = 'wrp-price';
const RATING_SPAN_CLASS = 'wrp-rating';

const STATIC_FIELDS = ['title', 'author', 'category', 'totalWords', 'newRating', 'deepVRating', 'newRatingCount'];

// ─── A 层：书籍档案（永久缓存）───────────────────────────────────────────────

const _staticStore = new Map();   // bookId → { data, ts }
let _staticLoaded = false;
let _persistTimer = null;

function loadStaticStore() {
  if (_staticLoaded) return;
  _staticLoaded = true;
  try {
    const raw = JSON.parse(localStorage.getItem(STATIC_STORE_KEY) || '{}');
    for (const [bookId, v] of Object.entries(raw)) {
      if (v && v.data) _staticStore.set(bookId, { data: v.data, ts: v.ts || 0 });
    }
  } catch {
    _staticStore.clear();
  }
}

function schedulePersist() {
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    try {
      const out = {};
      for (const [bookId, e] of _staticStore) out[bookId] = { data: e.data, ts: e.ts };
      localStorage.setItem(STATIC_STORE_KEY, JSON.stringify(out));
    } catch {
      // 配额超限：放弃持久化，仅保留内存副本
    }
  }, 1000);
}

function getStatic(bookId) {
  loadStaticStore();
  const entry = _staticStore.get(bookId);
  return entry ? entry.data : null;
}

// 无档案，或档案已超过软过期时间（此时仍返回旧值，只在后台补刷）
function isStaticStale(bookId) {
  loadStaticStore();
  const entry = _staticStore.get(bookId);
  if (!entry) return true;
  return Date.now() - entry.ts > STATIC_SOFT_TTL_MS;
}

function setStatic(bookId, info) {
  loadStaticStore();
  const data = {};
  for (const f of STATIC_FIELDS) data[f] = info[f] ?? null;
  _staticStore.set(bookId, { data, ts: Date.now() });

  if (_staticStore.size > STATIC_STORE_MAX) {
    const keys = Array.from(_staticStore.keys())
      .sort((a, b) => (_staticStore.get(a).ts || 0) - (_staticStore.get(b).ts || 0));
    for (const k of keys.slice(0, _staticStore.size - STATIC_STORE_MAX)) _staticStore.delete(k);
  }
  schedulePersist();
}

// ─── B 层：购买状态兜底（仅本次会话，不持久化）────────────────────────────────

const _dynFallback = new Map();   // bookId → { 购买状态字段 + ts }
const _failedIds = new Set();     // 本次会话取档案失败的 bookId，不再自动重试（防止失败重试风暴）

function setDynFallback(bookId, info) {
  _dynFallback.set(bookId, {
    centPrice: info.centPrice ?? null,
    payingStatus: info.payingStatus ?? null,
    payType: info.payType ?? null,
    paid: info.paid ?? 0,
    free: !!info.free,
    bookType: info.bookType ?? 0,
    ts: Date.now(),
  });
}

// ─── 模拟器表单缓存 (localStorage, 无过期) ───────────────────────────────────────

const SIM_CACHE_KEY = 'weread-sim-settings-v1';

function saveSimSettings() {
  const data = {
    days: document.getElementById('wrpInpDays')?.value,
    hours: document.getElementById('wrpInpHours')?.value,
    flipCard: document.getElementById('wrpInpFlipCard')?.value,
    flipCoin: document.getElementById('wrpInpFlipCoin')?.value,
    strategy: {},
    challengeDays: getChallengeDays?.(),
  };
  if (!data.days) return; // UI 尚未创建
  REWARD_TIME.forEach(r => data.strategy[r.key] = getRadioVal('wrpStrat' + r.key));
  REWARD_DAY.forEach(r => data.strategy[r.key] = getRadioVal('wrpStrat' + r.key));
  try { localStorage.setItem(SIM_CACHE_KEY, JSON.stringify(data)); } catch (_) {}
}

function loadSimSettings() {
  try {
    const raw = localStorage.getItem(SIM_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
}

// ─── API ──────────────────────────────────────────────────────────────────────

function fetchPayInfo(bookId) {
  return new Promise((resolve) => {
    GM_xmlhttpRequest({
      method: 'GET',
      url: `https://weread.qq.com/web/book/info?bookId=${bookId}`,
      withCredentials: true,
      onload(resp) {
        try {
          const data = JSON.parse(resp.responseText);
          const words = Number(data.totalWords ?? data.bookInfo?.totalWords);
          resolve({
            bookId: data.bookId,
            title: data.title,
            author: data.author,
            bookType: data.type,
            centPrice: data.bookInfo?.centPrice ?? data.centPrice ?? null,
            payingStatus: data.payingStatus,
            paid: data.paid,
            newRating: data.newRating,
            deepVRating: data.deepVRating,
            newRatingCount: data.newRatingCount,
            totalWords: Number.isFinite(words) && words > 0 ? words : null,
            category: data.category || data.categories?.[0]?.title || null,
            free: data.free === 1,
          });
        } catch {
          resolve(null);
        }
      },
      onerror() { resolve(null); },
      ontimeout() { resolve(null); },
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 确保这批书有「书籍档案」(A 层)。
 * 已永久缓存的直接使用，只拉取缺失的；购买状态由 B 层提供，不在这里缓存。
 */
const FETCH_MAX_ATTEMPT = 3;   // 批量取档案的最大尝试次数（失败重试，避免个别限流把书永久归为"无数据"）

async function fetchPrices(bookIds, onProgress, opts) {
  const force = !!(opts && opts.force);
  const refresh = !!(opts && opts.refresh);   // 忽略已有档案，强制重取
  const attempt = (opts && opts.attempt) || 1;
  const result = {};
  const toFetch = [];

  for (const bookId of bookIds) {
    const st = refresh ? null : getStatic(bookId);
    if (st) {
      result[bookId] = st;
      continue;
    }
    // 只在第一轮跳过此前确认失败的；重试轮不再跳过
    if (!force && attempt === 1 && _failedIds.has(bookId)) continue;
    toFetch.push(bookId);
  }

  let done = 0;
  const failures = [];
  const report = () => { if (onProgress) onProgress(done, toFetch.length); };
  report();

  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const batch = toFetch.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async bookId => {
      const data = await fetchPayInfo(bookId);
      if (data) {
        result[bookId] = data;
        setStatic(bookId, data);   // 只存档案字段
        setDynFallback(bookId, data); // 购买状态仅作会话内兜底
        _failedIds.delete(bookId);
      } else {
        failures.push(bookId);
      }
      done++;
    }));
    report();
    if (i + BATCH_SIZE < toFetch.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  if (failures.length > 0) {
    if (attempt < FETCH_MAX_ATTEMPT) {
      await sleep(600 * attempt);   // 退避后重试，避免瞬时限流被当成"无数据"
      const retried = await fetchPrices(failures, null, { attempt: attempt + 1, force: true, refresh });
      Object.assign(result, retried);
    } else {
      for (const bookId of failures) _failedIds.add(bookId);
    }
  }

  return result;
}

// ─── B 层：书架状态 (shelf/sync，一次请求拿到全量购买状态) ────────────────────

let _shelfIndex = null;      // Map<bookId, { 档案摘要 + 购买状态 + 封面 + deepLink }>
let _archiveByBook = new Map(); // bookId → 所属分组名数组
let _stateTs = 0;            // B 层数据抓取时刻（用于与兜底状态比较新旧）

function fetchShelfSync() {
  return new Promise((resolve) => {
    GM_xmlhttpRequest({
      method: 'GET',
      url: 'https://weread.qq.com/web/shelf/sync',
      withCredentials: true,
      onload(resp) {
        try {
          const data = JSON.parse(resp.responseText);
          resolve({
            books: Array.isArray(data.books) ? data.books : [],
            archives: Array.isArray(data.archive) ? data.archive : [],
          });
        } catch {
          resolve(null);
        }
      },
      onerror() { resolve(null); },
      ontimeout() { resolve(null); },
    });
  });
}

function booksToIndex(books) {
  const map = new Map();
  for (const b of books) {
    if (!b || !b.bookId) continue;
    map.set(b.bookId, {
      bookId: b.bookId,
      title: b.title || '',
      author: b.author || '',
      cover: b.cover || '',
      deepLink: b.deepLink || '',
      category: b.category || b.categories?.[0]?.title || '',
      centPrice: b.centPrice ?? null,
      payingStatus: b.payingStatus ?? null,
      payType: b.payType ?? null,
      paid: b.paid ?? 0,
      free: b.free === 1,
      type: b.type ?? 0,
    });
  }
  return map;
}

// 分组归属：bookId → [分组名]
function archivesToBookMap(archives) {
  const map = new Map();
  for (const a of archives) {
    const name = a && a.name;
    if (!name || !Array.isArray(a.bookIds)) continue;
    for (const bookId of a.bookIds) {
      if (!map.has(bookId)) map.set(bookId, []);
      map.get(bookId).push(name);
    }
  }
  return map;
}

/**
 * 确保 B 层状态可用：命中缓存且未过期则零请求，否则刷新一次。
 * @param {boolean} force 忽略 TTL 强制刷新（手动点「刷新状态」时使用）
 */
async function ensureShelfState(force) {
  if (!_shelfIndex) {
    try {
      const cached = JSON.parse(localStorage.getItem(STATE_STORE_KEY) || 'null');
      if (cached && cached.ts && cached.items) {
        _shelfIndex = new Map(Object.entries(cached.items));
        _archiveByBook = archivesToBookMap(cached.archives || []);
        _stateTs = cached.ts;
      }
    } catch {
      // 缓存损坏，重新拉取
    }
  }

  // TTL 判断必须在「内存已有」之前：否则长时间不关的标签页永远不刷新
  const fresh = _stateTs && (Date.now() - _stateTs) < STATE_TTL_MS;
  if (_shelfIndex && !force && fresh) return _shelfIndex;

  return await refreshShelfIndex();
}

async function refreshShelfIndex() {
  const data = await fetchShelfSync();
  if (!data) return _shelfIndex;

  _shelfIndex = booksToIndex(data.books);
  _archiveByBook = archivesToBookMap(data.archives);
  _stateTs = Date.now();
  try {
    localStorage.setItem(STATE_STORE_KEY, JSON.stringify({
      ts: _stateTs,
      items: Object.fromEntries(_shelfIndex),
      archives: data.archives.map(a => ({
        name: a && a.name,
        bookIds: (a && a.bookIds) || [],
      })),
    }));
  } catch {
    // 配额超限，仅保留内存状态
  }
  return _shelfIndex;
}

// ─── DOM 工具 ─────────────────────────────────────────────────────────────────

function queryBookCards() {
  return Array.from(document.querySelectorAll(CARD_SELECTORS.join(',')));
}

function extractBookId(card) {
  const fromAttr = card.dataset && card.dataset.bookid;
  if (fromAttr) return fromAttr;

  if (card.href) {
    const m = card.href.match(BOOKID_FROM_HREF_RE);
    if (m) return m[1];
  }

  const link = card.querySelector('a[href]');
  if (link) {
    const m = link.href.match(BOOKID_FROM_HREF_RE);
    if (m) return m[1];
  }

  return null;
}

function parseId(infoId) {
  const type = infoId[3];
  const dataSection = infoId.slice(7, infoId.length - 3);
  const segments = dataSection.split('g');
  const chunks = [];
  for (const seg of segments) {
    const len = parseInt(seg.slice(0, 2), 16);
    chunks.push(seg.slice(2, 2 + len));
  }
  if (type === '3') {
    return chunks.map(c => parseInt(c, 16).toString(10)).join('');
  } else if (type === '4') {
    const hex = chunks[0];
    let result = '';
    for (let i = 0; i < hex.length; i += 2) {
      result += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
    return result;
  }
  throw new Error(`Unknown type flag: ${type}`);
}

function scanNewCards() {
  const cards = queryBookCards();
  const result = [];
  for (const card of cards) {
    if (card.querySelector('.' + PRICE_CLASS)) continue;
    if (card.dataset && card.dataset.wrpDone === '1') continue;
    const rawId = extractBookId(card);
    if (!rawId) continue;
    try {
      result.push({ element: card, bookId: parseId(rawId) });
    } catch {
      // 无法解析的 bookId 跳过
    }
  }
  return result;
}

// ─── 价格注入 ─────────────────────────────────────────────────────────────────

/**
 * 评分展示为「几分」：88 → 8.8，918 → 9.2，无评分 → null。
 * 换算统一走 normalizeRating（百分制），避免展示与分档各用一套刻度。
 */
function formatRatingValue(rating) {
  const pct = normalizeRating(rating);
  if (pct == null) return null;
  const score = pct / 10;
  return score % 1 === 0 ? String(score) : score.toFixed(1);
}

function formatCategory(category) {
  if (!category) return '分类未知';

  if (typeof category === 'string') {
    return category;
  }

  if (Array.isArray(category)) {
    const parts = category.map(item => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      return item.title || item.name || item.categoryName || item.label || '';
    }).filter(Boolean);

    return parts.length > 0 ? parts.join(' / ') : '分类未知';
  }

  if (typeof category === 'object') {
    return category.title || category.name || category.categoryName || category.label || '分类未知';
  }

  return '分类未知';
}

function getPriceDisplay(priceData) {
  if (!priceData) {
    return { text: '暂无价格', color: '#888' };
  }

  if (priceData.bookType == 3) {
    return { text: '公众号', color: '#888' };
  }

  if (priceData.paid == 1) {
    return { text: '已购买', color: '#07c160' };
  }

  // 与「付费」分组共用同一判定，避免卡片显示「导入」却被分到「免费」/「体验卡可读」
  if (isImportedBook(priceData)) {
    return { text: '导入', color: '#888' };
  }

  if (priceData.free) {
    return { text: '免费', color: '#07c160' };
  }

  if (priceData.centPrice != null) {
    const fen = priceData.centPrice;
    const yuan = fen % 100 === 0 ? String(fen / 100) : (fen / 100).toFixed(2);
    return { text: '¥' + yuan, color: '#e64340' };
  }

  return { text: '暂无价格', color: '#888' };
}

// 分类行文案：分类 + （可选）所属分组。两种视图共用，保证同一本书展示一致。
function categoryLineOf(meta) {
  const cat = formatCategory(meta && meta.category);
  const groups = meta && meta.bookId ? _archiveByBook.get(meta.bookId) : null;
  if (groups && groups.length > 0) {
    const g = groups.length > 1 ? `${groups[0]} 等${groups.length}个` : groups[0];
    return `${cat} · 分组：${g}`;
  }
  return cat;
}

/**
 * 书籍标签块（两行：评分/价格 + 分类），原生卡片与自绘卡片共用。
 */
function buildBookLabel(meta) {
  const label = document.createElement('div');
  label.className = PRICE_CLASS;
  label.style.cssText = 'font-size:12px;margin-top:4px;line-height:1.6;pointer-events:none';

  const priceDisplay = getPriceDisplay(meta);
  const rowStyle = 'display:flex;justify-content:space-between;align-items:center';
  const leftStyle = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0';
  const rightStyle = 'white-space:nowrap;flex-shrink:0;text-align:right';

  // Row 1: 评分1 / 评分2 | 价格
  const row1 = document.createElement('div');
  row1.style.cssText = rowStyle;
  const ratingSpan = document.createElement('span');
  ratingSpan.className = RATING_SPAN_CLASS;
  const ratings = [
    formatRatingValue(meta && meta.newRating),
    formatRatingValue(meta && meta.deepVRating),
  ].filter(Boolean);
  ratingSpan.textContent = ratings.length > 0 ? ratings.join(' / ') : '--';
  ratingSpan.style.cssText = `color:#faad14;${leftStyle}`;
  const priceSpan = document.createElement('span');
  priceSpan.className = PRICE_SPAN_CLASS;
  priceSpan.textContent = priceDisplay.text;
  priceSpan.style.cssText = `color:${priceDisplay.color};${rightStyle}`;
  row1.appendChild(ratingSpan);
  row1.appendChild(priceSpan);

  // Row 2: 分类（+ 所属分组）
  const row2 = document.createElement('div');
  row2.style.cssText = rowStyle;
  const catSpan = document.createElement('span');
  catSpan.className = CAT_CLASS;
  catSpan.textContent = categoryLineOf(meta);
  catSpan.style.cssText = `color:#888;${leftStyle}`;
  row2.appendChild(catSpan);

  label.appendChild(row1);
  label.appendChild(row2);
  return label;
}

function injectPriceLabel(card, priceData) {
  // 标记已处理，避免取数失败的卡片被反复重扫、反复发请求
  if (card.dataset) card.dataset.wrpDone = '1';
  if (card.querySelector('.' + PRICE_CLASS)) return;
  card.appendChild(buildBookLabel(priceData));
}

// ─── 核心流程 ─────────────────────────────────────────────────────────────────

async function scanAndInject() {
  if (!_domReady) return;              // 页面框架挂载完成前不碰它的 DOM

  const newCards = scanNewCards();
  if (newCards.length === 0) return;

  const bookIds = newCards.map(c => c.bookId);
  const prices = await fetchPrices(bookIds);

  for (const { element, bookId } of newCards) {
    injectPriceLabel(element, mergeBookMeta(bookId, prices[bookId] || null));
  }
}

// ─── MutationObserver ─────────────────────────────────────────────────────────

let _observer = null;
let _running = false;
let _pending = false;

async function _safeScanAndInject() {
  _pending = false;
  if (_running) {
    _pending = true;
    return;
  }
  _running = true;
  try {
    await scanAndInject();
  } finally {
    _running = false;
  }
  if (_pending) _safeScanAndInject();
}

function startObserver() {
  if (_observer) _observer.disconnect();
  if (!document.body) return;   // 极早期调用时 body 可能还不存在

  _observer = new MutationObserver(() => {
    _safeScanAndInject();
    maybeReapplySort();
  });

  _observer.observe(document.body, { childList: true, subtree: true });
}

function stopObserver() {
  if (_observer) {
    _observer.disconnect();
    _observer = null;
  }
  _pending = false;
}

// ─── 书架排序 ─────────────────────────────────────────────────────────────────

// dir 现在是「分组顺序」方向：asc = 按定义顺序 / 标签正序，desc = 反转
const SORT_TABS = [
  { key: 'default',  label: '默认',     dir: 'asc',  toggle: false },
  { key: 'rating',   label: '推荐值',   dir: 'desc', toggle: true },
  { key: 'title',    label: '书名',     dir: 'asc',  toggle: true },
  { key: 'category', label: '分类',     dir: 'asc',  toggle: true },
  { key: 'words',    label: '字数',     dir: 'desc', toggle: true },
  { key: 'pay',      label: '付费',     dir: 'asc',  toggle: true },
];

// 付费分组，与 App 一致（顺序即展示顺序）
const PAY_GROUPS = ['体验卡可读', '付费会员卡可读', '永久可读', '免费', '导入书籍'];

const SORT_BAR_CLASS = 'wrp-sort-bar';
const SORT_HOST_ID = 'wrp-sort-host';   // 排序栏宿主机，挂在 <html> 下，避开页面框架的 DOM 管理

/**
 * 所有 UI 的挂载点。
 *
 * 绝不能挂到 document.body：微信读书是 SSR + Vue 水合，body 的直接子节点会被
 * 按位置认领。插入外来节点会让 Vue 的 vnode.elm 错位成注释节点，进而在
 * appendChild 时抛 HierarchyRequestError，并导致页面滚动加载彻底失效。
 * 挂到 <html> 下（body 的兄弟节点）不参与其树的管理。
 */
function getUiRoot() {
  return document.documentElement || document.body;
}

/**
 * 等待页面自己的框架完成首屏挂载/水合。
 *
 * 微信读书的业务 chunk 以运行时 <script> 动态插入，Vue 的挂载发生在我们脚本
 * (document-idle) 之后。如果此时它的 SSR DOM 里已经有我们插入的节点，
 * 水合会按位置把 vnode 匹配到误差的节点（如 <!----> 注释节点），
 * 之后 patch 往注释节点 append 就会抛 HierarchyRequestError，
 * 并让页面的滚动加载彻底失效。
 *
 * 判定：连续 700ms 无 DOM 变动 且 已过最小等待时间；有兜底上限。
 * 慢网络下页面挂载更晚时，可用 localStorage["weread-wrp-wait"] = 毫秒数 调整最小等待。
 */
let _domReady = false;

const MIN_WAIT_KEY = 'weread-wrp-wait';
const MIN_WAIT_DEFAULT_MS = 2200;

function getMinWaitMs() {
  try {
    const v = parseInt(localStorage.getItem(MIN_WAIT_KEY), 10);
    if (Number.isFinite(v) && v >= 0 && v <= 30000) return v;
  } catch { /* 忽略 */ }
  return MIN_WAIT_DEFAULT_MS;
}

function whenDomQuiet() {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const minWait = getMinWaitMs();
    const maxWait = Math.max(6000, minWait + 2500);
    let lastMutation = Date.now();

    const obs = new MutationObserver(() => {
      lastMutation = Date.now();
    });
    if (document.body) obs.observe(document.body, { childList: true, subtree: true });

    const tick = () => {
      const elapsed = Date.now() - t0;
      const quiet = Date.now() - lastMutation;
      if ((elapsed >= minWait && quiet >= 700) || elapsed >= maxWait) {
        obs.disconnect();
        resolve();
      } else {
        setTimeout(tick, 150);
      }
    };
    setTimeout(tick, 150);
  });
}

let _sortState = { mode: 'default', dir: 'asc' };

let _sortRunning = false;        // applySort 进行中
let _applyPending = false;       // 排序进行中又有新请求 → 结束后补跑
let _lastBarCheck = 0;

function isShelfPage() {
  return location.pathname.indexOf('/web/shelf') === 0;
}

// 卡片越多越可能是真正的网格；直接子节点权重更高
function listScore(el) {
  const direct = el.querySelectorAll(':scope > .shelfBook, :scope > .shelfArchive').length;
  if (direct > 0) return direct * 2;
  return el.querySelectorAll('.shelfBook, .shelfArchive').length;
}

/**
 * 取真正的书籍网格 .shelf_list。
 * 页面可能存在多个 .shelf_list（routerView 缓存副本、头部横向列表等），
 * 只按「可见」判断会挑到空壳容器，导致排序排到错的元素上。
 */
function getShelfList() {
  const lists = Array.from(document.querySelectorAll('.shelf_list'));
  if (lists.length === 0) return null;

  let bestVisible = null;
  let bestVisibleScore = -1;
  let bestAny = null;
  let bestAnyScore = -1;

  for (const el of lists) {
    const score = listScore(el);
    const visible = el.offsetParent !== null || el.getClientRects().length > 0;
    if (visible && score > bestVisibleScore) { bestVisible = el; bestVisibleScore = score; }
    if (score > bestAnyScore) { bestAny = el; bestAnyScore = score; }
  }

  if (bestVisible && bestVisibleScore > 0) return bestVisible;
  if (bestAny && bestAnyScore > 0) return bestAny;
  return bestVisible || bestAny;
}

// 清掉页面上所有排序栏（含隐藏缓存视图里的残留副本）
function removeSortBars() {
  const bars = document.querySelectorAll('.' + SORT_BAR_CLASS);
  if (bars.length > 1) {
    console.warn(`[WeReadPrice] 发现 ${bars.length} 个重复排序栏，已全部清理`);
  }
  for (const bar of bars) bar.remove();
}

// ─── 合并后的书籍元数据 ───────────────────────────────────────────────────────

/**
 * 合成一本书的完整视图：
 * 档案字段取 A 层（永久缓存），购买状态取 B 层（shelf/sync，最新），
 * B 层缺失时回退到本次会话内 book/info 拿到的状态。
 */
function mergeBookMeta(bookId, info) {
  const idx = _shelfIndex ? _shelfIndex.get(bookId) : null;
  const fb = _dynFallback.get(bookId) || null;
  if (!info && !idx) return null;

  // 购买状态取「较新的那一份」：B 层是 shelf/sync 的抓取时刻(_stateTs)，
  // 兜底是本次会话 book/info 的抓取时刻，谁新用谁，避免刚买完书仍显示旧价。
  const dyn = (fb && (!idx || (fb.ts || 0) > _stateTs))
    ? fb
    : (idx || fb || null);

  return {
    ...(idx || {}),
    ...(info || {}),
    bookId,
    title: info?.title || idx?.title || '',
    author: info?.author || idx?.author || '',
    category: info?.category || idx?.category || '',
    bookType: dyn?.bookType ?? dyn?.type ?? 0,
    centPrice: dyn?.centPrice ?? null,
    payingStatus: dyn?.payingStatus ?? null,
    payType: dyn?.payType ?? null,
    paid: dyn?.paid ?? 0,
    free: !!dyn?.free,
    totalWords: info?.totalWords ?? null,
    rating: normalizeRating(info?.newRating),
    deepRating: normalizeRating(info?.deepVRating),
  };
}

/**
 * 评分统一为百分制（0-100）。微信读书 book/info 的 newRating/deepVRating 是
 * 「分数 × 100」的整数（918 → 9.18 分），也兼容百分制(88)与十分制(8.8)。
 * 0 / 空 / 负数视为无评分。
 */
function normalizeRating(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 100) return n / 10;   // 918 → 91.8
  if (n > 10) return n;         // 88  → 88
  return n * 10;                // 8.8 → 88
}

function getBookMeta(bookId) {
  return mergeBookMeta(bookId, getStatic(bookId));
}

// 返回百分制评分；无评分（null / 0 / 负数）返回 -1
function ratingOf(meta) {
  const r = Number(meta?.rating);
  const d = Number(meta?.deepRating);
  return Math.max(Number.isFinite(r) && r > 0 ? r : -1, Number.isFinite(d) && d > 0 ? d : -1);
}

/**
 * 付费分组，与 App 的「付费」tab 对齐。
 *
 * payType 是位标志（实测数据 + 与 App 逐本核对确认）：
 *   1 << 20 (1048576) → 付费会员卡可读
 *   1 << 12 (4096)    → 体验卡可读
 * 若以后与 App 不符，改这两个常量即可（可在控制台对比 shelf/sync 返回的 payType 分布）。
 */
const PAY_TYPE_PAID_CARD = 1 << 20;    // 1048576
const PAY_TYPE_TRIAL_CARD = 1 << 12;   // 4096

function isImportedBook(meta) {
  return meta.payingStatus === 0
    && meta.bookType !== 3                       // 3 = 公众号
    && !String(meta.bookId || '').startsWith('MP_');
}

function payGroupOf(meta) {
  if (!meta) return '导入书籍';
  if (isImportedBook(meta)) return '导入书籍';    // 导入的本地书（含已"购买"的导入书）
  if (meta.paid == 1) return '永久可读';
  if (meta.free) return '免费';                   // 含公众号内容

  const payType = Number(meta.payType) || 0;
  if (payType & PAY_TYPE_PAID_CARD) return '付费会员卡可读';
  if (payType & PAY_TYPE_TRIAL_CARD) return '体验卡可读';
  return '体验卡可读';
}

// ─── 分组（除「默认」外，所有 tab 都只做分组展示，不做条目级排序）──────────────

// 推荐值分档（百分制，与卡片上显示的评分同口径），与 App 一致：
// 90以上 / 85-90 / 80-85 / 70-80 / 50-70 / 30-50 / 评分不足
// 按 min 升序排列，取最后一个满足 value >= min 的区间
const RATING_BUCKETS = [
  { label: '评分不足', min: -1 },
  { label: '30 - 50 分', min: 30 },
  { label: '50 - 70 分', min: 50 },
  { label: '70 - 80 分', min: 70 },
  { label: '80 - 85 分', min: 80 },
  { label: '85 - 90 分', min: 85 },
  { label: '90 分以上', min: 90 },
];

// 字数分档，与 App 一致（单位：万字）
const WORD_BUCKETS = [
  { label: '未知字数', min: -1 },
  { label: '1 万字以下', min: 0 },
  { label: '1 - 3 万字', min: 10000 },
  { label: '3 - 5 万字', min: 30000 },
  { label: '5 - 10 万字', min: 50000 },
  { label: '10 - 20 万字', min: 100000 },
  { label: '20 - 30 万字', min: 200000 },
  { label: '30 - 50 万字', min: 300000 },
  { label: '50 - 100 万字', min: 500000 },
  { label: '100 万字以上', min: 1000000 },
];

function bucketLabel(buckets, value) {
  let label = buckets[0].label;
  for (const b of buckets) {
    if (value >= b.min) label = b.label;
  }
  return label;
}

// 固定顺序的 tab：组顺序按此数组（dir=desc 时反转）
function fixedGroupOrder(mode) {
  if (mode === 'pay') return PAY_GROUPS;
  if (mode === 'rating') return RATING_BUCKETS.map(b => b.label);
  if (mode === 'words') return WORD_BUCKETS.map(b => b.label);
  return null;
}

// 书名首字母分组：zh-Hans-CN 排序下汉字按拼音排列，
// 用各音节的边界字划分区间即可得到拼音首字母，无需拼音表。
// （拼音无 I / U / V 开头，故只有 23 组）
const PINYIN_BOUNDS = [
  ['A', '阿'], ['B', '八'], ['C', '擦'], ['D', '搭'], ['E', '鹅'], ['F', '发'],
  ['G', '噶'], ['H', '哈'], ['J', '击'], ['K', '喀'], ['L', '垃'], ['M', '妈'],
  ['N', '拿'], ['O', '哦'], ['P', '啪'], ['Q', '七'], ['R', '然'], ['S', '撒'],
  ['T', '他'], ['W', '挖'], ['X', '西'], ['Y', '压'], ['Z', '匝'],
];

const _zhCollator = (() => {
  try { return new Intl.Collator('zh-Hans-CN'); } catch { return null; }
})();

// 是否是汉字（含扩展区），非汉字一律归「#」，避免西里尔/希腊等字符被算进 Z 组
function isHanChar(ch) {
  const c = ch.codePointAt(0);
  return (c >= 0x4E00 && c <= 0x9FFF)
    || (c >= 0x3400 && c <= 0x4DBF)
    || (c >= 0xF900 && c <= 0xFAFF)
    || (c >= 0x20000 && c <= 0x2A6DF);
}

function titleInitialOf(meta) {
  const title = String(meta?.title || '').trim();
  if (!title) return '#';
  const ch = title[0];
  const lower = ch.toLowerCase();
  if (lower >= 'a' && lower <= 'z') return lower.toUpperCase();
  if (!isHanChar(ch) || !_zhCollator) return '#';
  let hit = null;
  for (const [letter, bound] of PINYIN_BOUNDS) {
    if (_zhCollator.compare(ch, bound) >= 0) hit = letter;
  }
  return hit || '#';   // 拼音无 I / U / V 开头，其余归「#」
}

// 分类按「大类」聚合：接口的 category 形如「生活百科-手工」，取短横线前的大类
function mainCategoryOf(category) {
  const text = String(category || '').trim();
  if (!text) return '未分类';
  const main = text.split(/[-－—]/)[0].trim();
  return main || '未分类';
}

function groupLabelOf(mode, meta) {
  switch (mode) {
    case 'category': return mainCategoryOf(meta && meta.category);
    case 'pay': return payGroupOf(meta);
    case 'rating': return bucketLabel(RATING_BUCKETS, ratingOf(meta));
    case 'words': {
      const w = (meta && meta.totalWords != null && meta.totalWords > 0) ? meta.totalWords : -1;
      return bucketLabel(WORD_BUCKETS, w);
    }
    case 'title': return titleInitialOf(meta);
    default: return '';
  }
}

function compareGroupLabels(mode, a, b) {
  const fixed = fixedGroupOrder(mode);
  if (fixed) return fixed.indexOf(a) - fixed.indexOf(b);
  if (mode === 'title') {
    if (a === b) return 0;
    if (a === '#') return 1;
    if (b === '#') return -1;
    return a < b ? -1 : 1;
  }
  const sa = String(a);
  const sb = String(b);
  // 分组名是短标签，用同一个 collator 复用缓存，避免每次新建 localeCompare
  return _zhCollator
    ? _zhCollator.compare(sa, sb)
    : sa.localeCompare(sb, 'zh-Hans-CN', { numeric: true });
}

/**
 * 把书卡按 mode 分组：组顺序按固定表 / 标签序，组内保持页面原序（不排序）。
 * @param {{el: Element, meta: object|null, seq: number}[]} items
 * @returns {{label: string, items: object[]}[]}
 */
function buildGroups(items, mode, dir) {
  const map = new Map();
  for (const it of items) {
    const label = groupLabelOf(mode, it.meta);
    if (!map.has(label)) map.set(label, []);
    map.get(label).push(it);
  }

  const labels = Array.from(map.keys()).sort((a, b) => compareGroupLabels(mode, a, b));
  if (dir === 'desc') labels.reverse();
  // 兜底分组（「#」非中文书名、「未分类」）无论正反序都放最后
  const tailLabel = mode === 'title' ? '#' : (mode === 'category' ? '未分类' : null);
  if (tailLabel) {
    const i = labels.indexOf(tailLabel);
    if (i >= 0) { labels.splice(i, 1); labels.push(tailLabel); }
  }

  return labels.map(label => ({
    label,
    items: map.get(label).slice().sort((a, b) => a.seq - b.seq),   // 组内保持原序
  }));
}

// ─── 自绘浏览视图 ─────────────────────────────────────────────────────────────
// 非默认 tab：隐藏原生 .shelf_list（单个元素 + 单个内联样式，完全可逆），
// 在它后面插入我们自己的容器，渲染「全部」书籍（含分组内的 895 本）。
// 原生 DOM 的节点顺序从不改动，切回「默认」只需移除容器并恢复 display。

const BROWSE_ROOT_CLASS = 'wrp-browse-root';
const BROWSE_CHUNK = 120;          // 每批渲染卡片数
const BROWSE_RERENDER_MS = 2500;   // 档案补齐期间的重排节流
const COLLAPSED_KEY = 'weread-browse-collapsed-v1';

let _browse = {
  active: false,
  mode: null,
  dir: 'asc',
  root: null,
  sentinel: null,
  observer: null,
  groups: [],
  groupIndex: 0,
  itemIndex: 0,
  gridEl: null,
  rendered: 0,
  total: 0,
  nativeList: null,
  nativeLoading: null,
  rerenderTimer: 0,
  fillTimer: 0,
  collapsed: null,   // Set<"mode|分组名">
  buildHost: null,      // 重建期间的离屏容器（非 null 表示正在重建）
  buildSentinel: null,
};

function collapseKey(mode, label) {
  return mode + '|' + label;
}

function loadCollapsed() {
  if (_browse.collapsed) return _browse.collapsed;
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]');
    _browse.collapsed = new Set(Array.isArray(raw) ? raw : []);
  } catch {
    _browse.collapsed = new Set();
  }
  return _browse.collapsed;
}

function saveCollapsed() {
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(Array.from(loadCollapsed()))); } catch { /* 忽略 */ }
}

// 分组折叠：点击分组标题切换
function onBrowseRootClick(e) {
  const heading = e.target && e.target.closest ? e.target.closest('.wrp-browse-group-title') : null;
  if (!heading) return;
  const section = heading.parentElement;
  if (!section || !section.classList.contains('wrp-browse-group')) return;

  const label = section.dataset.wrpGroup || '';
  const collapsed = section.classList.toggle('is-collapsed');
  const key = collapseKey(_browse.mode, label);
  const set = loadCollapsed();
  if (collapsed) set.add(key); else set.delete(key);
  saveCollapsed();
  if (!collapsed) scheduleBrowseFill();
  updateBulkButton();
}

// ─── 全部折叠 / 全部展开 ──────────────────────────────────────────────────────

// 当前排序下出现过的所有分组名（含尚未渲染出来的）
function browseGroupLabels() {
  const labels = new Set();
  for (const g of (_browse.groups || [])) labels.add(g.label);
  if (_browse.root) {
    for (const s of _browse.root.querySelectorAll('.wrp-browse-group')) {
      labels.add(s.dataset.wrpGroup || '');
    }
  }
  return labels;
}

function allGroupsCollapsed() {
  const labels = browseGroupLabels();
  if (labels.size === 0) return false;
  const set = loadCollapsed();
  for (const label of labels) {
    if (!set.has(collapseKey(_browse.mode, label))) return false;
  }
  return true;
}

function updateBulkButton(barEl) {
  const bar = barEl || getSortBar();
  if (!bar) return;
  const btn = bar.querySelector('.wrp-sort-bulk');
  if (!btn) return;

  // 只在分组视图（非默认 tab）里有意义
  const usable = _browse.active && _browse.root && browseGroupLabels().size > 0;
  btn.style.display = usable ? '' : 'none';
  if (!usable) return;
  btn.textContent = allGroupsCollapsed() ? '全部展开' : '全部折叠';
}

function onBulkToggleClick() {
  if (!_browse.active || !_browse.root) return;

  const collapse = !allGroupsCollapsed();   // 还有展开的 → 全部折叠
  const set = loadCollapsed();
  for (const label of browseGroupLabels()) {
    const key = collapseKey(_browse.mode, label);
    if (collapse) set.add(key); else set.delete(key);
  }
  saveCollapsed();

  // 已渲染的分组立即生效（含尚未渲染的：状态已写入，渲染时自然继承）
  const sections = Array.from(_browse.root.querySelectorAll('.wrp-browse-group'));
  for (const s of sections) s.classList.toggle('is-collapsed', collapse);

  updateBulkButton();
  updateSortStatus(statusText());
  if (!collapse) scheduleBrowseFill();
}

function readerHrefOf(bookId) {
  const idx = _shelfIndex ? _shelfIndex.get(bookId) : null;
  const deepLink = idx && idx.deepLink;
  if (deepLink) {
    const m = /[?&]v=([^&]+)/.exec(deepLink);
    if (m) {
      // deepLink 的 v 参数与 /web/reader/<encodedId> 同构，校验通过才用（可走 SPA 路由）
      try { if (parseId(m[1]) === bookId) return '/web/reader/' + m[1]; } catch { /* 格式不符 */ }
    }
    return deepLink;
  }
  return '/web/reader/' + bookId;
}

/**
 * 网格参数：直接量原生书架的排版，保证自绘视图与「默认」布局一致。
 * 原生为 flex-wrap + 固定卡宽，量出「每行几张 / 卡宽 / 横纵间隙」即可 1:1 复刻。
 * 浏览模式下原生列表已隐藏（量不到），此时用缓存值 + 当前容器宽度重算列数。
 */
const MAX_COLS = 7;                         // 一行最多 7 本
const GRID_DEFAULT = { cols: MAX_COLS, cardWidth: 104, gapX: 14, gapY: 20, avail: 0 };
let _gridCache = null;

function gridHostWidth() {
  const list = getShelfList();
  const host = (list && list.parentElement) || document.querySelector('.shelf_container');
  if (host && host.clientWidth > 0) return host.clientWidth;
  return 0;
}

function measureNativeGrid() {
  const list = getShelfList();
  if (!list) return _gridCache;

  const cards = [];
  for (const el of list.querySelectorAll(':scope > .shelfBook')) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) cards.push(r);
  }
  if (cards.length === 0) return _gridCache;

  // 列数：按左边界聚类。同一列 left 必然相同；不能按 top 判断同一行 ——
  // 书名 1~2 行导致卡片高度不同，垂直居中时同一行的 top 会差十几像素，会漏数。
  const lefts = [];
  for (const r of cards) {
    if (!lefts.some(x => Math.abs(x - r.left) < 3)) lefts.push(r.left);
  }
  lefts.sort((a, b) => a - b);
  if (lefts.length === 0) return _gridCache;

  const widths = cards.map(r => r.width).sort((a, b) => a - b);
  const cardWidth = Math.round(widths[Math.floor(widths.length / 2)]);   // 中位数，抗异常卡

  // 横间隙：相邻列间距的最小值 − 卡宽
  let gapX = GRID_DEFAULT.gapX;
  if (lefts.length >= 2) {
    let step = Infinity;
    for (let i = 1; i < lefts.length; i++) step = Math.min(step, lefts[i] - lefts[i - 1]);
    const g = Math.round(step - cardWidth);
    if (g >= 0 && g <= 120) gapX = g;
  }

  // 纵间隙：前两行（top 聚类，容差放宽到 40px）的间距 − 首行最高的卡
  let gapY = GRID_DEFAULT.gapY;
  const rowTops = [];
  for (const r of cards) {
    if (!rowTops.some(t => Math.abs(t - r.top) < 40)) rowTops.push(r.top);
  }
  rowTops.sort((a, b) => a - b);
  if (rowTops.length >= 2) {
    const firstRow = cards.filter(r => Math.abs(r.top - rowTops[0]) < 40);
    const maxH = Math.max.apply(null, firstRow.map(r => r.height));
    const g = Math.round(rowTops[1] - rowTops[0] - maxH);
    if (g >= 0 && g <= 200) gapY = g;
  }

  _gridCache = {
    cols: Math.min(MAX_COLS, lefts.length),
    cardWidth,
    gapX,
    gapY,
    // 量测时的容器宽度：宽度没变时列数必须原样等于原生每行张数，
    // 保证在任意 tab 下自绘视图的排版完全一致
    avail: Math.round(gridHostWidth()),
  };
  return _gridCache;
}

function computeGridMetrics() {
  // 原生量测值优先（权威），只在容器宽度变化时按比例缩放列数
  const measured = measureNativeGrid();
  const base = measured || _gridCache || GRID_DEFAULT;
  const avail = gridHostWidth();
  let cols = base.cols;
  if (avail > 0 && base.avail > 0 && Math.abs(avail - base.avail) > 1) {
    cols = Math.round(base.cols * avail / base.avail);
  }
  cols = Math.max(1, Math.min(MAX_COLS, cols || MAX_COLS));
  return { cols, cardWidth: base.cardWidth, gapX: base.gapX, gapY: base.gapY };
}

// metrics 可复用同一批渲染结果，避免每段网格都触发一次布局读取
function applyGridMetrics(grid, metrics) {
  const g = metrics || computeGridMetrics();
  grid.style.gridTemplateColumns = `repeat(${g.cols}, ${g.cardWidth}px)`;
  grid.style.columnGap = g.gapX + 'px';
  grid.style.rowGap = g.gapY + 'px';
  grid.style.justifyContent = 'start';
}

// 窗口尺寸变化后，已渲染的网格重新按新列数排版
function refreshRenderedGrids() {
  if (!_browse.active || !_browse.root) return;
  for (const grid of _browse.root.querySelectorAll('.wrp-browse-grid')) applyGridMetrics(grid);
}

function buildBrowseItem(bookId, seq) {
  return { bookId, seq, meta: getBookMeta(bookId), idx: _shelfIndex.get(bookId) };
}

function buildAllItems() {
  const items = [];
  if (!_shelfIndex) return items;
  let seq = 0;
  for (const bookId of _shelfIndex.keys()) items.push(buildBrowseItem(bookId, seq++));
  return items;
}

/**
 * 自绘卡片：结构与「默认」视图的原生卡片保持一致 ——
 * 封面 / 书名 / 作者 / 统一的标签块。
 */
function buildBookCard(item) {
  const meta = item.meta || {};
  const idx = item.idx || {};
  const card = document.createElement('a');
  card.className = 'wrp-card';
  card.href = readerHrefOf(item.bookId);
  if (meta.title) card.title = meta.title;

  const cover = document.createElement('div');
  cover.className = 'wrp-card-cover';
  if (idx.cover) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = idx.cover;
    img.alt = meta.title || '';
    cover.appendChild(img);
  }
  card.appendChild(cover);

  const title = document.createElement('div');
  title.className = 'wrp-card-title';
  title.textContent = meta.title || '（无书名）';
  card.appendChild(title);

  const author = document.createElement('div');
  author.className = 'wrp-card-author';
  author.textContent = meta.author || '';
  card.appendChild(author);

  card.appendChild(buildBookLabel(meta));
  return card;
}

function renderBrowseMore() {
  if (!_browse.active || !_browse.root) return;
  const groups = _browse.groups;
  const collapsedSet = loadCollapsed();
  const metrics = computeGridMetrics();   // 本批新建的网格共用一份量测结果
  let count = 0;

  while (_browse.groupIndex < groups.length && count < BROWSE_CHUNK) {
    const group = groups[_browse.groupIndex];

    if (_browse.itemIndex === 0) {
      const section = document.createElement('section');
      section.className = 'wrp-browse-group';
      section.dataset.wrpGroup = group.label;
      if (collapsedSet.has(collapseKey(_browse.mode, group.label))) {
        section.classList.add('is-collapsed');
      }

      const heading = document.createElement('div');
      heading.className = 'wrp-browse-group-title';
      const caret = document.createElement('span');
      caret.className = 'wrp-browse-caret';
      caret.textContent = '▾';
      heading.appendChild(caret);
      const text = document.createElement('span');
      text.textContent = `${group.label} · ${group.items.length} 本`;
      heading.appendChild(text);
      section.appendChild(heading);

      _browse.gridEl = document.createElement('div');
      _browse.gridEl.className = 'wrp-browse-grid';
      applyGridMetrics(_browse.gridEl, metrics);
      section.appendChild(_browse.gridEl);
      // 重建期间先写进离屏容器，构建完成再整体替换（见 commitBuild）
      buildTarget().insertBefore(section, buildSentinel());
    }

    while (_browse.itemIndex < group.items.length && count < BROWSE_CHUNK) {
      _browse.gridEl.appendChild(buildBookCard(group.items[_browse.itemIndex]));
      _browse.itemIndex++;
      _browse.rendered++;
      count++;
    }

    if (_browse.itemIndex >= group.items.length) {
      _browse.groupIndex++;
      _browse.itemIndex = 0;
    }
  }
  updateSortStatus(statusText());
  updateBulkButton();

  // 若哨兵仍在可视范围内（分组被折叠、组内书少等情况），继续填充
  if (!_browse.buildHost
    && _browse.groupIndex < groups.length
    && _browse.fillTimer === 0) {
    const r = _browse.sentinel.getBoundingClientRect();
    if (r.top < window.innerHeight + 800) scheduleBrowseFill();
  }
}

// 重建时的写入目标：离屏容器（不碰页面 DOM），否则就是真实容器
function buildTarget() {
  return _browse.buildHost || _browse.root;
}

function buildSentinel() {
  return _browse.buildHost ? _browse.buildSentinel : _browse.sentinel;
}

/**
 * 提交重建结果：把离屏容器里的分组一次性搬进真实容器。
 *
 * 为什么要离屏构建：整段重建若先删后建，页面高度会瞬时归零 ——
 * 垂直滚动条随之消失，`margin:auto` 居中的站点内容（含顶部导航/标题）
 * 会整体横向偏移几个像素，看起来就是「切换 tab 后左边距变了」。
 */
function commitBuild() {
  const host = _browse.buildHost;
  if (!host) return;
  _browse.buildHost = null;
  _browse.buildSentinel = null;
  if (!_browse.root) return;

  for (const n of Array.from(_browse.root.querySelectorAll('.wrp-browse-group'))) n.remove();
  for (const section of Array.from(host.children)) {
    if (!section.classList || !section.classList.contains('wrp-browse-group')) continue;
    _browse.root.insertBefore(section, _browse.sentinel);
  }
}

function scheduleBrowseFill() {
  if (_browse.fillTimer) return;
  _browse.fillTimer = setTimeout(() => {
    _browse.fillTimer = 0;
    if (_browse.active) renderBrowseMore();
  }, 60);
}

function renderBrowse(reset) {
  if (!_browse.active || !_browse.root) return;
  let keepRendered = 0;

  if (reset) {
    keepRendered = _browse.rendered;   // 保留已展开深度，避免补齐数据时视图跳回顶部
    _browse.groups = buildGroups(buildAllItems(), _browse.mode, _browse.dir);
    _browse.groupIndex = 0;
    _browse.itemIndex = 0;
    _browse.gridEl = null;
    _browse.rendered = 0;
    _browse.total = _browse.groups.reduce((sum, g) => sum + g.items.length, 0);

    // 离屏重建：旧内容留在页面上，构建完于 commitBuild() 一次性替换。
    // 先删后建会让页面高度瞬时归零 → 滚动条消失 → 整页横向跳动。
    _browse.buildHost = document.createElement('div');
    _browse.buildSentinel = document.createElement('div');
    _browse.buildHost.appendChild(_browse.buildSentinel);
  }

  if (_browse.groupIndex >= _browse.groups.length) {
    commitBuild();
    return;
  }
  renderBrowseMore();

  let guard = 0;
  while (keepRendered > 0
    && _browse.rendered < keepRendered
    && _browse.groupIndex < _browse.groups.length
    && guard++ < 200) {
    renderBrowseMore();
  }
  commitBuild();
}

function scheduleBrowseRerender() {
  if (!_browse.active || _browse.rerenderTimer) return;
  _browse.rerenderTimer = setTimeout(() => {
    _browse.rerenderTimer = 0;
    if (_browse.active) {
      const mode = _browse.mode;
      renderBrowse(true);
      if (_browse.mode === mode) updateSortStatus(statusText());
    }
  }, BROWSE_RERENDER_MS);
}

function createBrowseRoot() {
  if (_browse.observer) { _browse.observer.disconnect(); _browse.observer = null; }
  const root = document.createElement('div');
  root.className = BROWSE_ROOT_CLASS;
  const sentinel = document.createElement('div');
  sentinel.className = 'wrp-browse-sentinel';
  root.appendChild(sentinel);
  root.addEventListener('click', onBrowseRootClick);
  _browse.sentinel = sentinel;

  _browse.observer = new IntersectionObserver((entries) => {
    if (entries.some(e => e.isIntersecting)) renderBrowseMore();
  }, { rootMargin: '800px 0px' });
  _browse.observer.observe(sentinel);
  return root;
}

/**
 * 常驻预留垂直滚动条宽度。
 *
 * 站点内容是 `margin: 0 auto` 居中的，滚动条的有无会让可用宽度差 15px、
 * 居中内容整体横移 7.5px。自绘视图里「折叠/展开分组」「补齐数据重建」都会
 * 改变页面高度，滚动条就会时有时无 —— 表现就是「切 tab 后左边距变了、
 * 顶部导航也跟着偏」。
 *
 * 浏览模式下强制 `overflow-y: scroll`，滚动条宽度恒定，横向就不再有跳动；
 * 退出自绘视图时原样还原（只动 html 的内联样式，不碰站点样式表）。
 */
const SCROLLBAR_PIN_ATTR = 'data-wrp-scrollbar';

function pinScrollbarSpace(on) {
  const el = document.documentElement;
  if (!el) return;

  if (on) {
    if (el.getAttribute(SCROLLBAR_PIN_ATTR) !== null) return;   // 已固定
    el.setAttribute(SCROLLBAR_PIN_ATTR, el.style.overflowY || '');
    el.style.overflowY = 'scroll';
    return;
  }

  if (el.getAttribute(SCROLLBAR_PIN_ATTR) === null) return;
  const prev = el.getAttribute(SCROLLBAR_PIN_ATTR);
  el.removeAttribute(SCROLLBAR_PIN_ATTR);
  el.style.overflowY = prev || '';
}

function enterBrowse() {
  const list = getShelfList();
  const container = list && list.parentElement;
  if (!container) return false;

  // 隐藏原生列表前先把排版量下来（卡宽/间隙/每行张数），否则之后量不到
  measureNativeGrid();

  if (!_browse.root || !_browse.root.isConnected) {
    const root = createBrowseRoot();
    container.insertBefore(root, list.nextSibling);
    _browse.root = root;
  }

  list.style.display = 'none';
  _browse.nativeList = list;
  const loading = container.querySelector('.shelfBook_loadingView');
  if (loading) {
    loading.style.display = 'none';
    _browse.nativeLoading = loading;
  }
  _browse.active = true;
  _browse.mode = _sortState.mode;
  _browse.dir = _sortState.dir;
  pinScrollbarSpace(true);
  return true;
}

// 页面重渲染后校正挂载：原生列表必须仍隐藏，我们的容器仍在原位
function refreshBrowseAttachment() {
  if (!_browse.active) return;
  const container = _browse.nativeList && _browse.nativeList.parentElement;
  if (!container) return;

  if (_browse.nativeList.style.display !== 'none') {
    _browse.nativeList.style.display = 'none';
  }
  if (!_browse.root || !_browse.root.isConnected) {
    _browse.root = createBrowseRoot();
    container.insertBefore(_browse.root, _browse.nativeList.nextSibling);
    renderBrowse(true);   // 容器是新的，内容全部重建
  }
}

function exitBrowse() {
  if (!_browse.active) return;
  _browse.active = false;
  // 注意：不在这里解除滚动条预留 —— 仍在书架页，默认 tab 也要保持同一宽度
  if (_browse.rerenderTimer) { clearTimeout(_browse.rerenderTimer); _browse.rerenderTimer = 0; }
  if (_browse.fillTimer) { clearTimeout(_browse.fillTimer); _browse.fillTimer = 0; }
  if (_browse.observer) { _browse.observer.disconnect(); _browse.observer = null; }
  if (_browse.root) { _browse.root.remove(); _browse.root = null; }
  if (_browse.nativeList) { _browse.nativeList.style.display = ''; _browse.nativeList = null; }
  if (_browse.nativeLoading) { _browse.nativeLoading.style.display = ''; _browse.nativeLoading = null; }
  _browse.groups = [];
  _browse.rendered = 0;
  _browse.buildHost = null;
  _browse.buildSentinel = null;
  updateBulkButton();   // 非分组视图 → 收起「全部折叠」按钮
  // 清理旧版本留在原生列表里的分组标题
  for (const h of document.querySelectorAll('.' + GROUP_CLASS)) h.remove();
}

// ─── 排序栏 UI ────────────────────────────────────────────────────────────────

const SORT_STYLES = `
#wrp-sort-host {
  position: fixed;
  top: 0;
  left: 0;
  right: auto;
  bottom: auto;
  z-index: 99985;
  pointer-events: none;
  max-width: 100vw;
}
.wrp-sort-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 12px;
  background: #fff;
  border: 1px solid #ececec;
  border-radius: 0 0 12px 12px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.1);
  pointer-events: auto;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
.wrp-sort-tab {
  font-size: 13px;
  line-height: 1.6;
  padding: 3px 12px;
  border: 1px solid transparent;
  border-radius: 14px;
  background: #f4f5f7;
  color: #555;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s;
}
.wrp-sort-tab:hover { background: #e9eaed; }
.wrp-sort-tab.is-active {
  background: #e8f8ee;
  border-color: #07c160;
  color: #07c160;
  font-weight: 600;
}
/* 定宽 + 常驻：↑↓ 宽度一致，非当前 tab 仅透明隐藏，保证切换时布局不跳动 */
.wrp-sort-arrow {
  display: inline-block;
  min-width: 10px;
  margin-left: 3px;
  font-size: 11px;
  text-align: center;
  opacity: 0.75;
}
.wrp-sort-refresh,
.wrp-sort-bulk {
  flex: 0 0 auto;
  font-size: 12px;
  line-height: 1.6;
  padding: 3px 10px;
  border: 1px solid #dcdfe6;
  border-radius: 14px;
  background: #fff;
  color: #666;
  white-space: nowrap;
  cursor: pointer;
}
.wrp-sort-refresh:hover,
.wrp-sort-bulk:hover { border-color: #07c160; color: #07c160; }
/* 状态文字占据 tab 与刷新按钮之间的剩余空间，靠右显示；空间不足才省略 */
.wrp-sort-status {
  flex: 1 1 auto;
  min-width: 0;
  text-align: right;
  font-size: 12px;
  color: #999;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wrp-sort-divider {
  flex: 0 0 auto;
  width: 1px;
  height: 16px;
  background: #e5e5e5;
  margin: 0 2px;
}
/* 自绘浏览视图 */
.wrp-browse-root {
  width: 100%;
  padding: 4px 0 60px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
.wrp-browse-group-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  color: #333;
  padding: 16px 2px 8px;
  border-bottom: 1px solid #ececec;
  margin-bottom: 14px;
  cursor: pointer;
  user-select: none;
}
.wrp-browse-group-title:hover { color: #07c160; }
/* 列数/间隙由 applyGridMetrics 按原生排版写成内联样式，这里只兜底 */
.wrp-browse-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: 20px 14px;
}
.wrp-card {
  display: block;
  text-decoration: none;
  color: inherit;
  min-width: 0;
}
.wrp-card-cover {
  width: 100%;
  aspect-ratio: 3 / 4;
  background: #f2f3f5;
  border-radius: 4px;
  overflow: hidden;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
}
.wrp-card-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.wrp-card-title {
  font-size: 12px;
  line-height: 1.35;
  color: #333;
  margin-top: 6px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.wrp-card-author {
  font-size: 11px;
  line-height: 1.35;
  color: #999;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wrp-browse-sentinel { height: 1px; }
.wrp-browse-caret {
  font-size: 11px;
  color: #bbb;
  transition: transform 0.15s;
}
.wrp-browse-group.is-collapsed .wrp-browse-caret { transform: rotate(-90deg); }
.wrp-browse-group.is-collapsed .wrp-browse-grid { display: none; }
`;

function injectSortStyles() {
  if (document.getElementById('wrp-sort-styles')) return;
  const style = document.createElement('style');
  style.id = 'wrp-sort-styles';
  style.textContent = SORT_STYLES;
  document.head.appendChild(style);
}

/**
 * 排序栏放在自己的宿主机里，宿主机挂到 <html> 下（见 getUiRoot），
 * 绝不进入页面框架管理的子树。
 *
 * 原因：微信读书是 Vue SSR + 水合渲染，body / .shelf_container 的直接子节点
 * 都会被按位置认领。外来节点一旦占位，Vue 的 vnode.elm 就会错位成注释节点
 * （表现为排序栏被改造成 .shelf_list、appendChild 抛 HierarchyRequestError、
 * 页面滚动加载失效）。
 */
function getSortHost() {
  const root = getUiRoot();
  let host = document.getElementById(SORT_HOST_ID);
  if (host && host.parentElement !== root) {
    // 旧版本残留在 body 里的宿主机 → 搬到 <html> 下
    root.appendChild(host);
  }
  if (!host) {
    host = document.createElement('div');
    host.id = SORT_HOST_ID;
    root.appendChild(host);
  }
  return host;
}

function createSortBar() {
  const bar = document.createElement('div');
  bar.className = SORT_BAR_CLASS;
  if (bar.dataset) bar.dataset.wrpBar = '1';   // 被页面框架改写 class 后仍可识别
  bar.innerHTML = SORT_TABS.map(t =>
    `<button type="button" class="wrp-sort-tab" data-mode="${t.key}">${t.label}` +
    `${t.toggle ? '<span class="wrp-sort-arrow"></span>' : ''}</button>`
  ).join('') +
    '<span class="wrp-sort-status"></span>' +
    '<span class="wrp-sort-divider"></span>' +
    '<button type="button" class="wrp-sort-bulk" style="display:none" title="折叠或展开当前排序下的所有分组">全部折叠</button>' +
    '<button type="button" class="wrp-sort-refresh" title="重新拉取购买状态与价格">刷新状态</button>';

  bar.addEventListener('click', (e) => {
    if (!e.target || !e.target.closest) return;
    if (e.target.closest('.wrp-sort-refresh')) {
      onRefreshStateClick();
      return;
    }
    if (e.target.closest('.wrp-sort-bulk')) {
      onBulkToggleClick();
      return;
    }
    const btn = e.target.closest('.wrp-sort-tab');
    if (btn) onSortTabClick(btn.dataset.mode);
  });
  updateBulkButton(bar);   // 此时 bar 还没入 DOM，需要显式传入
  return bar;
}

/**
 * 清理被页面框架"收养"的旧排序栏：我插进去的 div 被 Vue 按位置认领、
 * class 被覆写成 shelf_list，于是它成了 Vue 眼中的列表容器。
 *
 * 只摘掉"我们自己注入的子节点"，绝不动这个元素本身：
 * 它是 Vue 的列表容器，一旦被 display:none 或删除，
 * 后续懒加载出来的书会被追加进去却看不见（表现为一直 loading）。
 */
function cleanupAdoptedRemnants() {
  const OUR_CLASSES = ['wrp-sort-label', 'wrp-sort-tab', 'wrp-sort-refresh', 'wrp-sort-bulk', 'wrp-sort-status'];
  for (const el of document.querySelectorAll('.shelf_list')) {
    if (listScore(el) > 0) continue;   // 真网格，别碰
    const isOurs = (el.dataset && el.dataset.wrpBar === '1')
      || OUR_CLASSES.some(c => el.querySelector('.' + c));
    if (!isOurs) continue;

    let removed = 0;
    for (const child of Array.from(el.children)) {
      if (OUR_CLASSES.some(c => child.classList && child.classList.contains(c))) {
        child.remove();
        removed++;
      }
    }
    if (el.dataset) el.dataset.wrpBar = '';
    if (removed > 0) {
      console.warn(`[WeReadPrice] 已从被页面改造成 .shelf_list 的旧排序栏中摘除 ${removed} 个残留节点（元素本身保留）`);
    }
  }
}

function ensureSortBar() {
  if (!isShelfPage() || !_domReady) return null;

  try {
    injectSortStyles();
    cleanupAdoptedRemnants();

    const host = getSortHost();

    // 任何不在宿主内的排序栏都是异常残留，清掉
    for (const b of document.querySelectorAll('.' + SORT_BAR_CLASS)) {
      if (b.parentElement !== host) {
        console.warn('[WeReadPrice] 清理异常位置的排序栏');
        b.remove();
      }
    }

    let bar = host.querySelector('.' + SORT_BAR_CLASS);
    if (!bar) {
      bar = createSortBar();
      host.appendChild(bar);
      updateSortTabs();
      updateSortStatus(statusText());
    } else {
      updateSortTabs();
    }
    updateBulkButton(bar);

    host.style.display = '';
    pinScrollbarSpace(true);   // 书架页全程预留滚动条宽度（默认 / 分组 tab 一致）
    scheduleSortBarPosition();
    return bar;
  } catch (err) {
    console.warn('[WeReadPrice] 排序栏创建失败', err);
    return null;
  }
}

function hideSortBar() {
  const host = document.getElementById(SORT_HOST_ID);
  if (host) host.style.display = 'none';
  removeSortBars();
  pinScrollbarSpace(false);   // 离开书架页一定还原，避免残留影响站点其它页面
}

// ─── 顶部悬浮定位：贴在站点导航栏下方，宽度对齐书籍网格 ──────────────────────

let _posRaf = 0;

function scheduleSortBarPosition() {
  if (_posRaf) return;
  _posRaf = requestAnimationFrame(() => {
    _posRaf = 0;
    positionSortBar();
  });
}

let _anchorCache = null;   // 最近一次测到的内容列 { left, width }

function docClientWidth() {
  return document.documentElement.clientWidth;
}

// 元素的内容盒（去掉自身内边距）—— 站点用 max-width + margin:auto 居中这一列
function contentBoxOf(el) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 0) return null;
  const cs = getComputedStyle(el);
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const width = r.width - padL - padR;
  if (width <= 0) return null;
  return { left: r.left + padL, width };
}

/**
 * 悬浮条横向对齐的参照矩形。
 *
 * 对齐目标是「内容列」而不是 `.shelf_list` 本身：原生给列表设了
 * `margin-left: -36px`（抵消卡片自带内边距），列表盒比内容列更宽更靠左，
 * 直接用它会出现「左边凸出、右边顶到窗口」的错位。
 * 内容列 = 列表父元素的 content box，与站点标题、用户信息、书架卡片同一列。
 *
 * 缓存里同时记录当时的可用宽度：滚动条出现/消失会让居中内容整体平移
 * 「滚动条宽度 / 2」，此时必须同步修正缓存值。
 */
function contentAnchorRect() {
  const list = getShelfList();
  const container = (list && list.parentElement)
    || document.querySelector('.shelf_container')
    || document.querySelector('.app_content');

  const rect = contentBoxOf(container);
  if (rect) {
    _anchorCache = { left: rect.left, width: rect.width, clientWidth: docClientWidth() };
    return rect;
  }

  if (_anchorCache) {
    const dw = docClientWidth();
    if (_anchorCache.clientWidth && _anchorCache.clientWidth !== dw) {
      const shift = (_anchorCache.clientWidth - dw) / 2;
      _anchorCache = { left: _anchorCache.left - shift, width: _anchorCache.width, clientWidth: dw };
    }
    return { left: _anchorCache.left, width: _anchorCache.width };
  }

  // 首次进入就停在非默认 tab：用自绘容器兜底，并缓存下来
  const fallback = contentBoxOf(_browse.active && _browse.root ? _browse.root : null);
  if (fallback) {
    _anchorCache = { left: fallback.left, width: fallback.width, clientWidth: docClientWidth() };
    return fallback;
  }
  return null;
}

function positionSortBar() {
  const host = document.getElementById(SORT_HOST_ID);
  if (!host || host.style.display === 'none') return;

  // 1. 纵向：导航栏仍吸在顶部就贴它下面，否则贴视口顶部
  let top = 0;
  const nav = document.querySelector('.navBar');
  if (nav) {
    const r = nav.getBoundingClientRect();
    if (r.bottom > 0 && r.bottom < 200) top = r.bottom;
  }

  // 2. 横向：对齐内容列。浏览模式下原生列表已隐藏（rect 全 0），改用自绘容器
  let left = 0;
  let width = 0;
  const rect = contentAnchorRect();
  if (rect) {
    left = Math.max(0, Math.round(rect.left));
    width = Math.round(Math.min(rect.width, window.innerWidth - left));
  }

  host.style.top = Math.round(top) + 'px';
  host.style.left = left + 'px';
  host.style.right = 'auto';
  host.style.width = width > 0 ? width + 'px' : 'auto';
}

window.addEventListener('scroll', scheduleSortBarPosition, { passive: true, capture: true });
window.addEventListener('resize', () => {
  scheduleSortBarPosition();
  // 只有窗口尺寸变化才需要重算网格列数；滚动时重算会造成布局抖动
  refreshRenderedGrids();
});

function onSortTabClick(mode) {
  const tab = SORT_TABS.find(t => t.key === mode);
  if (!tab) return;

  if (_sortState.mode === mode && tab.toggle) {
    _sortState.dir = _sortState.dir === 'asc' ? 'desc' : 'asc';
  } else {
    _sortState.mode = mode;
    _sortState.dir = tab.dir;
  }

  saveSortState();
  updateSortTabs();
  applySort();
}

// 手动刷新：强制重拉 shelf/sync（购买状态/价格），档案不动
async function onRefreshStateClick() {
  if (_sortRunning) {
    updateSortStatus('正在处理，请稍候…');
    return;
  }
  _sortRunning = true;
  try {
    updateSortStatus('刷新购买状态…');
    _failedIds.clear();          // 手动刷新 = 允许重试之前失败的书籍
    await refreshShelfIndex();

    if (!_shelfIndex || _shelfIndex.size === 0) {
      updateSortStatus('书架数据加载失败，请稍后重试');
      return;
    }

    // 顺带把缺失的书籍档案补回来（仅当前 tab 需要时）
    if (needsDetailFor(activeSortMode())) {
      const need = [];
      for (const id of _shelfIndex.keys()) if (!getStatic(id)) need.push(id);
      if (need.length > 0) {
        await fetchPrices(need, (done, total) => updateSortStatus(`补齐数据 ${done}/${total}`), { force: true });
      } else {
        _softRefreshDone = false;   // 手动刷新：允许再补刷一批旧档案
        await softRefreshStaleDetails();
      }
    }

    refreshBookLabels();
    if (_browse.active) renderBrowse(true);
    updateSortStatus(statusText());
  } finally {
    _sortRunning = false;
  }
}

function getSortBar() {
  return document.querySelector('.' + SORT_BAR_CLASS);
}

function updateSortTabs() {
  const bar = getSortBar();
  if (!bar) return;
  for (const btn of bar.querySelectorAll('.wrp-sort-tab')) {
    const active = btn.dataset.mode === _sortState.mode;
    btn.classList.toggle('is-active', active);

    // 箭头永久占位：非当前 tab 也用透明度隐藏而不是清空文本，
    // 否则切换 tab 时按钮宽度变化会导致整排 tab 位移
    const arrow = btn.querySelector('.wrp-sort-arrow');
    if (!arrow) continue;
    const tab = SORT_TABS.find(t => t.key === btn.dataset.mode);
    const dir = active ? _sortState.dir : (tab ? tab.dir : 'asc');
    arrow.textContent = dir === 'asc' ? '↑' : '↓';
    arrow.style.opacity = active ? '0.75' : '0';
  }
}

function updateSortStatus(text) {
  const bar = getSortBar();
  if (!bar) return;
  const el = bar.querySelector('.wrp-sort-status');
  if (el) el.textContent = text;
}

function formatAgo(ts) {
  if (!ts) return '未知';
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  return `${Math.floor(hour / 24)} 天前`;
}

function statusText() {
  const parts = [];
  if (_browse.active) {
    const total = _browse.total || (_shelfIndex ? _shelfIndex.size : 0);
    parts.push(`全部 ${total} 本`);
    if (_browse.rendered < total) parts.push(`已显示 ${_browse.rendered} 本`);
  } else {
    parts.push(`已加载 ${document.querySelectorAll('.shelfBook').length} 本`);
  }
  if (_stateTs) parts.push(`状态 ${formatAgo(_stateTs)}`);
  return parts.join(' · ');
}

function saveSortState() {
  try { localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(_sortState)); } catch { /* 忽略 */ }
}

function loadSortState() {
  try {
    const raw = JSON.parse(localStorage.getItem(SORT_STORAGE_KEY) || 'null');
    if (raw && SORT_TABS.some(t => t.key === raw.mode)) {
      _sortState = { mode: raw.mode, dir: raw.dir === 'asc' ? 'asc' : 'desc' };
    }
  } catch { /* 忽略 */ }
}

// 状态刷新后，就地更新已有卡片上的价格 / 评分 / 分类文本
function refreshBookLabels() {
  for (const el of document.querySelectorAll('.shelfBook')) {
    const label = el.querySelector('.' + PRICE_CLASS);
    if (!label) continue;

    const rawId = extractBookId(el);
    if (!rawId) continue;
    let bookId = null;
    try { bookId = parseId(rawId); } catch { continue; }

    const meta = mergeBookMeta(bookId, getStatic(bookId));
    if (!meta) continue;

    const priceEl = label.querySelector('.' + PRICE_SPAN_CLASS);
    if (priceEl) {
      const display = getPriceDisplay(meta);
      priceEl.textContent = display.text;
      priceEl.style.color = display.color;
    }

    const ratingEl = label.querySelector('.' + RATING_SPAN_CLASS);
    if (ratingEl) {
      const ratings = [formatRatingValue(meta.newRating), formatRatingValue(meta.deepVRating)].filter(Boolean);
      ratingEl.textContent = ratings.length > 0 ? ratings.join(' / ') : '--';
    }

    const catEl = label.querySelector('.' + CAT_CLASS);
    if (catEl) catEl.textContent = categoryLineOf(meta);
  }
}

// ─── 排序主流程 ───────────────────────────────────────────────────────────────

function needsDetailFor(mode) {
  return mode === 'rating' || mode === 'words';
}

/**
 * 当前真正生效的排序 tab。
 * `_browse.mode` 在退出浏览后不会被清空，直接拿它判断会把「默认」tab 也当成
 * 详情 tab（多拉上千本档案）；浏览视图未开启时一律以 _sortState 为准。
 */
function activeSortMode() {
  return (_browse.active && _browse.mode) ? _browse.mode : _sortState.mode;
}

let _softRefreshDone = false;   // 本次会话是否已补刷过一批 A 层旧档案

// 推荐值 / 字数 需要每本书的档案（A 层，永久缓存）：后台批量补齐，边补边重排
async function ensureBrowseDetails() {
  if (!needsDetailFor(activeSortMode()) || !_shelfIndex) return;
  try {
    const needed = [];
    for (const bookId of _shelfIndex.keys()) {
      if (!getStatic(bookId) && !_failedIds.has(bookId)) needed.push(bookId);
    }

    // 已补齐的：后台静默补刷一批 30 天以上的旧档案（每次会话一批，不阻塞交互）
    if (needed.length === 0) softRefreshStaleDetails();

    if (needed.length === 0) return;

    await fetchPrices(needed, (done, total) => {
      updateSortStatus(`补齐数据 ${done}/${total}`);
      if (done > 0 && done % 50 === 0) scheduleBrowseRerender();
    });
    scheduleBrowseRerender();
  } catch (err) {
    console.warn('[WeReadPrice] 补齐书籍档案失败', err);
  }
}

/**
 * 补刷超过软过期时间的 A 层档案。
 * 档案永久缓存，但评分/字数长期看会变，所以每次会话静默补刷一批
 * （上限 STATIC_SOFT_BATCH），多开几次页面即可全部刷新，且请求量可控。
 */
async function softRefreshStaleDetails() {
  if (_softRefreshDone || !_shelfIndex || !needsDetailFor(activeSortMode())) return;

  const stale = [];
  for (const bookId of _shelfIndex.keys()) {
    if (stale.length >= STATIC_SOFT_BATCH) break;
    if (getStatic(bookId) && isStaticStale(bookId) && !_failedIds.has(bookId)) stale.push(bookId);
  }
  if (stale.length === 0) return;

  _softRefreshDone = true;
  try {
    await fetchPrices(stale, null, { force: true, refresh: true });
    if (_browse.active && needsDetailFor(_browse.mode)) renderBrowse(true);
  } catch (err) {
    console.warn('[WeReadPrice] 补刷书籍档案失败', err);
  }
}

async function applySort() {
  if (!_domReady) return;
  if (!isShelfPage() || !getShelfList()) return;
  // 已在跑：记下待补跑，避免用户在拉数据期间点 tab 被静默丢弃
  if (_sortRunning) {
    _applyPending = true;
    return;
  }

  _sortRunning = true;
  try {
    await ensureShelfState();

    if (_sortState.mode === 'default') {
      exitBrowse();
      refreshBookLabels();
      updateSortStatus(statusText());
      scheduleSortBarPosition();
      return;
    }

    if (!_shelfIndex || _shelfIndex.size === 0) {
      updateSortStatus('书架数据加载失败，可点「刷新状态」重试');
      return;
    }

    if (!enterBrowse()) return;
    renderBrowse(true);
    refreshBookLabels();
    updateSortStatus(statusText());
    scheduleSortBarPosition();
    ensureBrowseDetails();
  } finally {
    _sortRunning = false;
    if (_applyPending) {
      _applyPending = false;
      applySort();
    }
  }
}

// MutationObserver 回调：维护排序栏与自绘视图的挂载状态
function maybeReapplySort() {
  if (!_domReady) return;
  const now = Date.now();
  if (now - _lastBarCheck < 400) return;
  _lastBarCheck = now;

  if (!isShelfPage()) {
    hideSortBar();
    exitBrowse();
    return;
  }
  if (!getShelfList() && !_browse.active) return;
  ensureSortBar();
  scheduleSortBarPosition();
  refreshBrowseAttachment();
}

async function initShelfSort() {
  if (!isShelfPage()) {
    hideSortBar();
    return;
  }
  loadSortState();
  ensureSortBar();
  await applySort();
}

// ─── 入口 ─────────────────────────────────────────────────────────────────────

async function init() {
  stopObserver();

  if (!_domReady) {
    // 网络请求可以先发，它们不碰页面 DOM
    if (isShelfPage()) ensureShelfState();

    await whenDomQuiet();
    _domReady = true;

    initSimulator();
  }

  await scanAndInject();      // 只补 A 层缺失的书籍档案
  startObserver();
  await initShelfSort();
}

init();
window.addEventListener('popstate', init);
window.addEventListener('hashchange', init);

// 页面切回前台且状态已超过 24h → 后台刷新购买状态（覆盖标签页长时间不关的场景）
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!isShelfPage() || !getShelfList()) return;
  if (_sortRunning) return;
  if (_stateTs && Date.now() - _stateTs < STATE_TTL_MS) return;

  (async () => {
    _sortRunning = true;
    try {
      await refreshShelfIndex();
      refreshBookLabels();
      if (_browse.active) renderBrowse(true);
      updateSortStatus(statusText());
    } finally {
      _sortRunning = false;
    }
  })();
});

// ─── 资产模拟器浮窗 ──────────────────────────────────────────────────────────────

const SIM_STYLES = `
.wrp-sim-btn {
  position: fixed;
  bottom: 24px;
  left: 24px;
  z-index: 99990;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: #1890ff;
  color: #fff;
  border: none;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(24,144,255,0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  transition: transform 0.2s, box-shadow 0.2s;
}
.wrp-sim-btn:hover {
  transform: scale(1.1);
  box-shadow: 0 6px 20px rgba(24,144,255,0.45);
}
.wrp-sim-overlay {
  position: fixed;
  inset: 0;
  z-index: 99999;
  background: rgba(0,0,0,0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.25s;
}
.wrp-sim-overlay.wrp-sim-open {
  opacity: 1;
  pointer-events: auto;
}
.wrp-sim-modal {
  width: 600px;
  max-height: 90vh;
  overflow-y: auto;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.18);
  padding: 24px 28px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
.wrp-sim-modal h3 {
  margin: 0 0 16px;
  font-size: 17px;
  color: #1a1a1a;
}
.wrp-sim-top-row {
  display: flex;
  gap: 24px;
  margin-bottom: 16px;
}
.wrp-sim-controls {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 0 0 240px;
  min-width: 200px;
}
.wrp-sim-challenges {
  flex: 1;
  min-width: 0;
}
.wrp-sim-ctrl label {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  color: #333;
  margin-bottom: 4px;
  font-weight: 600;
}
.wrp-sim-ctrl input[type="range"] {
  width: 100%;
  cursor: pointer;
}
.wrp-sim-stats {
  display: flex;
  gap: 16px;
  padding: 12px 16px;
  background: #f0f7ff;
  border-radius: 8px;
  border-left: 4px solid #1890ff;
  margin-bottom: 16px;
  font-size: 13px;
  color: #1a1a1a;
}
.wrp-sim-stats > div {
  flex: 1;
}
.wrp-sim-stats .wrp-stat-val {
  font-weight: 700;
  color: #1890ff;
}
.wrp-sim-stats .wrp-stat-cost {
  color: #d9363e;
}
.wrp-sim-chart {
  width: 100%;
  height: 380px;
}
.wrp-sim-strategy {
  margin-bottom: 14px;
}
.wrp-sim-strategy h4 {
  margin: 0 0 8px;
  font-size: 14px;
  color: #1a1a1a;
}
.wrp-strategy-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px 20px;
}
.wrp-strategy-col-title {
  font-size: 12px;
  font-weight: 700;
  color: #666;
  margin-bottom: 4px;
  padding-bottom: 4px;
  border-bottom: 1px solid #eee;
}
.wrp-strategy-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 3px;
  font-size: 12px;
}
.wrp-strategy-row .wrp-strat-label {
  min-width: 38px;
  color: #333;
  flex-shrink: 0;
}
.wrp-strategy-row label {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  cursor: pointer;
  color: #555;
  font-weight: 400;
  margin: 0;
  white-space: nowrap;
}
.wrp-strategy-row input[type="radio"] {
  margin: 0;
  cursor: pointer;
}
.wrp-ch-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  font-size: 12px;
  color: #1a1a1a;
}
.wrp-ch-row input[type="number"] {
  width: 52px;
  padding: 2px 4px;
  font-size: 12px;
  text-align: center;
  border: 1px solid #d9d9d9;
  border-radius: 4px;
}
.wrp-ch-remove {
  width: 20px;
  height: 20px;
  padding: 0;
  line-height: 18px;
  text-align: center;
  border: 1px solid #ff4d4f;
  color: #ff4d4f;
  background: #fff;
  border-radius: 50%;
  cursor: pointer;
  font-size: 14px;
  flex-shrink: 0;
}
.wrp-ch-hint {
  font-size: 11px;
  color: #ff4d4f;
  margin-left: 4px;
  white-space: nowrap;
}
`;

function injectSimStyles() {
  if (document.getElementById('wrp-sim-styles')) return;
  const style = document.createElement('style');
  style.id = 'wrp-sim-styles';
  style.textContent = SIM_STYLES;
  document.head.appendChild(style);
}

function createSimUI() {
  // 浮动按钮
  const btn = document.createElement('button');
  btn.className = 'wrp-sim-btn';
  btn.title = '微信读书资产模拟器';
  btn.innerHTML = '📊';

  // 遮罩层
  const overlay = document.createElement('div');
  overlay.className = 'wrp-sim-overlay';

  // 弹窗内容
  const modal = document.createElement('div');
  modal.className = 'wrp-sim-modal';
  modal.innerHTML = `
    <h3>📊 微信读书资产模拟器</h3>
    <div class="wrp-sim-top-row">
      <div class="wrp-sim-controls">
        <div class="wrp-sim-ctrl">
          <label><span>每周阅读天数</span> <span id="wrpValDays">4 天</span></label>
          <input type="range" id="wrpInpDays" min="0" max="7" step="1" value="4">
        </div>
        <div class="wrp-sim-ctrl">
          <label><span>每周阅读时长</span> <span id="wrpValHours">3 小时</span></label>
          <input type="range" id="wrpInpHours" min="0" max="20" step="0.5" value="3">
        </div>
        <div class="wrp-sim-ctrl">
          <label><span>周二翻牌(卡)</span> <span id="wrpValFlipCard">3 张</span></label>
          <input type="range" id="wrpInpFlipCard" min="0" max="10" step="1" value="3">
        </div>
        <div class="wrp-sim-ctrl">
          <label><span>周二翻牌(币)</span> <span id="wrpValFlipCoin">3 个</span></label>
          <input type="range" id="wrpInpFlipCoin" min="0" max="10" step="1" value="3">
        </div>
      </div>
      <div class="wrp-sim-challenges">
        <label style="font-size:13px;font-weight:600;color:#1a1a1a;margin-bottom:6px;display:block">🏆 挑战 (每次 5 元, 30 天, 间隔 ≥30 天)</label>
        <div id="wrpChallengeList"></div>
        <button id="wrpAddChallenge" style="margin-top:6px;padding:4px 12px;font-size:12px;cursor:pointer;border:1px dashed #1890ff;color:#1890ff;background:#fff;border-radius:4px">+ 添加挑战</button>
      </div>
    </div>
    <div class="wrp-sim-strategy">
      <h4>🎁 奖励策略 (体验卡 / 书币)</h4>
      <div style="font-size:11px;color:#999;margin-bottom:8px">📌 书币每周日统一领取，领取后 30 天过期；体验卡即时获得</div>
      <div class="wrp-strategy-grid">
        <div>
          <div class="wrp-strategy-col-title">阅读时长奖励</div>
          <div class="wrp-strategy-row"><span class="wrp-strat-label">5分钟</span><label><input type="radio" name="wrpStrat5m" value="card" checked>1天卡</label><label><input type="radio" name="wrpStrat5m" value="coin">1币</label></div>
          <div class="wrp-strategy-row"><span class="wrp-strat-label">30分钟</span><label><input type="radio" name="wrpStrat30m" value="card" checked>1天卡</label><label><input type="radio" name="wrpStrat30m" value="coin">1币</label></div>
          <div class="wrp-strategy-row"><span class="wrp-strat-label">1小时</span><label><input type="radio" name="wrpStrat1h" value="card" checked>1天卡</label><label><input type="radio" name="wrpStrat1h" value="coin">2币</label></div>
          <div class="wrp-strategy-row"><span class="wrp-strat-label">3小时</span><label><input type="radio" name="wrpStrat3h" value="card" checked>2天卡</label><label><input type="radio" name="wrpStrat3h" value="coin">2币</label></div>
          <div class="wrp-strategy-row"><span class="wrp-strat-label">5小时</span><label><input type="radio" name="wrpStrat5h" value="card" checked>2天卡</label><label><input type="radio" name="wrpStrat5h" value="coin">2币</label></div>
        </div>
        <div>
          <div class="wrp-strategy-col-title">阅读天数奖励</div>
          <div class="wrp-strategy-row"><span class="wrp-strat-label">读2天</span><label><input type="radio" name="wrpStratD2" value="card" checked>2天卡</label><label><input type="radio" name="wrpStratD2" value="coin">2币</label></div>
          <div class="wrp-strategy-row"><span class="wrp-strat-label">读4天</span><label><input type="radio" name="wrpStratD4" value="card" checked>2天卡</label><label><input type="radio" name="wrpStratD4" value="coin">4币</label></div>
          <div class="wrp-strategy-row"><span class="wrp-strat-label">读7天</span><label><input type="radio" name="wrpStratD7" value="card" checked>2天卡</label><label><input type="radio" name="wrpStratD7" value="coin">6币</label></div>
        </div>
      </div>
    </div>
    <div class="wrp-sim-stats">
      <div>90天后会员: <span class="wrp-stat-val" id="wrpOutMembership">0 天</span></div>
      <div>体验卡剩余: <span class="wrp-stat-val" id="wrpOutCards">0 张</span></div>
      <div>累计书币: <span class="wrp-stat-val" id="wrpOutCoins">0</span></div>
      <div>周期花费: <span class="wrp-stat-cost" id="wrpOutCost">0 元</span></div>
    </div>
    <div class="wrp-sim-chart" id="wrpChart"></div>
  `;

  overlay.appendChild(modal);
  // 同样不能挂 body：会破坏该页面的 Vue 水合（见 getUiRoot 注释）
  const uiRoot = getUiRoot();
  uiRoot.appendChild(btn);
  uiRoot.appendChild(overlay);

  return { btn, overlay, modal };
}

// 奖励档位定义
const REWARD_TIME = [
  { key: '5m',  hours: 0.083, card: 1, coin: 1 },
  { key: '30m', hours: 0.5,   card: 1, coin: 1 },
  { key: '1h',  hours: 1,     card: 1, coin: 2 },
  { key: '3h',  hours: 3,     card: 2, coin: 2 },
  { key: '5h',  hours: 5,     card: 2, coin: 2 },
];
const REWARD_DAY = [
  { key: 'D2', days: 2, card: 2, coin: 2 },
  { key: 'D4', days: 4, card: 2, coin: 4 },
  { key: 'D7', days: 7, card: 2, coin: 6 },
];

// 获取当前星期几 (1=周一 ... 7=周日)，作为模拟第 1 天的星期
function getCurrentDayOfWeek() {
  const d = new Date().getDay(); // 0=周日 ... 6=周六
  return d === 0 ? 7 : d;       // 1=周一 ... 7=周日
}

// 核心模拟算法
function simulateWeRead(daysPerWeek, hoursPerWeek, flipCards, flipCoins, challengeDays, strategy) {
  let membershipDays = 30;
  let experienceCards = 0;
  let bookCoins = 0;
  let totalCost = 0;
  const totalDays = 90;
  const results = [];

  const startDow = getCurrentDayOfWeek(); // 第 1 天对应的星期
  let weekDays = 0;
  let weekHours = 0;
  let claimedT = {};
  let claimedD = {};
  REWARD_TIME.forEach(r => claimedT[r.key] = false);
  REWARD_DAY.forEach(r => claimedD[r.key] = false);

  // 书币延迟领取 & 30 天过期
  let weeklyCoinPending = 0;
  let coinExpiry = []; // [{ amount, expiryDay }]

  for (let day = 1; day <= totalDays; day++) {
    // 星期偏移: 第 1 天 = 当前真实星期
    let dayOfWeek = ((day + startDow - 2) % 7) + 1;

    // ── 每日: 清理过期书币 ──
    while (coinExpiry.length > 0 && coinExpiry[0].expiryDay <= day) {
      bookCoins -= coinExpiry[0].amount;
      coinExpiry.shift();
    }

    // ── 挑战: 付费 5 元激活, 30 天后完成得 30 天会员 ──
    let inChallenge = false;
    for (const cs of challengeDays) {
      if (day === cs) {
        membershipDays += 2;
        totalCost += 5;
      }
      if (day === cs + 29) {
        membershipDays += 30;
      }
      if (day >= cs && day < cs + 30) {
        inChallenge = true;
      }
    }
    const isChallenge = inChallenge;

    // ── 会员每日抽卡 → 书币暂存 ──
    if (membershipDays > 0) {
      weeklyCoinPending += 1;
    }

    // ── 当日阅读 ──
    let readsToday = false;
    let hoursToday = 0;
    if (isChallenge) {
      // 找到当前活跃的挑战，跳过激活日
      const activeCs = challengeDays.find(cs => day >= cs && day < cs + 30);
      readsToday = day !== activeCs;
      hoursToday = readsToday ? 30 / 29 : 0;
    } else {
      readsToday = dayOfWeek <= daysPerWeek;
      hoursToday = daysPerWeek > 0 ? hoursPerWeek / daysPerWeek : 0;
    }

    if (readsToday) {
      weekDays += 1;
      weekHours += hoursToday;

      // 天数打卡奖励: 卡→即时, 币→暂存
      REWARD_DAY.forEach(r => {
        if (weekDays >= r.days && !claimedD[r.key]) {
          claimedD[r.key] = true;
          if (strategy[r.key] === 'coin') weeklyCoinPending += r.coin;
          else experienceCards += r.card;
        }
      });

      // 时长奖励: 卡→即时, 币→暂存
      REWARD_TIME.forEach(r => {
        if (weekHours >= r.hours && !claimedT[r.key]) {
          claimedT[r.key] = true;
          if (strategy[r.key] === 'coin') weeklyCoinPending += r.coin;
          else experienceCards += r.card;
        }
      });
    }

    // ── 周二翻牌: 卡→即时, 币→暂存 ──
    if (dayOfWeek === 2) {
      experienceCards += flipCards;
      weeklyCoinPending += flipCoins;
    }

    // ── 会员天数消耗 & 兑换 ──
    if (membershipDays > 0) {
      membershipDays -= 1;
    }
    // 体验卡满 60 自动兑换 30 天会员 (不限会员是否到期)
    while (experienceCards >= 60) {
      experienceCards -= 60;
      membershipDays += 30;
      totalCost += 6;
    }

    // ── 周日: 发放本周累积的书币, 记录 30 天过期 ──
    if (dayOfWeek === 7) {
      if (weeklyCoinPending > 0) {
        bookCoins += weeklyCoinPending;
        coinExpiry.push({ amount: weeklyCoinPending, expiryDay: day + 30 });
        weeklyCoinPending = 0;
      }
      // 重置周计数器
      weekDays = 0;
      weekHours = 0;
      REWARD_TIME.forEach(r => claimedT[r.key] = false);
      REWARD_DAY.forEach(r => claimedD[r.key] = false);
    }

    results.push({
      day: day,
      membershipDays: membershipDays,
      experienceCards: experienceCards,
      bookCoins: Math.max(0, bookCoins),
      totalCost: totalCost
    });
  }
  return results;
}

function loadECharts() {
  return new Promise((resolve) => {
    const gw = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    if (gw.echarts) { resolve(gw.echarts); return; }
    // CSP 阻止外部 CDN，通过 GM_xmlhttpRequest 抓取后用页面 eval 执行
    GM_xmlhttpRequest({
      method: 'GET',
      url: 'https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js',
      onload(resp) {
        try {
          gw.eval(resp.responseText);
          resolve(gw.echarts || null);
        } catch (e) {
          console.error('[WeReadPrice] ECharts eval 失败:', e);
          resolve(null);
        }
      },
      onerror() { resolve(null); },
      ontimeout() { resolve(null); },
    });
  });
}

let _simChart = null;

async function initSimulator() {
  injectSimStyles();
  const { btn, overlay, modal } = createSimUI();

  // 打开弹窗
  btn.addEventListener('click', async () => {
    overlay.classList.add('wrp-sim-open');

    const echarts = await loadECharts();
    if (!echarts) { console.warn('[WeReadPrice] ECharts 加载失败'); return; }

    // 等一帧，确保 overlay 布局完成、容器有正确尺寸
    await new Promise(r => requestAnimationFrame(r));

    const chartDom = document.getElementById('wrpChart');
    if (chartDom.offsetWidth === 0 || chartDom.offsetHeight === 0) {
      console.warn('[WeReadPrice] 图表容器尺寸为 0，延迟重试');
      await new Promise(r => setTimeout(r, 100));
    }

    if (!_simChart) {
      _simChart = echarts.init(chartDom);
    } else {
      _simChart.resize();
    }

    updateSimChart(_simChart);
  });

  // 点击遮罩关闭
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.classList.remove('wrp-sim-open');
    }
  });

  // ESC 关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('wrp-sim-open')) {
      overlay.classList.remove('wrp-sim-open');
    }
  });

  // 滑块事件 — 始终更新数字，有图表时同步刷新
  ['Days','Hours','FlipCard','FlipCoin'].forEach(key => {
    document.getElementById('wrpInp' + key).addEventListener('input', () => {
      saveSimSettings();
      updateSimLabels();
      if (_simChart) updateSimChart(_simChart);
    });
  });

  // 策略单选按钮事件
  modal.querySelectorAll('input[type="radio"]').forEach(radio => {
    radio.addEventListener('change', () => {
      saveSimSettings();
      updateSimLabels();
      if (_simChart) updateSimChart(_simChart);
    });
  });

  // ── 挑战动态管理 ──
  function validateChallenges() {
    const rows = document.querySelectorAll('.wrp-ch-row');
    let prevDay = -Infinity;
    rows.forEach(row => {
      const inp = row.querySelector('.wrp-ch-day');
      const hint = row.querySelector('.wrp-ch-hint');
      const val = parseInt(inp.value, 10);
      if (!isNaN(val) && val - prevDay < 30 && prevDay > 0) {
        hint.textContent = `距上次挑战仅 ${val - prevDay} 天，需 ≥30 天`;
        hint.style.display = '';
      } else {
        hint.style.display = 'none';
      }
      if (!isNaN(val)) prevDay = val;
    });
  }

  function renderChallengeRow(dayVal) {
    const row = document.createElement('div');
    row.className = 'wrp-ch-row';
    row.innerHTML = `
      <span>第</span>
      <input type="number" class="wrp-ch-day" min="1" max="90" value="${dayVal}">
      <span>天开始</span>
      <button class="wrp-ch-remove" title="删除">×</button>
      <span class="wrp-ch-hint" style="display:none"></span>
    `;
    const inp = row.querySelector('.wrp-ch-day');
    const btn = row.querySelector('.wrp-ch-remove');
    const onChange = () => { saveSimSettings(); validateChallenges(); updateSimLabels(); if (_simChart) updateSimChart(_simChart); };
    inp.addEventListener('input', onChange);
    inp.addEventListener('change', onChange);
    btn.addEventListener('click', () => {
      row.remove();
      saveSimSettings();
      validateChallenges();
      updateSimLabels();
      if (_simChart) updateSimChart(_simChart);
    });
    return row;
  }

  const chList = document.getElementById('wrpChallengeList');

  document.getElementById('wrpAddChallenge').addEventListener('click', () => {
    const existing = getChallengeDays();
    const nextDay = existing.length > 0 ? Math.max(...existing) + 30 : 1;
    chList.appendChild(renderChallengeRow(Math.min(nextDay, 90)));
    saveSimSettings();
    validateChallenges();
    updateSimLabels();
    if (_simChart) updateSimChart(_simChart);
  });

  // 恢复缓存设置
  const saved = loadSimSettings();
  if (saved) {
    if (saved.days) document.getElementById('wrpInpDays').value = saved.days;
    if (saved.hours) document.getElementById('wrpInpHours').value = saved.hours;
    if (saved.flipCard) document.getElementById('wrpInpFlipCard').value = saved.flipCard;
    if (saved.flipCoin) document.getElementById('wrpInpFlipCoin').value = saved.flipCoin;
    if (saved.strategy) {
      Object.entries(saved.strategy).forEach(([key, val]) => {
        const radio = document.querySelector(`input[name="wrpStrat${key}"][value="${val}"]`);
        if (radio) radio.checked = true;
      });
    }
    if (saved.challengeDays && saved.challengeDays.length > 0) {
      chList.innerHTML = '';
      saved.challengeDays.forEach(d => chList.appendChild(renderChallengeRow(d)));
      validateChallenges();
    }
  }
}

// 读取当前单选按钮值
function getRadioVal(name) {
  const el = document.querySelector(`input[name="${name}"]:checked`);
  return el ? el.value : 'card';
}

// 读取策略配置
function getStrategy() {
  const s = {};
  REWARD_TIME.forEach(r => s[r.key] = getRadioVal('wrpStrat' + r.key));
  REWARD_DAY.forEach(r => s[r.key] = getRadioVal('wrpStrat' + r.key));
  return s;
}

// 读取挑战开始日数组
function getChallengeDays() {
  const inputs = document.querySelectorAll('.wrp-ch-day');
  return Array.from(inputs).map(inp => parseInt(inp.value, 10)).filter(n => !isNaN(n) && n >= 1).sort((a, b) => a - b);
}

// 读取当前滑块值并运行模拟，返回结果数据（不依赖图表实例）
function getSimData() {
  const d = parseFloat(document.getElementById('wrpInpDays').value);
  const h = parseFloat(document.getElementById('wrpInpHours').value);
  const fCard = parseFloat(document.getElementById('wrpInpFlipCard').value);
  const fCoin = parseFloat(document.getElementById('wrpInpFlipCoin').value);
  const challengeDays = getChallengeDays();
  const strategy = getStrategy();
  return { params: { d, h, fCard, fCoin, challengeDays }, data: simulateWeRead(d, h, fCard, fCoin, challengeDays, strategy) };
}

// 只更新标签和统计数字（不更新图表）
function updateSimLabels() {
  const { params, data } = getSimData();
  document.getElementById('wrpValDays').innerText = `${params.d} 天`;
  document.getElementById('wrpValHours').innerText = `${params.h} 小时`;
  document.getElementById('wrpValFlipCard').innerText = `${params.fCard} 张`;
  document.getElementById('wrpValFlipCoin').innerText = `${params.fCoin} 个`;

  const finalState = data[data.length - 1];
  document.getElementById('wrpOutMembership').innerText = `${finalState.membershipDays} 天`;
  document.getElementById('wrpOutCards').innerText = `${finalState.experienceCards} 张`;
  document.getElementById('wrpOutCoins').innerText = `${finalState.bookCoins}`;
  document.getElementById('wrpOutCost').innerText = `${finalState.totalCost} 元`;
  return data;
}

function updateSimChart(chart) {
  const data = updateSimLabels();
  const xData = data.map(item => `第${item.day}天`);
  const memData = data.map(item => item.membershipDays);
  const cardData = data.map(item => item.experienceCards);
  const coinData = data.map(item => item.bookCoins);

  chart.setOption({
    title: { text: '资产消耗与产出趋势 (90天)', textStyle: { fontSize: 14 } },
    tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
    legend: { data: ['体验卡余额', '会员剩余天数', '书币'], right: 10 },
    grid: { left: '3%', right: '4%', bottom: '3%', containLabel: true },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: xData,
      axisTick: { alignWithLabel: true },
      axisLabel: { interval: 14 }
    },
    yAxis: [
      {
        type: 'value',
        name: '天数',
        position: 'left',
        axisLine: { show: true, lineStyle: { color: '#5470C6' } }
      },
      {
        type: 'value',
        name: '币数',
        position: 'right',
        axisLine: { show: true, lineStyle: { color: '#ee6666' } }
      }
    ],
    series: [
      {
        name: '体验卡余额',
        type: 'line',
        step: 'end',
        yAxisIndex: 0,
        data: cardData,
        itemStyle: { color: '#5470C6' },
        areaStyle: { opacity: 0.1 }
      },
      {
        name: '会员剩余天数',
        type: 'line',
        step: 'end',
        yAxisIndex: 0,
        data: memData,
        itemStyle: { color: '#91CC75' },
        areaStyle: { opacity: 0.1 }
      },
      {
        name: '书币',
        type: 'line',
        step: 'end',
        yAxisIndex: 1,
        data: coinData,
        itemStyle: { color: '#ee6666' },
        areaStyle: { opacity: 0.1 }
      }
    ]
  });
}

// 资产模拟器由 init() 在页面挂载完成后调用（见 init）
