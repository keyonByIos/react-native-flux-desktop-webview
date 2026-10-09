'use strict';
// component.js —— <WebView> React 组件（声明式外壳 + 命令式内核）。
//
// 为什么是这个形态：本栈的 WebView2 是「贴到主库某窗 HWND 上的一块 child HWND 子面」，不是画进 Skia 的
// 原生绘制节点，无法作为 reconciler 宿主元素存在。于是「React 写法」= 一个 React 组件：对外是声明式
// props/ref，对内用 effect 把命令式 native 调用（取 HWND、量绝对布局、createView/setBounds/closeView）
// 全包住。这与 Popover/Dropdown/Affix「声明式 props + 内部包命令式」的范式一致。
//
// 关键运行时约定（与主库对齐）：
//   · 宿主窗：getActiveHost().getNativeHandle() 取 HWND；getScale() 取 DPR（逻辑坐标×DPR=物理像素）。
//   · 布局：<View onLayoutAbs> 报该盒在「窗内绝对逻辑坐标」{x,y,w,h}；首报=建面，后续报=setBounds 跟随。
//   · 内容优先级：html(内联) > file(随包/本地路径) > src(http(s)/路径)；本地内容统一走原生自定义协议
//     http://flux.localhost/…（非 file://），故相对资源与双向桥、生命周期均可用。
//   · 事件（原生回抛 JSON）：domready / loaded / navigate（主框导航）/ closed / newwindow（默认原地导航）/ ipc（业务消息，request 带 requestId）。
//
// peerDependencies 由消费方在运行时解析：react + react-native-flux-desktop；native 走同目录 ./index.js。
const React = require('react');
const FLUX = require('react-native-flux-desktop');
const NATIVE = require('./index.js');

const View = FLUX.View;
const getActiveHost = FLUX.getActiveHost;

// ── airspace 显隐总线 ──────────────────────────────────────────────
// WebView2 是主窗的 WS_CHILD 子面，永远浮在 Skia 之上：Skia 画的抽屉/弹窗/遮罩盖不住它。
// 当一个全屏浮层（如代码抽屉）要压住网页时，调 setAllVisible(false) 把所有已建子面移到屏外隐藏，
// 关闭后再 setAllVisible(true) 恢复。suspended 保证隐藏期间新建/重布的 view 也立即隐藏。
const live = new Set(); // 每个实例的显隐控制器 (visible:boolean)=>void
let suspended = false;
function setAllVisible(visible) {
  suspended = !visible;
  live.forEach((fn) => {
    try {
      fn(visible);
    } catch (e) {
      /* ignore */
    }
  });
}

/** 本地路径/URL 直接透传：原生侧统一分类——http(s) 原样；file://或裸路径经自定义协议转成 http://flux.localhost/…。
 *  （不在前端造 file://：file:// 页源会让 wry 的 ipc 解析失败而 panic 拖垮进程，交由 Rust 走协议。）*/
function toUrl(u) {
  return u == null ? '' : String(u);
}

/** ipc data 常是页面 fluxBridge.post 里 JSON.stringify 过的串，能解则解成对象再交给使用方。 */
function tryParse(s) {
  if (typeof s !== 'string') return s;
  try {
    return JSON.parse(s);
  } catch (e) {
    return s;
  }
}

