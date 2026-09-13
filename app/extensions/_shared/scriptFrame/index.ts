//! FILENAME: app/extensions/_shared/scriptFrame/index.ts
// PURPOSE: Barrel for the one shared definition of the sandboxed script-frame
//          document, its postMessage protocol and its budget.
// CONTEXT: Imported by BOTH `ui.html` hosts — Controls/Shape/shapeRenderer.ts
//          (on-grid overlay) and ControlsPane/components/CustomControlHost.tsx
//          (pane card). `extensions/_shared` is the sanctioned home for code
//          two extensions share; neither host may import the other.

export {
  SCRIPT_FRAME_MESSAGE_TAG,
  SCRIPT_FRAME_RESERVED_TYPE_PREFIX,
  SCRIPT_FRAME_SIZE_MESSAGE,
  SCRIPT_FRAME_THEME_TOKENS,
  readScriptFrameThemeTokens,
  isSafeScriptFrameTokenValue,
  buildScriptFrameDocument,
  // The loader route (BUG-0113): the bridge is served from Rust with its own
  // CSP, and content arrives as a message instead of being baked into a srcdoc.
  SCRIPT_FRAME_LOADER_ORIGIN,
  SCRIPT_FRAME_READY_MESSAGE,
  SCRIPT_FRAME_SET_CONTENT_MESSAGE,
  scriptFrameLoaderUrl,
  scriptFrameThemeCss,
  buildScriptFrameContent,
} from "./frameDocument";
export type {
  ScriptFrameDocumentOptions,
  ScriptFrameContentPayload,
} from "./frameDocument";

export {
  createScriptFrameRouter,
  postToScriptFrame,
  setScriptFrameInert,
  claimScriptFrameSlot,
  releaseScriptFrameSlot,
  parkScriptFrameSlot,
  unparkScriptFrameSlot,
  parkedScriptFrameCount,
  migrateScriptFrameSlot,
  scriptFrameBudgetUsage,
  resetScriptFrameBudget,
  markScriptFrameReady,
  setScriptFrameContent,
  releaseScriptFrameContent,
  isScriptFrameReady,
  resetScriptFrameContentState,
  scriptFrameContentBytes,
  MAX_LIVE_SCRIPT_FRAMES,
  MAX_LIVE_SCRIPT_FRAME_BYTES,
} from "./frameBridge";
export type {
  ScriptFrameMessage,
  ScriptFrameIntrinsicSize,
  ScriptFrameRouterOptions,
  ScriptFrameRouteResult,
  ScriptFrameSlotRefusal,
  ScriptFrameSlotResult,
} from "./frameBridge";
