<a id="ch-copy"></a>
# 复制

> 模块：复制（4 API）· [← 总索引（含全局约束）](api-index.md)

向系统剪贴板复制文本、图片、文件及文件夹。

<a id="api-utools-copyText"></a>
## `utools.copyText(text)`

复制文本

```ts
function copyText(text: string): boolean;
```

- `text` 被复制的文本

```js
utools.copyText("Hello World!");
```

<a id="api-utools-copyFile"></a>
## `utools.copyFile(filePath)`

复制文件或文件夹，将指定文件或文件夹写入系统剪贴板。

> ⚠️ 文件复制不会立即产生文件副本，仅会将文件路径写入系统剪贴板。用户执行粘贴操作时，由目标应用决定如何处理。

```ts
function copyFile(filePath: string | string[]): boolean;
```

- `filePath` 需要复制的文件或文件夹路径，可以传入单个路径，也可以传入多个路径组成的数组

**返回**：`true` 复制成功；`false` 复制失败

```js
// 复制一个文件
utools.copyFile("/path/to/test.txt");
// 复制多个文件
utools.copyFile(["/path/to/test.txt", "/path/to/folder"]);
```

<a id="api-utools-copyImage"></a>
## `utools.copyImage(image)`

复制图片数据到系统剪贴板。

```ts
function copyImage(image: string | Uint8Array): boolean;
```

- `image` 可以是图片文件路径、图片 Data URL，或图片二进制数据 `Uint8Array`

**返回**：`true` 复制成功；`false` 复制失败

```js
// base64 Data URL
utools.copyImage("data:image/png;base64,......");
// 路径
utools.copyImage("/path/to/img.png");
```

<a id="api-utools-getCopiedFiles"></a>
## `utools.getCopiedFiles()`

获取系统剪贴板中的文件列表。

> 📜 官方 7.x 文档中该 API 拼作 `getCopyedFiles()`、字段 `isDiractory`（笔误），8.0 文档已修正为 `getCopiedFiles()` / `isDirectory`。

```ts
function getCopiedFiles(): CopiedFile[] | null;
```

**返回**：当前剪贴板中的文件列表；当剪贴板内容不包含文件时，返回 `null`。

**`CopiedFile` 类型定义**

```ts
interface CopiedFile {
  /** 文件路径 */
  path: string;
  /** 是否为文件夹 */
  isDirectory: boolean;
  /** 是否为文件 */
  isFile: boolean;
  /** 文件名 */
  name: string;
}
```

```js
const copiedFiles = utools.getCopiedFiles();
if (copiedFiles) {
  copiedFiles.forEach(file => {
    console.log(file.path);
  });
}
```