const WebView = React.forwardRef(function WebView(props, ref) {
  const style = props.style;
  const src = props.src;
  const html = props.html;
  const file = props.file;
  const children = props.children;

  // 用 ref 存最新回调，避免原生回抛闭包捕获旧的 onMessage/onLoad…（props 每次渲染都换新函数）。
  const cbRef = React.useRef(null);
  cbRef.current = {
    onMessage: props.onMessage,
    onDomReady: props.onDomReady,
    onLoad: props.onLoad,
    onClose: props.onClose,
    onError: props.onError,
    onNewWindow: props.onNewWindow,
    onNavigate: props.onNavigate,
  };

  const idRef = React.useRef(null); // native view id
  const rectRef = React.useRef(null); // 最近一次窗内绝对逻辑布局 {x,y,w,h}
  const createdRef = React.useRef(false);
  const [ready, setReady] = React.useState(false); // 供占位 children 显隐（loaded 前显示）

  // 本实例的显隐控制器（身份稳定，供 airspace 总线 add/delete）：按当前 id 调原生 setVisible。
  const controllerRef = React.useRef(null);
  if (controllerRef.current === null) {
    controllerRef.current = (visible) => {
      const id = idRef.current;
      if (id != null) {
        try {
          NATIVE.setVisible(id, visible);
        } catch (e) {
          /* ignore */
        }
      }
    };
  }

  const fail = (m) => {
    const c = cbRef.current;
    if (c && c.onError) c.onError(String(m));
  };
  const scaleOf = () => {
    const h = getActiveHost();
    return h && typeof h.getScale === 'function' ? h.getScale() || 1 : 1;
  };

  // 原生 → JS 的统一事件分发（onEvent 首参 error，值在第二参 JSON 串）。
  function handleEvent(_e, data) {
    let m;
    try {
      m = JSON.parse(data);
    } catch (err) {
      return;
    }
    const c = cbRef.current;
    if (m.type === 'ipc') {
      const ret = c && c.onMessage ? c.onMessage(tryParse(m.data), m.requestId) : undefined;
      // 页面用 fluxBridge.request 发起（带 requestId）：把 onMessage 返回值（可为 Promise）应答回页面。
      if (m.requestId != null && idRef.current != null) {
        const rid = m.requestId;
        Promise.resolve(ret).then(
          (r) => {
            try {
              NATIVE.postReply(idRef.current, rid, JSON.stringify(r === undefined ? null : r));
            } catch (err) {
              /* ignore */
            }
          },
          () => {
            /* 应答失败：页面侧 Promise 保持 pending（可选加超时） */
          }
        );
      }
    } else if (m.type === 'domready') {
      if (c && c.onDomReady) c.onDomReady();
    } else if (m.type === 'loaded') {
      setReady(true);
      if (c && c.onLoad) c.onLoad();
    } else if (m.type === 'navigate') {
      if (c && c.onNavigate) c.onNavigate(m.url);
    } else if (m.type === 'closed') {
      createdRef.current = false;
      idRef.current = null;
      setReady(false);
      if (c && c.onClose) c.onClose();
    } else if (m.type === 'newwindow') {
      if (c && c.onNewWindow) {
        c.onNewWindow(m.url);
      } else if (idRef.current != null) {
        // 默认抑制弹窗后原地导航（避免用户点击 target=_blank 时石沉大海）
        try {
          NATIVE.navigate(idRef.current, m.url);
        } catch (err) {
          /* ignore */
        }
      }
    }
  }

  // 拿到布局 + HWND 后建面（只建一次）。内容三选一。
  function ensureCreated() {
    if (createdRef.current) return;
    const r = rectRef.current;
    if (!r || r.w <= 0 || r.h <= 0) return;
    const host = getActiveHost();
    const hwnd = host && typeof host.getNativeHandle === 'function' ? host.getNativeHandle() : 0;
    if (!hwnd) {
      fail('拿不到宿主窗口 HWND（非 Windows / 窗口未就绪）');
      return;
    }
    const s = scaleOf();
    const x = Math.round(r.x * s);
    const y = Math.round(r.y * s);
    const w = Math.round(r.w * s);
    const h = Math.round(r.h * s);
    try {
      if (typeof html === 'string' && html.length) {
        idRef.current = NATIVE.createViewHtml(hwnd, x, y, w, h, html, handleEvent);
      } else {
        const u = file ? String(file) : src ? String(src) : '';
        idRef.current = NATIVE.createView(hwnd, x, y, w, h, u, handleEvent);
      }
      createdRef.current = true;
      live.add(controllerRef.current);
      if (suspended) {
        // 隐藏期间新建：立即移到屏外，不抢浮层的顶。
        try {
          NATIVE.setVisible(idRef.current, false);
        } catch (e) {
          /* ignore */
        }
      }
    } catch (e) {
      fail('创建 webview 失败：' + ((e && e.message) || e));
    }
  }

  // 布局回调：首报建面，之后跟随改区域（物理像素）。
  function onLayoutAbs(e) {
    const l = e && e.nativeEvent && e.nativeEvent.layout;
    if (!l) return;
    rectRef.current = l;
    if (!createdRef.current) {
      ensureCreated();
    } else if (idRef.current != null) {
      const s = scaleOf();
      try {
        NATIVE.setBounds(idRef.current, Math.round(l.x * s), Math.round(l.y * s), Math.round(l.w * s), Math.round(l.h * s));
        if (suspended) NATIVE.setVisible(idRef.current, false); // 隐藏期间布局变化：先更新真实区域再重新隐（setBounds 会把它拉回屏内）
      } catch (err) {
        /* ignore */
      }
    }
  }

  // 内容变化 → 原地更新（建好之后）。html/loadHtml、file/openFile、src/navigate。
  React.useEffect(
    () => {
      if (!createdRef.current) {
        ensureCreated(); // 布局可能已就绪但建面被 HWND 未就绪挡下，重试
        return;
      }
      const id = idRef.current;
      if (id == null) return;
      try {
        if (typeof html === 'string' && html.length) NATIVE.loadHtml(id, html);
        else if (file) NATIVE.openFile(id, file);
        else if (src) NATIVE.navigate(id, toUrl(src));
      } catch (e) {
        fail('更新内容失败：' + ((e && e.message) || e));
      }
    },
    [src, html, file]
  );

  // 卸载：从总线摘除 + 摘面（原生会回抛 closed）。
  React.useEffect(
    () => () => {
      live.delete(controllerRef.current);
      if (idRef.current != null) {
        try {
          NATIVE.closeView(idRef.current);
        } catch (e) {
          /* ignore */
        }
        idRef.current = null;
        createdRef.current = false;
      }
    },
    []
  );

  // ref 命令句柄：主动 RN→网页 的口子（postMessage/navigate/loadHtml/openFile/evalJs/evaluate/getUrl）。
  React.useImperativeHandle(
    ref,
    () => ({
      postMessage: (msg) => {
        const id = idRef.current;
        if (id == null) return;
        NATIVE.postMessage(id, typeof msg === 'string' ? msg : JSON.stringify(msg));
      },
      navigate: (u) => {
        const id = idRef.current;
        if (id != null) NATIVE.navigate(id, toUrl(u));
      },
      loadHtml: (h) => {
        const id = idRef.current;
        if (id != null) NATIVE.loadHtml(id, h);
      },
      openFile: (p) => {
        const id = idRef.current;
        if (id != null) NATIVE.openFile(id, p);
      },
      evalJs: (script) => {
        const id = idRef.current;
        if (id != null) NATIVE.evalJs(id, script);
      },
      // RN→网页且读回求值结果（异步）：能 JSON 解则给对象，否则原串。
      evaluate: (script) =>
        new Promise((resolve, reject) => {
          const id = idRef.current;
          if (id == null) return reject(new Error('webview 尚未就绪'));
          try {
            NATIVE.evalJsResult(id, script, (err, json) => {
              if (err) return reject(err);
              try {
                resolve(JSON.parse(json));
              } catch (e) {
                resolve(json);
              }
            });
          } catch (e) {
            reject(e);
          }
        }),
      getUrl: () => {
        const id = idRef.current;
        if (id == null) return null;
        try {
          return NATIVE.getViewUrl(id);
        } catch (e) {
          return null;
        }
      },
      isReady: () => ready,
      getId: () => idRef.current,
    }),
    [ready]
  );

  // 占位：未就绪时显示 children（如「加载中…」占位），就绪后由子面覆盖（airspace：子面浮于画布之上）。
  const box = React.createElement(View, { style: style, onLayoutAbs: onLayoutAbs }, ready ? null : children || null);
  return box;
});

module.exports = { WebView, setAllVisible };
