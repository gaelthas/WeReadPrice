// ==UserScript==
// @name         WeReadPrice
// @namespace    https://greasyfork.org/zh-CN/scripts/572301-wereadprice
// @homepage     https://github.com/gaelthas/WeReadPrice
// @version      1.0.1
// @description  在微信读书书架页面显示书籍价格
// @author       WeReadPrice
// @match        https://weread.qq.com/*
// @grant        GM_xmlhttpRequest
// @connect      weread.qq.com
// @run-at       document-idle
// @license      MIT
// @updateURL    https://github.com/gaelthas/WeReadPrice/blob/master/weread-price.user.js
// @downloadURL  https://github.com/gaelthas/WeReadPrice/blob/master/weread-price.user.js
// ==/UserScript==

'use strict';

// ─── 配置 ────────────────────────────────────────────────────────────────────

const PRICE_CLASS = 'viberead-price';
const DEBOUNCE_MS = 300;
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
    const fen = priceData.centPrice;
    const yuan = fen % 100 === 0 ? String(fen / 100) : (fen / 100).toFixed(2);
    label.textContent = '¥' + yuan;
    label.style.color = '#e64340';
  } else {
    label.textContent = '暂无价格';
  }

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
let _debounceTimer = null;

function startObserver() {
  if (_observer) _observer.disconnect();

  _observer = new MutationObserver(() => {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(scanAndInject, DEBOUNCE_MS);
  });

  _observer.observe(document.body, { childList: true, subtree: true });
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

async function init() {
  stopObserver();
  await scanAndInject();
  startObserver();
}

init();
window.addEventListener('popstate', init);
window.addEventListener('hashchange', init);
