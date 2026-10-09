// component.d.ts —— <WebView> 的对外类型（子路径导出：react-native-flux-desktop-webview/component）。
// 说明：本包无自带 TS 构建（是纯 napi 薄胶水包），此 .d.ts 手写、随包提交；类型由消费方的 @types/react 解析。
import type * as React from 'react';

/** RN→网页 的主动命令口（经 ref 暴露；均在当前已建 view 上生效，未就绪时静默丢弃/拒绝）。 */
export interface WebViewHandle {
  /** 投递消息到页面 window.onFluxMessage / fluxBridge.onMessage；对象会被 JSON.stringify。 */
  postMessage(msg: unknown): void;
  /** 原地导航；传 http(s) 或本地路径（原生统一经自定义协议解析）。 */
  navigate(url: string): void;
  /** 加载内联 HTML（经协议以 http://flux.localhost 提供，相对资源按协议根/cwd 解析）。 */
  loadHtml(html: string): void;
  /** 打开本地文件（相对 process.cwd() 或绝对路径；经协议加载，同目录相对资源可用）。 */
  openFile(path: string): void;
  /** 逃生口：在页面内直接执行任意 JS（无返回值）。 */
  evalJs(script: string): void;
  /** RN→网页且读回求值结果（异步）：能 JSON 解则 resolve 对象，否则原串；未就绪则 reject。 */
  evaluate(script: string): Promise<any>;
  /** 取页面当前 URL（未就绪返回 null）。 */
  getUrl(): string | null;
  /** 页面是否已 loaded。 */
  isReady(): boolean;
  /** 当前原生 view id（未建为 null）。 */
  getId(): number | null;
}

export interface WebViewProps {
  /** 宿主盒样式（宽高决定子面区域；由 onLayoutAbs 量窗内绝对坐标换算物理像素）。用主库的 RN 风格样式对象。 */
  style?: any;
  /** 远程 http(s) URL 或本地路径（与 html/file 三选一，优先级 html > file > src）。 */
  src?: string;
  /** 内联 HTML 字符串（经自定义协议提供，相对资源按协议根/cwd 解析）。 */
  html?: string;
  /** 本地文件路径（相对 process.cwd() 或绝对；经协议加载，同目录相对 css/js/图可用）。 */
  file?: string;
  /**
   * 网页 fluxBridge.post(obj) / fluxBridge.request(obj) 发来：data 已尽量 JSON.parse 成对象，否则原字符串。
   * requestId 非空时为页面发起的请求/应答：本函数返回值（可为 Promise）会自动应答回页面使 request 的 Promise resolve。
   */
  onMessage?: (data: any, requestId?: string) => void | unknown | Promise<unknown>;
  /** DOMContentLoaded。 */
  onDomReady?: () => void;
  /** load 事件（页面就绪，此后 ref.postMessage 不再排队）。 */
  onLoad?: () => void;
  /** 主框导航（包括原地 navigate/链接跳转）；携带目标 url。 */
  onNavigate?: (url: string) => void;
  /** 子面被摘除（closeView / 卸载）。 */
  onClose?: () => void;
  /** 出错（HWND 取不到 / 原生创建失败）。 */
  onError?: (message: string) => void;
  /** target=_blank / window.open 被抑制后回抛；缺省则自动原地导航到该 url。 */
  onNewWindow?: (url: string) => void;
  /** 未就绪期间的占位内容（如「加载中…」）；就绪后由子面覆盖。 */
  children?: React.ReactNode;
}

/**
 * 声明式 WebView：内部把「取宿主 HWND、量绝对布局、贴/摘 Chromium 子面、双向桥与生命周期」全包住。
 * 本质是命令式原生 API 的 React 外壳（airspace：子面浮于画布之上，不可被覆盖/裁剪/圆角）。
 */
export declare const WebView: React.ForwardRefExoticComponent<WebViewProps & React.RefAttributes<WebViewHandle>>;

/**
 * airspace 显隐总线：把所有已挂载的 <WebView> 子面整体隐藏(false)/恢复(true)。
 * 用于全屏 Skia 浮层（抽屉/弹窗）需压住网页时——WebView2 子面永远浮在 Skia 之上，只能靠移到屏外隐藏。
 */
export declare function setAllVisible(visible: boolean): void;
