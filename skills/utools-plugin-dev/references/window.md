<a id="ch-window"></a>
# 窗口

> 模块：窗口（15 API）· [← 总索引（含全局约束）](api-index.md)

提供自定义窗口创建、窗口控制、窗口通信以及 uTools 窗口交互相关 API。

<a id="api-utools-createBrowserWindow"></a>
## `utools.createBrowserWindow(url[, options][, callback])`

创建一个自定义窗口。

自定义窗口指通过本 API 创建的窗口实例，用于承载插件应用主界面（plugin.json 的 `main`）之外的独立界面，基于 Electron BrowserWindow 实现。适用于：全屏透明置顶窗口（屏幕特效、区域选择）、透明置顶小窗口（悬浮挂件、状态提示）、自定义业务窗口（编辑器、独立面板、辅助工具）。

```ts
function createBrowserWindow(
  url: string,
  options?: BrowserWindowConstructorOptions,
  callback?: Function
): BrowserWindow;
```

- `url` 窗口加载的 HTML 文件路径，相对于插件应用根目录（可携带查询参数，如 `foo.html?params=`）
- `options` 自定义窗口选项
- `callback` 自定义窗口页面加载完成后调用，常用于显示窗口、设置窗口状态或向自定义窗口发送消息
- 返回由 uTools 管理的 `BrowserWindow` 窗口实例。其大部分属性和方法与 Electron BrowserWindow 保持一致，但**不支持 BrowserWindow 和 webContents 的实例事件监听**

**`BrowserWindowConstructorOptions` 类型定义**（官方文档化的字段）

```ts
interface BrowserWindowConstructorOptions {
  /** 是否显示窗口，默认 true */
  show?: boolean;
  /** 窗口标题 */
  title?: string;
  /** 窗口宽度 / 高度 */
  width?: number;
  height?: number;
  /** 窗口最小/最大宽度与高度 */
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** 窗口初始横/纵坐标 */
  x?: number;
  y?: number;
  /** 是否将窗口显示在屏幕中央，默认 false */
  center?: boolean;
  /** 是否允许调整窗口大小，默认 true */
  resizable?: boolean;
  /** 是否允许移动窗口，默认 true */
  movable?: boolean;
  /** 是否允许最大化/最小化窗口，默认 true */
  maximizable?: boolean;
  minimizable?: boolean;
  /** 是否允许关闭窗口，默认 true */
  closable?: boolean;
  /** 是否显示窗口边框，默认 true */
  frame?: boolean;
  /** 是否显示窗口阴影，默认 true */
  hasShadow?: boolean;
  /** 是否显示窗口圆角，默认 true */
  roundedCorners?: boolean;
  /** 是否始终显示在其他窗口之上，默认 false */
  alwaysOnTop?: boolean;
  /** 是否允许窗口获得焦点，默认 true */
  focusable?: boolean;
  /** 是否在任务栏中显示窗口，默认 false */
  skipTaskbar?: boolean;
  /** 是否允许窗口尺寸超出屏幕可显示范围，默认 false */
  enableLargerThanScreen?: boolean;
  /** 是否允许窗口进入全屏模式，默认 true */
  fullscreenable?: boolean;
  /** 是否以全屏模式创建窗口，默认 false */
  fullscreen?: boolean;
  /** 窗口透明度，取值范围 0.0 ~ 1.0，默认 1.0 */
  opacity?: number;
  /** 窗口背景颜色 */
  backgroundColor?: string;
  /** 是否创建透明窗口，默认 false */
  transparent?: boolean;
  /** 窗口标题栏样式 */
  titleBarStyle?: string;
  /** 是否接受首次鼠标点击（macOS），默认 false */
  acceptFirstMouse?: boolean;
  /** 网页相关配置（preload.js 文件路径，相对插件应用根目录） */
  webPreferences?: {
    preload?: string;
  };
}
```

**`BrowserWindow` 实例**（由 uTools 管理的窗口实例，方法与 Electron BrowserWindow 一致，不支持实例事件监听）：

