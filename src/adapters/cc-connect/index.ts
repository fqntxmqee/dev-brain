/**
 * cc-connect 集成模块（T-29: 4 文件合并为 1 目录）。
 * - ./http — UDS HTTP 底层 + 错误翻译
 * - ./ws   — WebSocket 帧解析
 * - ./bridge — Bridge 编排（HTTP 轮询 + WS 订阅）
 * - ./client — 业务级 send/listSessions API
 */
export {
  translateUdsError,
  udsHttpRequest,
  isSocketReachable,
  parseSessionsBody,
  type UdsHttpResponse,
  type CcConnectSessionInfo,
} from "./http.js";

export { connectBridgeWebSocket, type BridgeWebSocketOptions } from "./ws.js";

export {
  CcConnectBridge,
  type BridgeReplyRequest,
  type BridgeReplyResult,
  type CcConnectBridgeOptions,
} from "./bridge.js";

export {
  CcConnectClient,
  type CcConnectSendRequest,
  type CcConnectSendResponse,
  type CcConnectClientOptions,
} from "./client.js";
