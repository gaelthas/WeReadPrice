// Content Script: 在微信读书书架页面注入书籍价格标签

'use strict';

// ─── 配置 ────────────────────────────────────────────────────────────────────

const PRICE_CLASS = 'viberead-price';
const DEBOUNCE_MS = 300;

/**
 * 候选卡片选择器，按优先级排列。
 * 页面改版时只需在此处更新。
 */
const CARD_SELECTORS = [
  '.shelfBook',
];

/**
 * bookId 从 href 中提取的正则。
 * 匹配路径片段：/reader/<bookId> 或 /book/<bookId>
 */
const BOOKID_FROM_HREF_RE = /\/(?:reader|book)\/([^/?#]+)/;

// ─── DOM 工具 ─────────────────────────────────────────────────────────────────

/**
 * 返回页面上所有书籍卡片元素。
 * 依次尝试 CARD_SELECTORS，返回第一个非空结果。
 * @returns {Element[]}
 */
function queryBookCards() {
  for (const sel of CARD_SELECTORS) {
    const nodes = Array.from(document.querySelectorAll(sel));
    if (nodes.length > 0) return nodes;
  }
  return [];
}

/**
 * 从单个卡片元素提取 bookId。
 * 优先 data-bookid 属性，回退到卡片内 <a> 的 href。
 * @param {Element} card
 * @returns {string|null}
 */
function extractBookId(card) {
  // 1. data-bookid 属性（最可靠）
  const fromAttr = card.dataset && card.dataset.bookid;
  if (fromAttr) return fromAttr;

  // 2. 卡片自身 href（card 本身是 <a>）
  if (card.href) {
    const m = card.href.match(BOOKID_FROM_HREF_RE);
    if (m) return m[1];
  }

  // 3. 卡片内第一个 <a> 的 href
  const link = card.querySelector('a[href]');
  if (link) {
    const m = link.href.match(BOOKID_FROM_HREF_RE);
    if (m) return m[1];
  }

  return null;
}

/**
 * 扫描页面，返回 { element, bookId }[] 列表。
 * 已注入价格标签的卡片会被跳过。
 * @returns {{ element: Element, bookId: string }[]}
 */
function scanNewCards() {
  const cards = queryBookCards();
  const result = [];
  for (const card of cards) {
    // 跳过已注入
    if (card.querySelector('.' + PRICE_CLASS)) continue;
    const bookId = extractBookId(card);
    if (bookId) {
      result.push({ element: card, bookId: parseId(bookId) });
    }
  }
  return result;
}

// ─── 价格注入 ─────────────────────────────────────────────────────────────────

/**
 * 向卡片元素注入价格标签。
 * 注入前再次检查是否已存在，防并发重复注入。
 * @param {Element} card
 * @param {{ price: number|null }|null} priceData
 */
function injectPriceLabel(card, priceData) {
  if (card.querySelector('.' + PRICE_CLASS)) return;

  const label = document.createElement('div');
  label.className = PRICE_CLASS;
  label.style.cssText = [
    'font-size:12px',
    'color:#888',
    'margin-top:4px',
    'text-align:center',
    'line-height:1.4',
    'pointer-events:none',
  ].join(';');

  if (priceData && priceData.bookType == 3) {
    label.textContent = '公众号';
  } else if (priceData && priceData.payingStatus == 1) {
    label.textContent = '已购买';
    label.style.color = '#07c160';
  } else if (priceData && priceData.payingStatus == 0) {
    label.textContent = '导入';
  } else if (priceData && priceData.free) {
    label.textContent = '免费';
    label.style.color = '#07c160';
  } else if (priceData && priceData.centPrice != null) {
    // centPrice 字段单位为「分」，来自 weread.qq.com/web/pay/info API 原始返回值
    const fen = priceData.centPrice;
    const yuan = fen % 100 === 0 ? String(fen / 100) : (fen / 100).toFixed(2);
    label.textContent = '¥' + yuan;
    label.style.color = '#e64340';
  } else {
    label.textContent = '暂无价格';
  }

  card.appendChild(label);
}

// ─── 通信层 ───────────────────────────────────────────────────────────────────

/**
 * 向 background Service Worker 请求一批 bookId 的价格。
 * @param {string[]} bookIds
 * @returns {Promise<Record<string, { price: number|null }>>}
 */
function fetchPricesFromBackground(bookIds) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { type: 'GET_PRICES', bookIds },
        (response) => {
          if (chrome.runtime.lastError) {
            // SW 未就绪或扩展被禁用，静默降级
            resolve({});
            return;
          }
          if (response && response.success) {
            resolve(response.prices || {});
          } else {
            resolve({});
          }
        }
      );
    } catch (_e) {
      // 扩展上下文失效（页面重载期间）
      resolve({});
    }
  });
}

// ─── 核心流程 ─────────────────────────────────────────────────────────────────

/**
 * 扫描新卡片并注入价格。
 * 一次批量 sendMessage，减少通信开销。
 */
async function scanAndInject() {
  const newCards = scanNewCards();
  if (newCards.length === 0) return;

  const bookIds = newCards.map((c) => c.bookId);
  const prices = await fetchPricesFromBackground(bookIds);

  for (const { element, bookId } of newCards) {
    injectPriceLabel(element, prices[bookId] || null);
  }
}

// ─── MutationObserver（增量更新）────────────────────────────────────────────

let _observer = null;
let _debounceTimer = null;

function startObserver() {
  if (_observer) {
    _observer.disconnect();
  }

  _observer = new MutationObserver(() => {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(scanAndInject, DEBOUNCE_MS);
  });

  _observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

function stopObserver() {
  if (_observer) {
    _observer.disconnect();
    _observer = null;
  }
  clearTimeout(_debounceTimer);
  _debounceTimer = null;
}

// ─── 入口 ─────────────────────────────────────────────────────────────────────

/**
 * 初始化：全量扫描 + 启动增量 observer。
 * 路由变化时可重复调用，旧 observer 会被先清理。
 */
async function init() {
  stopObserver();
  await scanAndInject();
  startObserver();
}

function parseId(infoId) {
  const type = infoId[3];
  // skip: 3 (md5 prefix) + 1 (type) + 3 ("2" + md5 suffix 2 chars) = 7 chars
  const dataSection = infoId.slice(7, infoId.length - 3); // remove trailing 3-char checksum

  const segments = dataSection.split('g');
  const chunks = [];
  for (const seg of segments) {
    const len = parseInt(seg.slice(0, 2), 16);
    chunks.push(seg.slice(2, 2 + len));
  }

  if (type === '3') {
    // numeric bookId: each chunk is parseInt(9-digit-group).toString(16)
    return chunks.map(c => parseInt(c, 16).toString(10)).join('');
  } else if (type === '4') {
    // string bookId: full hex string of charCodes
    const hex = chunks[0];
    let result = '';
    for (let i = 0; i < hex.length; i += 2) {
      result += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
    return result;
  }
  throw new Error(`Unknown type flag: ${type}`);
}

// document_idle 下直接执行
init();

// SPA 路由变化重扫
window.addEventListener('popstate', init);
window.addEventListener('hashchange', init);

// ─── 导出（仅供单元测试使用）────────────────────────────────────────────────
// 生产环境下 content script 不需要 module.exports，
// 但测试环境（Jest/jsdom）需要通过此导出访问纯函数。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    extractBookId,
    queryBookCards,
    scanNewCards,
    injectPriceLabel,
    fetchPricesFromBackground,
    scanAndInject,
    CARD_SELECTORS,
    PRICE_CLASS,
  };
}
