# WeReadPrice

在微信读书书架页面（`https://weread.qq.com/web/shelf`）为每本书显示价格与购买状态的 Chrome 扩展。

## 功能

- 自动扫描书架页面书籍卡片，批量查询价格
- 在每本书封面下方显示：
  - **已购买**（绿色）
  - **免费**（绿色）
  - **¥XX.XX**（红色）
  - **暂无价格**（灰色）
- 支持书架懒加载（MutationObserver 增量扫描）
- 支持 SPA 路由切换后自动重扫
- 价格数据本地缓存，减少重复请求

## 安装（开发者模式）

1. 打开 Chrome，访问 `chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本项目根目录
4. 访问 `https://weread.qq.com/web/shelf` 即可看到价格标签

## 文件结构

\`\`\`
viberead/
├── manifest.json          # MV3 扩展清单
├── src/
│   ├── background.js      # Service Worker：价格 API 请求 + 本地缓存
│   └── content.js         # Content Script：DOM 扫描 + 价格标签注入
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
\`\`\`

## 技术说明

### background.js

- 监听 `GET_PRICES` 消息，接收 `bookIds: string[]`
- 调用 `https://weread.qq.com/web/book/info?bookId=<id>` 查询价格与购买状态
- 价格字段单位为**分**（API 原始值），`payingStatus === 1` 表示已购买，`free === 1` 表示免费
- 批量请求：每批 5 个，间隔 1000ms，避免频繁请求
- Service Worker 保活：请求期间定期读取 storage，防止消息通道提前关闭

### content.js

- 在 `document_idle` 时机注入，适用于 `https://weread.qq.com/*`
- bookId 提取策略：优先 `data-bookid` 属性，回退到卡片链接 href 正则匹配
- 卡片选择器（按优先级）：`[data-bookid]`、`.wr_shelf_book`、`.shelfBookItem`、`.bookItem`
- 价格标签 class：`viberead-price`，防重复注入
- MutationObserver 去抖 300ms，监听 DOM 新增卡片
- 监听 `popstate` / `hashchange` 应对 SPA 路由变化

## 已知限制与风险

| 风险 | 说明 |
|------|------|
| DOM 结构变化 | 微信读书页面改版可能导致选择器失效，需更新 `CARD_SELECTORS` |
| API 返回结构变更 | 字段变更需同步更新 `background.js` 解析逻辑 |
| 非书架页面 | content script 在所有 weread.qq.com 页面运行，非书架页面无书籍卡片时静默退出 |

## 开发与测试

纯函数（`extractBookId`、`injectPriceLabel` 等）通过 `module.exports` 导出，可在 Jest + jsdom 环境下编写单元测试。

\`\`\`bash
# 示例：引入纯函数
const { extractBookId, injectPriceLabel } = require('./src/content.js')
\`\`\`
