// WebView 独立分支包 · 渲染探针
// 用法：先 `npm run build`（或 build:debug）产出 index.js + *.node，再 `node test-render.js`。
// 目标：开一扇 Chromium(WebView2) 窗并导航，用 setInterval 持续 pump 保活，验证「渲染出网页」。
// 关窗（点 X）→ Rust 回抛 closed → 本脚本清定时器并退出进程（否则残留 HWND + TSFN 会让 Node 不退出）。
const path = require('path');
const fs = require('fs');

const loader = path.join(__dirname, 'index.js');
if (!fs.existsSync(loader)) {
  console.error('未找到 index.js —— 请先运行: npm run build（或 npm run build:debug）');
  process.exit(1);
}
const lab = require(loader);

const url = process.argv[2] || 'https://example.com';
console.log('[probe] creating webview ->', url);

const id = lab.createWebview(url, 1000, 700, 'WebView render probe', (err, data) => {
  if (err) return console.error('[probe] event cb error:', err);
  console.log('[probe] event:', data);
  try {
    const msg = JSON.parse(data);
    if (msg.type === 'closed') {
      console.log('[probe] window closed, exiting.');
      clearInterval(timer);
      process.exit(0);
    }
  } catch {
    /* 非 JSON 事件忽略 */
  }
});
console.log('[probe] created webview id =', id);

let ticks = 0;
const timer = setInterval(() => {
  const exited = lab.pump();
  ticks++;
  if (ticks % 125 === 0) console.log('[probe] pumped', ticks, 'ticks (~1s), exited=' + exited);
  if (exited) {
    console.log('[probe] event loop gone, exiting.');
    clearInterval(timer);
    process.exit(0);
  }
}, 8);

// 无头/CI 兜底：60s 后自动关窗退出，避免探针挂死。
setTimeout(() => {
  console.log('[probe] 60s timeout -> closing webview', id);
  lab.closeWebview(id);
  clearInterval(timer);
  process.exit(0);
}, 60000);
