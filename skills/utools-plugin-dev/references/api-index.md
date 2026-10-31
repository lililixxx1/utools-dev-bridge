# uTools 插件开发 API 文档（AI Agent 优化版）

> 本文档为 uTools 插件应用开发 API 参考，由官方文档清洗为标准 Markdown，面向 AI Agent 消费优化：
> 所有 API 均有显式 HTML 锚点（见下方速查索引）；含 `//` 注释的 JSON 示例标注为 `jsonc`（非严格 JSON，勿直接 `JSON.parse`）。
>
> **全局约束**：
> - `plugin.json` 必填 `logo` 与 `main`（普通插件）；仅面向 AI Agent 的无 UI 插件可省略 `main`/`features`，但必填 `logo` + `preload` + `tools`
> - `preload.js` 及其 Node.js 依赖禁止打包/压缩/混淆，必须保持源码可读并随插件提交
> - `preload.js` 遵循 CommonJS（uTools 8.0 运行于 Electron 34.5.8 / Chromium 132 / Node.js 20.19.1；7.x 为 Node.js 16.x），可 `require` Node 原生模块、第三方模块与 Electron 渲染进程 API
> - 标注「版本：>=x.y.z」的 API 需 uTools 达到对应版本
> - 官方 8.0 文档已修正 7.x 历史拼写并重命名若干 API：`getCopyedFiles`→`getCopiedFiles`、`CopiedFile.isDiractory`→`isDirectory`、`onPluginEnter` `from:"reirect"`→`"redirect"`、`setExpendHeight`→`setExpandHeight`、`ubrowser.useragent`→`userAgent`、`ubrowser.end()`→`endWhen()`、`feature.explain`→`feature.description`、`getWindowType()` 自定义窗口返回值 `"browser"`→`"custom"`；文档内以 📜 标注旧名，维护 7.x 存量代码时注意对照

