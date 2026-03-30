// Service Worker: 调用微信读书价格 API，带本地缓存

const CACHE_KEY_PREFIX = 'price_cache_';
const CACHE_TTL_MS = 1000 * 60;// * 60 * 24; // 1天
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 200;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_PRICES') {
    // 定期读取 storage 延长 Service Worker 生命周期，防止消息通道提前关闭
    const keepAlive = setInterval(() => chrome.storage.local.get('_ping'), 25000);
    fetchPrices(message.bookIds)
      .then(prices => sendResponse({ success: true, prices }))
      .catch(err => sendResponse({ success: false, error: err.message }))
      .finally(() => clearInterval(keepAlive));
    return true;
  }
});

async function fetchPrices(bookIds) {
  const result = {};
  const toFetch = [];

  // 检查缓存
  for (const bookId of bookIds) {
    const cached = await getCached(bookId);
    if (cached) {
      result[bookId] = cached;
    } else {
      toFetch.push(bookId);
    }
  }

  // 分批请求未缓存的 bookId
  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const batch = toFetch.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async bookId => {
      const data = await fetchPayInfo(bookId);
      if (data) {
        result[bookId] = data;
        await setCached(bookId, data);
      }
    }));
    if (i + BATCH_SIZE < toFetch.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  return result;
}

async function fetchPayInfo(bookId) {
  try {
    const resp = await fetch(
      `https://weread.qq.com/web/book/info?bookId=${bookId}`,
      { credentials: 'include' }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return {
      bookId: data.bookId,
      title: data.title,
      bookType: data.type,
      centPrice: data.bookInfo?.centPrice ?? data.centPrice ?? null, // 单位：分（API 原始值）
      payingStatus: data.payingStatus,
      free: data.free === 1,
    };
  } catch {
    return null;
  }
}

async function getCached(bookId) {
  const key = CACHE_KEY_PREFIX + bookId;
  const item = await chrome.storage.local.get(key);
  const entry = item[key];
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    await chrome.storage.local.remove(key);
    return null;
  }
  return entry.data;
}

async function setCached(bookId, data) {
  const key = CACHE_KEY_PREFIX + bookId;
  await chrome.storage.local.set({ [key]: { data, timestamp: Date.now() } });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
