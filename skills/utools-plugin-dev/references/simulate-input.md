<a id="ch-simulate"></a>
# 模拟操作

> 模块：模拟操作（5 API）· [← 总索引（含全局约束）](api-index.md)

uTools 提供模拟用户键盘和鼠标操作的 API，可用于自动执行基础的键盘和鼠标操作。

<a id="api-utools-simulateKeyboardTap"></a>
## `utools.simulateKeyboardTap(key[, ...modifiers])`

模拟键盘按键操作。

```ts
function simulateKeyboardTap(key: string, ...modifiers: string[]): void;
```

- `key` 要模拟的按键
- `modifiers` 要模拟的修饰键，可传入多个，例如 `shift`、`ctrl`、`alt`、`command`

```js
// 模拟键盘敲击 Enter
utools.simulateKeyboardTap("enter");
// windows linux 模拟粘贴
utools.simulateKeyboardTap("v", "ctrl");
// macOS 模拟粘贴
utools.simulateKeyboardTap("v", "command");
// 模拟 Ctrl + Alt + A
utools.simulateKeyboardTap("a", "ctrl", "alt");
```

<a id="api-utools-simulateMouseMove"></a>
## `utools.simulateMouseMove(x, y)`

模拟鼠标移动到指定屏幕坐标。

```ts
function simulateMouseMove(x: number, y: number): void;
```

- `x` 鼠标位置距离屏幕左侧的坐标，单位为物理像素
- `y` 鼠标位置距离屏幕顶部的坐标，单位为物理像素

```js
// 将鼠标移动到距离屏幕左侧 50 像素、顶部 50 像素的位置
utools.simulateMouseMove(50, 50);
```

<a id="api-utools-simulateMouseClick"></a>
## `utools.simulateMouseClick(x, y)`

模拟鼠标左键点击

```ts
function simulateMouseClick(x: number, y: number): void;
```

- `x` 鼠标位置距离屏幕左侧的坐标，单位为物理像素
- `y` 鼠标位置距离屏幕顶部的坐标，单位为物理像素

```js
// 在屏幕距离左侧 100 像素顶部 100 像素的位置点击
utools.simulateMouseClick(100, 100);
```

<a id="api-utools-simulateMouseDoubleClick"></a>
## `utools.simulateMouseDoubleClick(x, y)`

模拟鼠标左键双击

```ts
function simulateMouseDoubleClick(x: number, y: number): void;
```

- `x` 鼠标位置距离屏幕左侧的坐标，单位为物理像素
- `y` 鼠标位置距离屏幕顶部的坐标，单位为物理像素

```js
// 在屏幕距离左侧 100 像素顶部 100 像素的位置双击
utools.simulateMouseDoubleClick(100, 100);
```

<a id="api-utools-simulateMouseRightClick"></a>
## `utools.simulateMouseRightClick(x, y)`

模拟鼠标右键点击

```ts
function simulateMouseRightClick(x: number, y: number): void;
```

- `x` 鼠标位置距离屏幕左侧的坐标，单位为物理像素
- `y` 鼠标位置距离屏幕顶部的坐标，单位为物理像素

```js
// 在屏幕距离左侧 100 像素顶部 100 像素的位置右击
utools.simulateMouseRightClick(100, 100);
```