**指南章节**：[插件目录结构](./structure.md#ch-structure) · [plugin.json 配置](./plugin-json.md#ch-plugin-json) · [preload 机制](./preload.md#ch-preload) · [数据存储](./storage.md#ch-storage) · [MCP 集成](./tools.md#ch-tools) · [Node.js 依赖](./nodejs.md#ch-nodejs)

> 索引与 `references/` 下 26 个章节文件复制自维护者的 uTools 官方文档清洗版工程（对齐 uTools 8.0.2 官方站）。唯一改动：链接前缀 `./docs/` → `./`。

## API 速查索引

| 模块 | API | 说明 |
| --- | --- | --- |
| 事件 | [utools.onPluginReady(callback)](./events.md#api-utools-onPluginReady) | 插件应用就绪时触发（可 async，运行时等待完成） |
| 事件 | [utools.onPluginEnter(callback)](./events.md#api-utools-onPluginEnter) | 进入插件应用时触发（回传 code/type/payload） |
| 事件 | [utools.onPluginOut(callback)](./events.md#api-utools-onPluginOut) | 插件退出/隐藏时触发 |
| 事件 | [utools.onScheduleTrigger(callback)](./events.md#api-utools-onScheduleTrigger) | 定时任务触发时回调 |
| 事件 | [utools.onMainPush(callback, onSelect)](./events.md#api-utools-onMainPush) | 向搜索框推送内容并处理选择 |
| 事件 | [utools.onPluginDetach(callback)](./events.md#api-utools-onPluginDetach) | 插件分离为独立窗口时触发 |
| 事件 | [utools.onDbPull(callback)](./events.md#api-utools-onDbPull) | 云端数据同步到本设备时触发 |
| 窗口 | [utools.createBrowserWindow(url[, options][, callback])](./window.md#api-utools-createBrowserWindow) | 创建独立 BrowserWindow 窗口 |
| 窗口 | [utools.sendToParent(channel[, ...args])](./window.md#api-utools-sendToParent) | 子窗口向父窗口发消息 |
| 窗口 | [utools.getWindowType()](./window.md#api-utools-getWindowType) | 获取当前窗口类型（main/browser/custom） |
| 窗口 | [utools.hideMainWindow(isRestorePreWindow)](./window.md#api-utools-hideMainWindow) | 隐藏 uTools 主窗口 |
| 窗口 | [utools.showMainWindow()](./window.md#api-utools-showMainWindow) | 显示 uTools 主窗口 |
| 窗口 | [utools.setExpandHeight(height)](./window.md#api-utools-setExpandHeight) | 设置插件在主窗口中的高度 |
| 窗口 | [utools.setSubInput(onChange[, placeholder[, isFocus]])](./window.md#api-utools-setSubInput) | 设置子输入框及输入回调 |
| 窗口 | [utools.removeSubInput()](./window.md#api-utools-removeSubInput) | 移除子输入框 |
| 窗口 | [utools.setSubInputValue(text)](./window.md#api-utools-setSubInputValue) | 设置子输入框的值 |
| 窗口 | [utools.subInputFocus()](./window.md#api-utools-subInputFocus) | 聚焦子输入框 |
| 窗口 | [utools.subInputBlur()](./window.md#api-utools-subInputBlur) | 子输入框失焦，插件获焦 |
| 窗口 | [utools.subInputSelect()](./window.md#api-utools-subInputSelect) | 聚焦并选中子输入框内容 |
| 窗口 | [utools.findInPage(text[, options])](./window.md#api-utools-findInPage) | 当前页面内查找文本 |
| 窗口 | [utools.stopFindInPage(action)](./window.md#api-utools-stopFindInPage) | 停止页面内查找 |
| 窗口 | [utools.outPlugin([isKill])](./window.md#api-utools-outPlugin) | 退出插件应用（可杀进程） |
| 快捷入口 | [utools.redirect(label[, payload])](./redirect.md#api-utools-redirect) | 跳转其他插件应用并携带内容 |
| 快捷入口 | [utools.redirectHotKeySetting(cmdLabel[, autocopy])](./redirect.md#api-utools-redirectHotKeySetting) | 跳转指令快捷键设置 |
| 快捷入口 | [utools.getCmdHotKey(cmdLabel)](./redirect.md#api-utools-getCmdHotKey) | 获取指令当前快捷键 |
| 定时任务 | [utools.requestSchedule(schedule)](./schedule.md#api-utools-requestSchedule) | 注册/更新定时任务（Cron 触发） |
| 定时任务 | [utools.getSchedules()](./schedule.md#api-utools-getSchedules) | 获取已注册定时任务及执行状态 |
| 定时任务 | [utools.removeSchedule(code)](./schedule.md#api-utools-removeSchedule) | 移除定时任务 |
| 复制 | [utools.copyText(text)](./copy.md#api-utools-copyText) | 复制文本 |
| 复制 | [utools.copyFile(filePath)](./copy.md#api-utools-copyFile) | 复制文件(夹) |
| 复制 | [utools.copyImage(image)](./copy.md#api-utools-copyImage) | 复制图像（路径/base64/Buffer） |
| 复制 | [utools.getCopiedFiles()](./copy.md#api-utools-getCopiedFiles) | 获取剪贴板文件列表（无文件时返回 null） |
| 输入 | [utools.hideMainWindowPasteText(text)](./input.md#api-utools-hideMainWindowPasteText) | 隐藏主窗口并粘贴文本 |
| 输入 | [utools.hideMainWindowPasteFile(filePath)](./input.md#api-utools-hideMainWindowPasteFile) | 隐藏主窗口并粘贴文件 |
| 输入 | [utools.hideMainWindowPasteImage(image)](./input.md#api-utools-hideMainWindowPasteImage) | 隐藏主窗口并粘贴图像 |
| 输入 | [utools.hideMainWindowTypeString(text)](./input.md#api-utools-hideMainWindowTypeString) | 隐藏主窗口并模拟输入文本 |
| 输入 | [utools.startDrag(filePath)](./input.md#api-utools-startDrag) | 向其他窗口拖拽文件 |
| 系统 | [utools.getPluginLocalDataPath()](./system.md#api-utools-getPluginLocalDataPath) | 获取插件本地数据目录（不参与云同步） |
| 系统 | [utools.getPluginTempPath()](./system.md#api-utools-getPluginTempPath) | 获取插件临时目录 |
| 系统 | [utools.showNotification(body[, clickFeatureCode])](./system.md#api-utools-showNotification) | 弹出系统通知 |
| 系统 | [utools.showOpenDialog(options)](./system.md#api-utools-showOpenDialog) | 弹出文件选择框（返回 Promise） |
| 系统 | [utools.showSaveDialog(options)](./system.md#api-utools-showSaveDialog) | 弹出文件保存框（返回 Promise） |
| 系统 | [utools.shellOpenPath(fullPath)](./system.md#api-utools-shellOpenPath) | 系统默认方式打开文件（返回 Promise） |
| 系统 | [utools.shellTrashItem(fullPath)](./system.md#api-utools-shellTrashItem) | 删除文件到回收站（返回 Promise） |
| 系统 | [utools.shellShowItemInFolder(fullPath)](./system.md#api-utools-shellShowItemInFolder) | 在文件管理器中显示文件（返回 Promise） |
| 系统 | [utools.shellOpenExternal(url)](./system.md#api-utools-shellOpenExternal) | 系统默认协议打开 URL（返回 Promise） |
| 系统 | [utools.shellBeep()](./system.md#api-utools-shellBeep) | 播放系统提示音 |
| 系统 | [utools.getNativeId()](./system.md#api-utools-getNativeId) | 获取设备 ID |
| 系统 | [utools.getAppVersion()](./system.md#api-utools-getAppVersion) | 获取软件版本 |
| 系统 | [utools.getUser()](./system.md#api-utools-getUser) | 获取当前登录用户信息 |
| 系统 | [utools.getPath(name)](./system.md#api-utools-getPath) | 获取系统特殊路径（desktop 等） |
| 系统 | [utools.getFileIcon(filePath)](./system.md#api-utools-getFileIcon) | 获取文件/扩展名系统图标（同步） |
| 系统 | [utools.getFileIconAsync(filePath)](./system.md#api-utools-getFileIconAsync) | 异步获取文件/扩展名图标（Promise） |
| 系统 | [utools.readCurrentFolderPath()](./system.md#api-utools-readCurrentFolderPath) | 读取当前文件管理器路径 |
| 系统 | [utools.readCurrentBrowserUrl()](./system.md#api-utools-readCurrentBrowserUrl) | 读取当前浏览器 URL |
| 系统 | [utools.isDev()](./system.md#api-utools-isDev) | 是否开发环境 |
| 系统 | [utools.isMacOS()](./system.md#api-utools-isMacOS) | 是否 macOS |
| 系统 | [utools.isWindows()](./system.md#api-utools-isWindows) | 是否 Windows |
| 系统 | [utools.isLinux()](./system.md#api-utools-isLinux) | 是否 Linux |
| 系统 | [utools.isDarkColors()](./system.md#api-utools-isDarkColors) | 是否深色主题 |
| 屏幕 | [utools.captureDisplay(options)](./screen.md#api-utools-captureDisplay) | 屏幕/区域捕获（返回 Promise） |
| 屏幕 | [utools.screenCapture([callback])](./screen.md#api-utools-screenCapture) | 屏幕截图（Promise 或回调，base64） |
| 屏幕 | [utools.screenColorPick([callback])](./screen.md#api-utools-screenColorPick) | 屏幕取色（Promise 或回调） |
| 屏幕 | [utools.getAllDisplays()](./screen.md#api-utools-getAllDisplays) | 获取所有显示器 |
| 屏幕 | [utools.getPrimaryDisplay()](./screen.md#api-utools-getPrimaryDisplay) | 获取主显示器信息 |
| 屏幕 | [utools.getCursorScreenPoint()](./screen.md#api-utools-getCursorScreenPoint) | 获取鼠标绝对位置 |
| 屏幕 | [utools.getDisplayNearestPoint(point)](./screen.md#api-utools-getDisplayNearestPoint) | 获取点所在显示器 |
| 屏幕 | [utools.getDisplayMatching(rect)](./screen.md#api-utools-getDisplayMatching) | 获取矩形所在显示器 |
| 屏幕 | [utools.screenToDipPoint(point)](./screen.md#api-utools-screenToDipPoint) | 物理坐标转 DIP 坐标 |
| 屏幕 | [utools.dipToScreenPoint(point)](./screen.md#api-utools-dipToScreenPoint) | DIP 坐标转物理坐标 |
| 屏幕 | [utools.screenToDipRect(rect)](./screen.md#api-utools-screenToDipRect) | 物理区域转 DIP 区域 |
| 屏幕 | [utools.dipToScreenRect(rect)](./screen.md#api-utools-dipToScreenRect) | DIP 区域转物理区域 |
| 屏幕 | [utools.desktopCaptureSources(options)](./screen.md#api-utools-desktopCaptureSources) | 获取桌面录屏/截图源 |
| 动态指令 | [utools.getFeatures([codes])](./dynamic-features.md#api-utools-getFeatures) | 获取动态创建的功能 |
| 动态指令 | [utools.setFeature(feature)](./dynamic-features.md#api-utools-setFeature) | 动态新增功能 |
| 动态指令 | [utools.removeFeature(code)](./dynamic-features.md#api-utools-removeFeature) | 动态删除功能 |
| 模拟按键 | [utools.simulateKeyboardTap(key[, ...modifiers])](./simulate-input.md#api-utools-simulateKeyboardTap) | 模拟键盘按键 |
| 模拟按键 | [utools.simulateMouseMove(x, y)](./simulate-input.md#api-utools-simulateMouseMove) | 模拟鼠标移动 |
| 模拟按键 | [utools.simulateMouseClick(x, y)](./simulate-input.md#api-utools-simulateMouseClick) | 模拟鼠标左键单击 |
| 模拟按键 | [utools.simulateMouseDoubleClick(x, y)](./simulate-input.md#api-utools-simulateMouseDoubleClick) | 模拟鼠标左键双击 |
| 模拟按键 | [utools.simulateMouseRightClick(x, y)](./simulate-input.md#api-utools-simulateMouseRightClick) | 模拟鼠标右键单击 |
| AI | [utools.registerTool(name, handler)](./ai.md#api-utools-registerTool) | 注册供 AI Agent 调用的工具（MCP） |
| AI | [utools.ai(options[, streamCallback])](./ai.md#api-utools-ai) | 调用 AI（流式/Function Calling/reasoning_effort） |
| AI | [utools.allAiModels()](./ai.md#api-utools-allAiModels) | 获取所有可用 AI 模型（含 vision/cost） |
| Sharp | [utools.sharp([input], [options])](./sharp.md#api-utools-sharp) | 图像处理（内置 Sharp v0.35.3） |
| FFmpeg | [utools.runFFmpeg(args[, onProgress])](./ffmpeg.md#api-utools-runFFmpeg) | 运行 FFmpeg 音视频处理 |
| db | [utools.db.put(doc)](./db.md#api-utools-db-put) | 创建/更新文档（≤1M，含 promises 版） |
| db | [utools.db.get(id)](./db.md#api-utools-db-get) | 按 ID 获取文档（含 promises 版） |
| db | [utools.db.remove(doc)](./db.md#api-utools-db-remove) | 删除文档（含 promises 版） |
| db | [utools.db.bulkDocs(docs)](./db.md#api-utools-db-bulkDocs) | 批量创建/更新文档（含 promises 版） |
| db | [utools.db.allDocs([filter])](./db.md#api-utools-db-allDocs) | 按前缀/ID 数组取文档（含 promises 版） |
| db | [utools.db.postAttachment(id, attachment, type)](./db.md#api-utools-db-postAttachment) | 存附件（仅新建，≤10M，含 promises 版） |
| db | [utools.db.getAttachment(id)](./db.md#api-utools-db-getAttachment) | 获取附件（含 promises 版） |
| db | [utools.db.getAttachmentType(id)](./db.md#api-utools-db-getAttachmentType) | 获取附件 MIME 类型（含 promises 版） |
| db | [utools.db.replicateStateFromCloud()](./db.md#api-utools-db-replicateStateFromCloud) | 查询云端同步状态（含 promises 版） |
| dbStorage | [utools.dbStorage.setItem(key, value)](./db-storage.md#api-utools-dbStorage-setItem) | 存键值对（明文） |
| dbStorage | [utools.dbStorage.getItem(key)](./db-storage.md#api-utools-dbStorage-getItem) | 取键值对 |
| dbStorage | [utools.dbStorage.removeItem(key)](./db-storage.md#api-utools-dbStorage-removeItem) | 删键值对 |
| dbCryptoStorage | [utools.dbCryptoStorage.setItem(key, value)](./db-crypto-storage.md#api-utools-dbCryptoStorage-setItem) | 加密存键值对（📜 官方 8.0 文档已移除该章） |
| dbCryptoStorage | [utools.dbCryptoStorage.getItem(key)](./db-crypto-storage.md#api-utools-dbCryptoStorage-getItem) | 取加密键值对 |
| dbCryptoStorage | [utools.dbCryptoStorage.removeItem(key)](./db-crypto-storage.md#api-utools-dbCryptoStorage-removeItem) | 删加密键值对 |
| ubrowser | [ubrowser.run([...])](./ubrowser.md#api-ubrowser-run) | 运行链式任务并取结果 |
| ubrowser | [ubrowser.goto(url[, headers][, timeout])](./ubrowser.md#api-ubrowser-goto) | 打开窗口并跳转网页 |
| ubrowser | [ubrowser.userAgent(ua)](./ubrowser.md#api-ubrowser-userAgent) | 设置 User-Agent |
| ubrowser | [ubrowser.viewport(width, height)](./ubrowser.md#api-ubrowser-viewport) | 设置视窗大小 |
| ubrowser | [ubrowser.device(options)](./ubrowser.md#api-ubrowser-device) | 模拟移动设备 |
| ubrowser | [ubrowser.hide()](./ubrowser.md#api-ubrowser-hide) | 隐藏 ubrowser 窗口 |
| ubrowser | [ubrowser.show()](./ubrowser.md#api-ubrowser-show) | 显示 ubrowser 窗口 |
| ubrowser | [ubrowser.devTools([mode])](./ubrowser.md#api-ubrowser-devTools) | 打开开发者工具 |
| ubrowser | [ubrowser.click(selector[, mouseButton])](./ubrowser.md#api-ubrowser-click) | 鼠标点击元素/坐标 |
| ubrowser | [ubrowser.dblclick(selector[, mouseButton])](./ubrowser.md#api-ubrowser-dblclick) | 鼠标双击元素/坐标 |
| ubrowser | [ubrowser.mousedown(selector[, mouseButton])](./ubrowser.md#api-ubrowser-mousedown) | 鼠标按下元素/坐标 |
| ubrowser | [ubrowser.mouseup(selector[, mouseButton])](./ubrowser.md#api-ubrowser-mouseup) | 鼠标抬起元素/坐标 |
| ubrowser | [ubrowser.hover(selector)](./ubrowser.md#api-ubrowser-hover) | 鼠标悬停元素/坐标 |
| ubrowser | [ubrowser.press(key[, modifiers])](./ubrowser.md#api-ubrowser-press) | 模拟键盘按键 |
| ubrowser | [ubrowser.focus(selector)](./ubrowser.md#api-ubrowser-focus) | 聚焦元素 |
| ubrowser | [ubrowser.input([selector, ]payload)](./ubrowser.md#api-ubrowser-input) | 模拟输入法输入文本 |
| ubrowser | [ubrowser.value(selector, payload)](./ubrowser.md#api-ubrowser-value) | 设置输入元素值 |
| ubrowser | [ubrowser.check(selector, checked)](./ubrowser.md#api-ubrowser-check) | 勾选/取消勾选 |
| ubrowser | [ubrowser.scroll(...)](./ubrowser.md#api-ubrowser-scroll) | 滚动到元素/位置（3 种重载） |
| ubrowser | [ubrowser.file(selector, payload)](./ubrowser.md#api-ubrowser-file) | 设置 input[type=file] 文件 |
| ubrowser | [ubrowser.drop(selector, payload)](./ubrowser.md#api-ubrowser-drop) | 拖放文件到元素/坐标 |
| ubrowser | [ubrowser.paste(payload)](./ubrowser.md#api-ubrowser-paste) | 粘贴文本/图像 |
| ubrowser | [ubrowser.download(...)](./ubrowser.md#api-ubrowser-download) | 下载资源到指定路径 |
| ubrowser | [ubrowser.evaluate(func[, ...args])](./ubrowser.md#api-ubrowser-evaluate) | 网页内执行 JS |
| ubrowser | [ubrowser.css(css)](./ubrowser.md#api-ubrowser-css) | 注入自定义 CSS |
| ubrowser | [ubrowser.wait(...)](./ubrowser.md#api-ubrowser-wait) | 等待时长/元素/条件（6 种重载） |
| ubrowser | [ubrowser.when(...)](./ubrowser.md#api-ubrowser-when) | 条件判断 |
| ubrowser | [ubrowser.endWhen()](./ubrowser.md#api-ubrowser-endWhen) | 结束上一个 when（📜 7.x 为 end()） |
| ubrowser | [ubrowser.markdown([selector])](./ubrowser.md#api-ubrowser-markdown) | 网页内容转 Markdown |
| ubrowser | [ubrowser.screenshot([target][, savePath])](./ubrowser.md#api-ubrowser-screenshot) | 网页截屏存 png |
| ubrowser | [ubrowser.pdf(options[, savePath])](./ubrowser.md#api-ubrowser-pdf) | 网页保存为 PDF |
| ubrowser | [ubrowser.cookies(...)](./ubrowser.md#api-ubrowser-cookies) | 获取 cookie |
| ubrowser | [ubrowser.setCookies(...)](./ubrowser.md#api-ubrowser-setCookies) | 设置 cookie |
| ubrowser | [ubrowser.removeCookies(name)](./ubrowser.md#api-ubrowser-removeCookies) | 删 cookie |
| ubrowser | [ubrowser.clearCookies([url])](./ubrowser.md#api-ubrowser-clearCookies) | 清空 cookie |
| ubrowser | [utools.getIdleUBrowsers()](./ubrowser.md#api-utools-getIdleUBrowsers) | 获取空闲 ubrowser 实例 |
| ubrowser | [utools.setUBrowserProxy(config)](./ubrowser.md#api-utools-setUBrowserProxy) | 设置 ubrowser 代理 |
| ubrowser | [utools.clearUBrowserCache()](./ubrowser.md#api-utools-clearUBrowserCache) | 清除 ubrowser 缓存 |
| 团队应用 | [utools.team.info()](./team.md#api-utools-team-info) | 获取当前团队信息（📜 官方站已下线） |
| 团队应用 | [utools.team.preset(key)](./team.md#api-utools-team-preset) | 获取团队下发配置 |
| 团队应用 | [utools.team.allPresets([keyStartsWith])](./team.md#api-utools-team-allPresets) | 批量获取团队配置 |
| 用户付费 | [utools.isPurchasedUser()](./payment.md#api-utools-isPurchasedUser) | 是否已付费/授权用户（📜 7.x 为 isPricingUser） |
| 用户付费 | [utools.openPurchase(options, callback)](./payment.md#api-utools-openPurchase) | 打开付费/授权购买（支持 outOrderId/attach） |
| 用户付费 | [utools.openPayment(options, callback)](./payment.md#api-utools-openPayment) | 打开服务支付（📜 8.0 已移除，改用 openPurchase） |
| 用户付费 | [utools.fetchUserPayments()](./payment.md#api-utools-fetchUserPayments) | 获取用户支付记录（📜 8.0 已移除） |
| 服务端 API | [获取用户基础信息](./server-api.md#api-server-baseinfo) | GET 获取用户基础信息（📜 官方站已下线） |
| 服务端 API | [支付订单查询接口](./server-api.md#api-server-payments-record) | GET 查询支付订单 |
| 服务端 API | [创建商品接口](./server-api.md#api-server-goods) | POST 动态创建商品 |
| 服务端 API | [用户支付成功回调接口](./server-api.md#api-server-pay-callback) | 支付成功回调（uTools→你的服务） |
| 服务端 API | [utools.fetchUserServerTemporaryToken()](./server-api.md#api-utools-fetchUserServerTemporaryToken) | 获取服务端临时令牌（📜 8.0 文档已移除） |
