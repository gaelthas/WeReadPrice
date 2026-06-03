// ==UserScript==
// @name         WeReadPrice
// @namespace    https://greasyfork.org/zh-CN/scripts/572301-wereadprice
// @homepage     https://github.com/gaelthas/WeReadPrice
// @version      1.0.5
// @description  在微信读书书架页面显示书籍价格
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
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24h
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 200;

const CARD_SELECTORS = ['.shelfBook'];
const BOOKID_FROM_HREF_RE = /\/(?:reader|book)\/([^/?#]+)/;

// ─── 内存缓存 ─────────────────────────────────────────────────────────────────

const _cache = new Map();

function getCached(bookId) {
  const entry = _cache.get(bookId);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    _cache.delete(bookId);
    return null;
  }
  return entry.data;
}

function setCached(bookId, data) {
  _cache.set(bookId, { data, timestamp: Date.now() });
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
          resolve({
            bookId: data.bookId,
            title: data.title,
            bookType: data.type,
            centPrice: data.bookInfo?.centPrice ?? data.centPrice ?? null,
            payingStatus: data.payingStatus,
            paid: data.paid,
            newRating: data.newRating,
            deepVRating: data.deepVRating,
            category: data.category,
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

async function fetchPrices(bookIds) {
  const result = {};
  const toFetch = [];

  for (const bookId of bookIds) {
    const cached = getCached(bookId);
    if (cached) {
      result[bookId] = cached;
    } else {
      toFetch.push(bookId);
    }
  }

  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const batch = toFetch.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async bookId => {
      const data = await fetchPayInfo(bookId);
      if (data) {
        result[bookId] = data;
        setCached(bookId, data);
      }
    }));
    if (i + BATCH_SIZE < toFetch.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  return result;
}

// ─── DOM 工具 ─────────────────────────────────────────────────────────────────

function queryBookCards() {
  for (const sel of CARD_SELECTORS) {
    const nodes = Array.from(document.querySelectorAll(sel));
    if (nodes.length > 0) return nodes;
  }
  return [];
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

function formatRatingValue(rating) {
  if (rating == null || rating === '') return null;
  const num = Number(rating);
  if (!Number.isFinite(num)) return String(rating);
  const score = num > 10 ? num / 10 : num;
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

  if (priceData.payingStatus == 0) {
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

function injectPriceLabel(card, priceData) {
  if (card.querySelector('.' + PRICE_CLASS)) return;

  const label = document.createElement('div');
  label.className = PRICE_CLASS;
  label.style.cssText = 'font-size:12px;margin-top:4px;line-height:1.6;pointer-events:none';

  const priceDisplay = getPriceDisplay(priceData);
  const newRating = formatRatingValue(priceData && priceData.newRating);
  const deepVRating = formatRatingValue(priceData && priceData.deepVRating);
  const category = formatCategory(priceData && priceData.category);

  const rowStyle = 'display:flex;justify-content:space-between;align-items:center';
  const leftStyle = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0';
  const rightStyle = 'white-space:nowrap;flex-shrink:0;text-align:right';

  // Row 1: 评分1 / 评分2 | 价格
  const row1 = document.createElement('div');
  row1.style.cssText = rowStyle;
  const ratingSpan = document.createElement('span');
  const ratings = [newRating, deepVRating].filter(Boolean);
  ratingSpan.textContent = ratings.length > 0 ? ratings.join(' / ') : '--';
  ratingSpan.style.cssText = `color:#faad14;${leftStyle}`;
  const priceSpan = document.createElement('span');
  priceSpan.textContent = priceDisplay.text;
  priceSpan.style.cssText = `color:${priceDisplay.color};${rightStyle}`;
  row1.appendChild(ratingSpan);
  row1.appendChild(priceSpan);

  // Row 2: 分类
  const row2 = document.createElement('div');
  row2.style.cssText = rowStyle;
  const catSpan = document.createElement('span');
  catSpan.textContent = category;
  catSpan.style.cssText = `color:#888;${leftStyle}`;
  row2.appendChild(catSpan);

  label.appendChild(row1);
  label.appendChild(row2);
  card.appendChild(label);
}

// ─── 核心流程 ─────────────────────────────────────────────────────────────────

async function scanAndInject() {
  const newCards = scanNewCards();
  if (newCards.length === 0) return;

  const bookIds = newCards.map(c => c.bookId);
  const prices = await fetchPrices(bookIds);

  for (const { element, bookId } of newCards) {
    injectPriceLabel(element, prices[bookId] || null);
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

  _observer = new MutationObserver(() => {
    _safeScanAndInject();
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

// ─── 入口 ─────────────────────────────────────────────────────────────────────

async function init() {
  stopObserver();
  await scanAndInject();
  startObserver();
}

init();
window.addEventListener('popstate', init);
window.addEventListener('hashchange', init);

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
  document.body.appendChild(btn);
  document.body.appendChild(overlay);

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

initSimulator();
