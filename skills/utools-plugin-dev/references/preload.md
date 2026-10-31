<a id="ch-preload"></a>
# preload 桥接层

> 模块：preload 机制（指南）· [← 总索引（含全局约束）](api-index.md)

`preload.js` 是插件应用连接「前端界面」与「本地能力」的桥接层。当 plugin.json 配置了 `preload` 字段后，uTools 会在插件应用主界面加载前预加载指定的 JavaScript 文件。

`preload.js` 运行在具有本地能力的上下文中，可以使用 Node.js 原生模块、第三方 Node.js 模块、Electron 渲染进程 API 以及 uTools API，并通过 `window` 对象向前端暴露自定义接口。

| 能力 | 说明 |
| --- | --- |
| Node.js 原生模块 | 访问文件系统、进程、网络等本地能力，例如 `fs`、`path`、`os`、`child_process` |
| 第三方 Node.js 模块 | 使用通过 npm 安装或以源码形式引入的 Node.js 模块 |
| Electron 渲染进程 API | 使用 Electron 提供的渲染进程能力，例如 `clipboard`、`nativeImage` |
| uTools API | 调用 uTools 提供的插件应用 API |

关于插件应用整体架构，请参阅[插件应用架构](structure.md#ch-structure)。

## `preload` 的定义

### 文件位置

`preload.js` 文件必须位于插件应用目录内，与 `plugin.json` 位于同一目录或其子目录中，以确保打包插件应用时能够将其一同打包。

### 文件声明

需要在 plugin.json 中通过 `preload` 字段声明文件路径。路径必须使用相对于 `plugin.json` 所在目录的**相对路径**：

```json
{
  "preload": "preload.js"
}
```

### 模块规范

`preload.js` 遵循 CommonJS 模块规范，可以使用 `require()` 引入 Node.js 原生模块、第三方模块以及插件应用自己的模块。

运行环境提供的 **Node.js 版本为 v20.19.1**（运行环境详情见[插件应用架构](structure.md#ch-structure)）。

## 前端使用 `preload`

`preload.js` 可以通过 `window` 对象向前端暴露自定义接口。推荐使用统一的命名空间（例如 `window.services`），避免向 `window` 直接挂载大量独立属性。

**preload.js**

```js
const fs = require("node:fs");

window.services = {
  readFile: (filePath) => {
    return fs.readFileSync(filePath, "utf8");
  },
};
```

**App.jsx**

```jsx
import { useEffect, useState } from "react";
export default function App() {
  const [content, setContent] = useState("");
  useEffect(() => {
    const fileContent = window.services.readFile("/path/to/README.md");
    setContent(fileContent);
  }, []);

  return (
    <div>
      <pre>{content}</pre>
    </div>
  );
}
```

引入第三方模块与 Node.js 依赖处理的详细说明见[使用 Node.js](nodejs.md#ch-nodejs)。

## `preload` 规范

- `preload.js` 文件代码**不能进行打包/压缩/混淆**等操作，要保证每一行代码清晰可读
- 引入的第三方模块也必须清晰可读，在提交时将源码一同提交，同样不允许压缩/混淆
- 推荐使用统一命名空间（如 `window.services`）暴露接口，避免向 `window` 挂载大量独立属性
- 遵循最小暴露原则，仅暴露前端实际需要的接口
- **禁止**直接暴露 Node.js 对象、`fs`、`child_process` 等高权限接口给前端