| 分组 | 属性 / 方法 |
| --- | --- |
| 属性 | `id`（窗口唯一标识）、`webContents`（[WebContents](#webcontents-类型) 页面对象） |
| 显示 | `show()` / `showInactive()`（显示但不抢焦点）/ `hide()` / `close()` / `destroy()` |
| 焦点 | `focus()` / `blur()` / `isFocused()` / `focusOnWebView()` / `blurWebView()` |
| 状态 | `isVisible()` / `isDestroyed()` / `isMaximized()` / `isMinimized()` / `isNormal()` / `isFullScreen()` / `isFullScreenable()` / `isClosable()` / `isAlwaysOnTop()` / `isResizable()` / `isEnabled()` / `isKiosk()` / `isContentProtected()` |
| 尺寸位置 | `setSize(width, height, animate?)` / `getSize()` / `setPosition(x, y, animate?)` / `getPosition()` / `setBounds(bounds, animate?)` / `getBounds()` / `setContentBounds(bounds)` / `getContentBounds()` / `getNormalBounds()` / `setContentSize(width, height)` / `getContentSize()` / `setMinimumSize(w, h)` / `getMinimumSize()` / `setMaximumSize(w, h)` / `getMaximumSize()` / `center()` |
| 窗口控制 | `maximize()` / `unmaximize()` / `minimize()` / `restore()` / `setResizable(resizable)` / `setFullScreen(flag)` / `setFullScreenable(flag)` / `setClosable(closable)` / `setAlwaysOnTop(flag, level?)`（level 如 `'screen-saver'`）/ `moveTop()` / `setEnabled(enable)` / `setKiosk(flag)` / `flashFrame(flag)` |
| 外观 | `setTitle(title)` / `getTitle()` / `setAspectRatio(ratio, extraSize?)` / `setBackgroundColor(color)` / `getBackgroundColor()` / `setHasShadow(hasShadow)` / `hasShadow()` / `setIgnoreMouseEvents(ignore, { forward }?)` / `setSkipTaskbar(skip)` / `setMenuBarVisibility(visible)` / `isMenuBarVisible()` |
| 任务栏/工作区 | `setProgressBar(progress, { mode }?)`（progress 0~1，小于 0 移除）/ `setVisibleOnAllWorkspaces(visible, options?)` / `isVisibleOnAllWorkspaces()` / `setContentProtection(enable)`（防截取窗口内容，Windows/macOS） |
| 页面 | `capturePage(rect?, options?): Promise<NativeImage>`（options：`stayHidden` 默认 true、`stayAwake` 默认 false）/ `reload()` / `reloadIgnoringCache()` / `loadURL(url): Promise<void>` / `loadFile(filePath): Promise<void>` / `isLoading()` / `stop()` |

<a id="webcontents-类型"></a>
**`WebContents` 页面对象**（通过 `win.webContents` 访问，`id` 为页面唯一标识）：

| 分组 | 方法 |
| --- | --- |
| 通信 | `send(channel, ...args)`（页面内通过 preload 的 `ipcRenderer.on(channel, ...)` 接收） |
| 开发者工具 | `openDevTools({ mode, activate?, title? })`（mode：`'left' \| 'right' \| 'bottom' \| 'undocked' \| 'detach'`）/ `closeDevTools()` / `isDevToolsOpened()` / `isDevToolsFocused()` / `toggleDevTools()` |
| 执行代码 | `executeJavaScript<T>(code, userGesture?): Promise<T>` / `insertCSS(css, { cssOrigin }?): Promise<string>` / `removeInsertedCSS(key): Promise<void>` / `insertText(text): Promise<void>` |
| 编辑命令 | `copy()` / `cut()` / `paste()` / `pasteAndMatchStyle()` / `delete()` / `undo()` / `redo()` / `selectAll()` / `unselect()` / `replace(text)` / `replaceMisspelling(text)` / `copyImageAt(x, y)` |
| 查找 | `findInPage(text, { forward?, findNext?, matchCase? })` / `stopFindInPage(action)`（action：`'clearSelection' \| 'keepSelection' \| 'activateSelection'`） |
| 加载状态 | `isLoading()` / `isLoadingMainFrame()` / `isWaitingForResponse()` / `stop()` / `isDestroyed()` / `isCrashed()` / `isFocused()` / `isPainting()` / `isOffscreen()` / `startPainting()` / `stopPainting()` / `isBeingCaptured()` / `isCurrentlyAudible()` |
| 音频 | `isAudioMuted()` / `setAudioMuted(muted)` |
| 页面信息 | `getTitle()` / `getURL()` / `getUserAgent()` / `setUserAgent(ua)` |
| 缩放/性能 | `getZoomFactor()` / `setZoomFactor(factor)` / `getBackgroundThrottling()` / `setBackgroundThrottling(allowed)` / `getFrameRate()` / `setFrameRate(fps)` |
| WebRTC/进程 | `getWebRTCIPHandlingPolicy()` / `setWebRTCIPHandlingPolicy(policy)` / `setIgnoreMenuShortcuts(ignore)` / `getProcessId()` / `getOSProcessId()` |
| 打印导出 | `getPrinters(): PrinterSync[]`（description/displayName/isDefault/status）/ `print(options?, callback?)` / `printToPDF(options): Promise<Uint8Array>` / `savePage(fullPath, saveType)`（`'HTMLOnly' \| 'HTMLComplete' \| 'MHTML'`）/ `takeHeapSnapshot(filePath): Promise<void>` |
| 其他 | `sendInputEvent(e)` / `invalidate()` / `blur()` / `focus()` / `enableDeviceEmulation()` / `disableDeviceEmulation()` |

> `Rectangle`、`Size`、`NativeImage` 为窗口与屏幕共用的类型，类型定义见[屏幕](screen.md#def-nativeimage)一章。

### 自定义窗口要点

- **窗口显示**：创建后是否立即显示由 `options.show` 控制。对需要等待页面加载完成后再显示的窗口，建议 `show: false` 并在 callback 中调用 `win.show()`，避免白屏或界面闪烁。
- **窗口结构**：HTML 入口文件（必需，通常在 `public/`）+ UI 渲染层（可选，`src/`）+ preload 桥接层（可选，`bridge/`，编写规范与插件应用主界面 preload 一致）。
- **通信方向**：主界面 → 自定义窗口用 `win.webContents.send()`（窗口 preload 中 `ipcRenderer.on()` 接收）；自定义窗口 → 主界面用 [`utools.sendToParent()`](#api-utools-sendToParent)。
- **全屏透明置顶窗口**：设 `transparent: true` + `frame: false` + `alwaysOnTop: true` + `skipTaskbar: true` 等，并在创建后再 `setBounds(displayBounds)` + `setAlwaysOnTop(true, "screen-saver")`（避免部分 Windows 环境窗口未完全覆盖屏幕）。如需接收鼠标事件，可将 `backgroundColor` 设为接近全透明但实际有背景的颜色（如 `"rgba(255, 255, 255, 0.01)"`）。
- **性能注意**：含复杂动画/3D 渲染的透明窗口建议保持 `focusable: true` 并让窗口获得焦点；`focusable: false` 可能被 Chromium 视为非活动窗口而降低渲染优先级或帧率，`backgroundThrottling: false` 不能完全避免。
- **关闭窗口**：窗口内 `window.close()`（若 `closeable: false` 则无法自行关闭）；或由主界面通过 IPC 调用 `win.close()` 统一管理。
- ⚠️ **uTools 主窗口隐藏后，插件应用可能会在用户设定的时间（默认 3 分钟）内自动退出。避免在 `onPluginOut` 中关闭自定义窗口**，以免插件应用自动退出时关闭仍在使用的自定义窗口。
- 从自定义窗口重新打开插件应用主界面应使用 [`utools.redirect([pluginName, cmdLabel])`](redirect.md#api-utools-redirect)。

**基础示例**

主界面：

```js
const win = utools.createBrowserWindow(
  "test.html",
  {
    show: false,
    title: "测试窗口",
    webPreferences: {
      preload: "test_preload.js",
    },
  },
  () => {
    // 显示
    win.show();
    // 置顶
    win.setAlwaysOnTop(true);
    // 向自定义窗口发送消息
    win.webContents.send("ping", "test");
  }
);
```

自定义窗口 preload.js：

```js
const { ipcRenderer } = require("electron");
ipcRenderer.on("ping", (event, data) => {
  console.log(data);
});
// 向创建当前自定义窗口的插件应用主界面发送消息
utools.sendToParent("pong", "hello world");
```

<a id="api-utools-sendToParent"></a>
## `utools.sendToParent(channel[, ...args])`

向创建当前自定义窗口的父窗口发送消息。

> 💡 接收方为创建该窗口的窗口（可以是插件应用主界面，也可以是其他自定义窗口），在其 preload 中通过 `ipcRenderer.on(channel, ...)` 接收。

```ts
function sendToParent(channel: string, ...args: any[]): void; // 版本：>=6.1.0
```

- `channel` 消息通道名称
- `...args` 要发送的消息参数

```js
utools.sendToParent("pong", "hello", 123);
```

<a id="api-utools-getWindowType"></a>
## `utools.getWindowType()`

获取当前窗口类型。

```ts
function getWindowType(): "main" | "detach" | "custom";
```

**返回**：

- `main`：uTools 搜索框主窗口
- `detach`：插件应用与 uTools 搜索框主窗口分离后运行的独立窗口
- `custom`：插件应用创建的自定义窗口

```js
const windowType = utools.getWindowType();
console.log(windowType);
```

> 📜 官方 7.x 文档中自定义窗口的返回值曾为 `"browser"`，8.0 文档已改为 `"custom"`。兼容旧版请以运行时实际值为准。

<a id="api-utools-hideMainWindow"></a>
## `utools.hideMainWindow(isRestorePreWindow)`

隐藏 uTools 搜索框主窗口。

执行后，uTools 搜索框主窗口及当前在主窗口中运行的插件应用都会被隐藏；已经分离为独立窗口的插件应用不受影响。

```ts
function hideMainWindow(isFocusPrevWindow?: boolean): boolean;
```

- `isRestorePreWindow`（类型定义中为 `isFocusPrevWindow`，官方标题与类型定义参数名不一致，此处保留官方原文）是否将焦点回归到之前操作的系统窗口，默认 `true`

**返回**：`true` 执行成功；`false` 执行失败，当前执行窗口不是 uTools 搜索框主窗口。

```js
utools.hideMainWindow();
```

<a id="api-utools-showMainWindow"></a>
## `utools.showMainWindow()`

显示 uTools 搜索框主窗口。

执行后，uTools 搜索框主窗口及当前在主窗口中运行的插件应用都会显示。

```ts
function showMainWindow(): boolean;
```

**返回**：`true` 执行成功；`false` 执行失败，当前执行窗口不是 uTools 搜索框主窗口。

```js
utools.showMainWindow();
```

<a id="api-utools-setExpandHeight"></a>
## `utools.setExpandHeight(height)`

设置插件应用在 uTools 搜索框主窗口中的显示高度，单位为 DIP。

```ts
function setExpandHeight(height: number): boolean;
```

- `height` 插件应用在主窗口中的显示高度，单位为 DIP

**返回**：`true` 设置成功；`false` 设置失败，当前执行窗口不是 uTools 搜索框主窗口。

```js
utools.setExpandHeight(300);
```

> 📜 官方 7.x 文档中该 API 拼作 `setExpendHeight`（笔误），8.0 文档已修正为 `setExpandHeight`。

<a id="api-utools-setSubInput"></a>
## `utools.setSubInput(onChange[, placeholder[, isFocus]])`

设置子输入框。

进入插件应用后，uTools 搜索框主窗口的主输入框将切换为子输入框，插件应用可以通过子输入框接收用户输入。

```ts
function setSubInput(
  onChange: (details: { text: string }) => void,
  placeholder?: string,
  isFocus?: boolean
): boolean;
```

- `onChange` 子输入框内容发生变化时调用的回调函数
- `placeholder` 子输入框占位文本
- `isFocus` 是否自动聚焦输入框，默认为 `true`

**返回**：`true` 设置成功；`false` 设置失败，当前执行窗口是自定义窗口。

```js
utools.setSubInput(({ text }) => {
  console.log(text);
}, "搜索");
```

<a id="api-utools-removeSubInput"></a>
## `utools.removeSubInput()`

移除子输入框。

```ts
function removeSubInput(): boolean;
```

**返回**：`true` 移除成功；`false` 移除失败，当前执行窗口是自定义窗口。

```js
utools.removeSubInput();
```

<a id="api-utools-setSubInputValue"></a>
## `utools.setSubInputValue(text)`

设置子输入框的值。

```ts
function setSubInputValue(text: string): boolean;
```

- `text` 要设置的文本内容

**返回**：`true` 设置成功；`false` 设置失败，当前执行窗口是自定义窗口。

```js
utools.setSubInputValue("hello world");
```

<a id="api-utools-subInputFocus"></a>
## `utools.subInputFocus()`

使子输入框获得焦点。

```ts
function subInputFocus(): boolean;
```

**返回**：`true` 设置成功；`false` 设置失败，当前执行窗口是自定义窗口。

```js
utools.subInputFocus();
```

<a id="api-utools-subInputBlur"></a>
## `utools.subInputBlur()`

使子输入框失去焦点，并使插件应用获得焦点。

```ts
function subInputBlur(): void;
```

```js
utools.subInputBlur();
```

<a id="api-utools-subInputSelect"></a>
## `utools.subInputSelect()`

使子输入框获得焦点，并选中输入框中的全部内容。

```ts
function subInputSelect(): boolean;
```

**返回**：`true` 操作成功；`false` 操作失败，当前执行窗口是自定义窗口。

```js
utools.subInputSelect();
```

<a id="api-utools-findInPage"></a>
## `utools.findInPage(text[, options])`

在当前页面中查找指定文本。

```ts
function findInPage(text: string, options?: FindInPageOptions): void;
```

- `text` 要查找的文本
- `options` 查找选项

```ts
interface FindInPageOptions {
  /** 是否向前搜索，默认 true */
  forward?: boolean;
  /** 是否开始新的查找会话。首次查找时应设置为 true，继续查找时设置为 false，默认 false */
  findNext?: boolean;
  /** 是否区分大小写，默认 false */
  matchCase?: boolean;
}
```

```js
utools.findInPage("hello");
```

<a id="api-utools-stopFindInPage"></a>
## `utools.stopFindInPage(action)`

停止当前页面的文本查找，与 `findInPage` 配合使用。

```ts
function stopFindInPage(
  action: "clearSelection" | "keepSelection" | "activateSelection"
): void;
```

- `action` 停止查找后的选区处理方式，默认为 `clearSelection`：`clearSelection` 清除选中文本、`keepSelection` 保留选中文本、`activateSelection` 激活选中文本

```js
utools.stopFindInPage("clearSelection");
```

<a id="api-utools-outPlugin"></a>
## `utools.outPlugin([isKill])`

退出当前插件应用。

默认情况下，插件应用退出到后台，等待下次快速响应；传入 `true` 时，将结束插件应用的运行。

```ts
function outPlugin(isKill?: boolean): void;
```

- `isKill` 是否结束插件应用的运行，默认为 `false`

```js
// 退出到后台
utools.outPlugin();
// 结束运行
utools.outPlugin(true);
```

---

> 📜 以下 API 已随官方 8.0 文档重组迁往其他章节（API 本身未下线）：
>
> - [`utools.redirect(label[, payload])`](redirect.md#api-utools-redirect) → [快捷入口](redirect.md#ch-redirect)
> - [`utools.showOpenDialog(options)`](system.md#api-utools-showOpenDialog) / [`utools.showSaveDialog(options)`](system.md#api-utools-showSaveDialog) → [系统](system.md#ch-system)
> - [`utools.startDrag(filePath)`](input.md#api-utools-startDrag) → [输入](input.md#ch-input)
> - [`utools.isDarkColors()`](system.md#api-utools-isDarkColors) → [系统](system.md#ch-system)
