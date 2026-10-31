<a id="ch-plugin-json"></a>
# plugin.json 核心配置文件说明

> 模块：plugin.json 配置（指南）· [← 总索引（含全局约束）](api-index.md)

`plugin.json` 是插件应用的核心配置文件，用于声明插件应用的基本信息（main 主界面入口、logo 图标、preload 本地能力桥接）、功能入口（features），以及可选的 AI Agent 工具能力（tools）。每个插件应用都必须包含一个 `plugin.json` 文件。

在 uTools 运行体系中，plugin.json 是用于识别插件应用的入口配置文件。关于插件应用整体架构，请参阅[插件应用架构](structure.md#ch-structure)。

## 配置文件格式

plugin.json 文件是一个标准的 JSON 文件，它的结构如下：

```json
{
  "main": "index.html",
  "logo": "logo.png",
  "preload": "preload.js",
  "features": [
    {
      "code": "hello",
      "description": "hello world",
      "cmds": ["hello", "你好"]
    }
  ]
}
```

> 📜 官方 7.x 文档中功能描述字段名为 `feature.explain`，8.0 文档已改为 `feature.description`。存量插件仍大量使用 `explain`，维护旧代码时以实际配置为准。

## 基础字段说明

### `main`

> 类型：`string`
>
> 必填：是

必须指定为相对于 `plugin.json` 的 **相对路径**，且文件类型必须为 `.html`

### `logo`

> 类型：`string`
>
> 必填：是

插件应用 Logo 文件，必须指定为相对于 `plugin.json` 的 **相对路径**

### `preload`

> 类型：`string`
>
> 必填：否

指定一个将在窗口加载前执行的预加载脚本（.js 文件）。该脚本运行在独立的预加载环境，可使用 **Node.js 原生能力** 与 **Electron 渲染进程 API**，并通过 `window` 对象向插件应用前端暴露自定义接口。详细规范见 [preload 桥接层](preload.md#ch-preload)。

## 运行行为字段说明

### `pluginSetting`

> 类型：`object`
>
> 必填：否

用于配置插件应用的默认运行行为。如无特殊需求，无需配置此字段。

### `pluginSetting.single`

> 类型：`boolean`
>
> 必填：否
>
> 默认值：`true`

用于控制插件应用是否以单例模式运行。（如无特殊需求，无需配置此字段）

### `pluginSetting.height`

> 类型：`number`
>
> 必填：否
>
> 默认值：`544`

配置插件应用初始高度，可通过 API [`utools.setExpandHeight()`](window.md#api-utools-setExpandHeight) 动态修改。（如无特殊需求，无需配置此字段）

## 功能字段说明

### `features`

> 类型：`Array<object>`
>
> 必填：是
>
> 最小长度：`1`

features 定义插件应用的功能入口。每个 feature 对应一个独立功能入口，并通过 `cmds` 配置一个或多个触发该功能的指令。一个插件应用可包含多个 feature，每个 feature 应保持独立的功能职责。

### `feature.code`

> 类型：`string`
>
> 必填：是

功能编码，且必须唯一。用户通过该 feature 的任一入口触发功能时，uTools 会将对应的 code 传递给插件应用，插件应用根据该值执行对应的功能逻辑。

### `feature.description`

> 类型：`string`
>
> 必填：否

功能描述，用于说明该功能的具体用途，便于用户理解。

### `feature.icon`

> 类型：`string`
>
> 必填：否

功能图标文件，支持 `.png`、`.jpg`、`.svg` 格式。指定为相对于 `plugin.json` 的 **相对路径**。（动态功能 API 中 icon 还支持 Base64 Data URL，见[动态功能](dynamic-features.md#ch-features)）

### `feature.platform`

> 类型：`"win32" | "darwin" | "linux"` 或其数组
>
> 必填：否

指定功能支持的平台。（如无特殊需求，无需配置此字段）

<a id="feature-mainpush"></a>
### `feature.mainPush`

> 类型：`boolean`
>
> 必填：否

配置为 `true` 后，该功能匹配用户输入时，插件应用可以持续向 uTools 搜索结果区域推送动态结果（配合 [`utools.onMainPush`](events.md#api-utools-onMainPush)）。（如无特殊需求，无需配置此字段）

### `feature.mainHide`

> 类型：`boolean`
>
> 必填：否

配置为 `true` 时，通过**非 uTools 搜索框入口**触发该功能时，不主动显示插件应用主窗口。适用于无需展示界面的功能，例如：通过全局快捷键执行「截图识别文字」、通过超级面板选中文本执行「Google 搜索」。

> 💡 通过 uTools 搜索框搜索进入插件应用时，插件应用主窗口仍会正常显示，不受该配置影响。（如无特殊需求，无需配置此字段）

### `feature.cmds`

> 类型：`Array<string|object>`
>
> 必填：是
>
> 最小长度：`1`

配置该功能支持的指令，包括「功能指令」和「匹配指令」。

## 功能指令

功能指令用于在 uTools 搜索框中通过关键词搜索并进入对应功能。

### 命名规范

- 指令名称应保持简短、明确，能够准确描述对应功能
- 长度范围：1 ~ 80 个字符，推荐控制在 20 个字符以内
- 禁止包含：控制字符或不可见字符；操作系统保留特殊字符 `\ / : * ? " < > |`；仅由 Emoji 或空白字符组成的名称

### 搜索支持

中文指令无需额外配置拼音或首字母，uTools 会自动支持拼音和首字母搜索。

### 配置约束

- 插件应用必须至少包含一个功能指令
- 同一个功能最多配置 **5** 个功能指令，超出部分将被忽略

示例：
**plugin.json**

```json
{
  "features": [
    {
      "code": "foo",
      "cmds": ["测试"]
    }
  ]
}
```

## 匹配指令

在 uTools 搜索框输入特定文本或粘贴图片、文件（或文件夹）时，匹配出可处理该内容的指令。匹配指令通过 `cmds` 数组中的对象进行配置，`type` 字段决定匹配类型：

| 类型 | 匹配内容 | 说明 |
| --- | --- | --- |
| `regex` | 正则匹配特定文本 | 通过 `match` 正则控制匹配规则，可设置字符长度范围 |
| `over` | 匹配任意文本 | 可设置排除正则与字符长度范围 |
| `img` | 匹配图像 | 匹配粘贴或拖入的图像 |
| `files` | 匹配文件或文件夹 | 可设置文件类型与扩展名 |
| `window` | 匹配当前活动系统窗口 | 通过应用名称与窗口标题匹配 |

匹配指令通过 `label` 配置指令名称，其命名规范与功能指令一致。

### `regex`

正则匹配特定文本

**plugin.json**

```jsonc
{
  "features": [
    {
      "code": "regex",
      "cmds": [
        {
          // 类型标记（必须）
          "type": "regex",
          // 指令名称（必须）
          "label": "打开网址",
          // 正则表达式字符串
          // 注意: 正则表达式中如果存在斜杠 "\"，需要写成 "\\"
          // 注意：“任意匹配的正则” 会被 uTools 忽视，例如：/.*/ 、/(.)+/、/[\s\S]*/ ...
          "match": "/^https?:\\/\\/[^\\s/$.?#]\\S+$|^[a-z0-9][-a-z0-9]{0,62}(\\.[a-z0-9][-a-z0-9]{0,62}){1,10}(:[0-9]{1,5})?$/i",
          // 最少字符数 (可选)
          "minLength": 1,
          // 最多字符数 (可选)
          "maxLength": 1000
        }
      ]
    }
  ]
}
```

### `over`

匹配任意文本

**plugin.json**

```jsonc
{
  "features": [
    {
      "code": "over",
      "cmds": [
        {
          // 类型标记（必须）
          "type": "over",
          // 指令名称（必须）
          "label": "百度一下",
          // 排除的正则表达式字符串 (任意文本中排除的部分) (可选)
          "exclude": "/\\n/",
          // 最少字符数 (可选)
          "minLength": 1,
          // 最多字符数 (默认最多为 10000) (可选)
          "maxLength": 500
        }
      ]
    }
  ]
}
```

### `img`

匹配粘贴或拖入的图像

**plugin.json**

```jsonc
{
  "features": [
    {
      "code": "img",
      "cmds": [
        {
          // 类型标记（必须）
          "type": "img",
          // 指令名称（必须）
          "label": "图像保存为文件"
        }
      ]
    }
  ]
}
```

### `files`

匹配文件或文件夹。`extensions` 与 `match` 最多配置一个；两者均未配置时匹配所有文件。

**plugin.json**

```jsonc
{
  "features": [
    {
      "code": "files",
      "cmds": [
        {
          // 类型标记（必须）
          "type": "files",
          // 指令名称（必须）
          "label": "图片批量处理",
          // 文件类型 - "file"、"directory" (可选)
          "fileType": "file",
          // 文件扩展名 (可选)
          "extensions": ["png", "jpg", "jpeg", "svg", "webp", "tiff", "avif", "heic", "bmp", "gif"],
          // 匹配文件(夹)名称的正则表达式字符串，与 extensions 最多配一个 (可选)
          // "match": "/\\.(?:jpg|jpeg|png|svg|webp|tiff|avif|heic|bmp)$/i",
          // 最少文件数 (可选)
          "minLength": 1,
          // 最多文件数 (可选)
          "maxLength": 100
        }
      ]
    }
  ]
}
```

### `window`

匹配当前活动系统窗口。通过 `match` 对象定义匹配规则，其中 `app` 为必填项，`title` 为可选项。

**plugin.json**

```jsonc
{
  "features": [
    {
      "code": "window",
      "cmds": [
        {
          // 类型标记（必须）
          "type": "window",
          // 指令名称（必须）
          "label": "窗口置顶",
          // 窗口匹配规则
          "match": {
            // app 为应用名称匹配列表，列表中的任一名称匹配成功即可。(必须)
            "app": ["xxx.app", "xxx.exe"],
            // 匹配窗口标题的正则表达式字符串 (可选)
            "title": "/xxx/"
          }
        }
      ]
    }
  ]
}
```

> 📜 官方 7.x 文档中 `match` 还支持 `class` 字段（窗口类，Windows 专有），8.0 文档未再列出；需要按窗口类匹配时以运行时实际支持为准。
>
> ⚠️ **注意**：正则表达式中如果存在斜杠 "\"，需要写成 "\\"

## AI Agent 工具（tools）

通过配置 `tools`，可以将插件应用能力以标准化工具的形式暴露给 AI Agent（如 WorkBuddy、Codex、Claude Code 等），使其在执行过程中能够自主决策并调用相应能力完成任务。整体集成方式见 [MCP 集成](tools.md#ch-tools)。

> ⚠️**重要约束**
>
> - `plugin.json.tools` 仅用于声明 Tool 信息和 Schema；实际 Tool 执行逻辑需要通过 [`utools.registerTool()`](ai.md#api-utools-registerTool) 注册
> - `plugin.json` 中声明的工具名称必须与 `registerTool()` 使用的名称一致

### `tools`

> 类型：`object`
>
> 必填：否

用于向 AI Agent 暴露可调用的工具集合，每个工具以键值对形式定义。键名即工具名称，**推荐**使用小写 `snake_case`，用于唯一标识工具，示例：`say_hi`、`video_convert`。

### 工具定义字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `description` | `string` | 是 | 工具功能说明，便于 AI Agent 理解和调用 |
| `inputSchema` | `object` | 是 | JSON Schema 定义工具输入参数结构。必须为有效对象，不能为 `null`；无参数工具配置为 `{ "type": "object", "additionalProperties": false }` |
| `outputSchema` | `object` | 否 | JSON Schema 定义工具输出结果结构。未配置时表示不声明工具输出结构 |

### `tools` 约束

- 工具名称必须唯一，建议使用小写 snake_case
- `inputSchema` 必须是有效的 JSON Schema 对象，且不能为 `null`
- `tools` 中声明的工具必须通过 `utools.registerTool()` 注册

### `tools` 配置示例

```json
"tools": {
  "say_hi": {
    "description": "向用户打个招呼",
    "inputSchema": { "type": "object", "additionalProperties": false }
  },
  "video_convert": {
    "description": "视频格式转换",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "inputPath": {
          "type": "string",
          "description": "输入视频文件绝对路径"
        },
        "format": {
          "type": "string",
          "enum": ["mp4", "mkv", "mov", "webm", "avi", "flv", "wmv"],
          "description": "目标视频格式"
        }
      },
      "required": ["inputPath", "format"]
    },
    "outputSchema": {
      "type": "object",
      "properties": {
        "outputPath": {
          "type": "string",
          "description": "输出视频文件绝对路径"
        }
      },
      "required": ["outputPath"]
    }
  }
}
```

### AI Agent 专用（无 UI 模式）

当插件应用仅给 AI Agent 使用，可采用最小配置模式：

- 无需配置：`main`、`features`（不提供界面能力）
- 必需配置：`logo`、`preload`、`tools`

## plugin.json 最小可运行配置示例

```json
{
  "main": "index.html",
  "logo": "logo.png",
  "features": [
    {
      "code": "hello",
      "cmds": ["你好"]
    }
  ]
}
```

## plugin.json 配置完整示例

```json
{
  "main": "index.html",
  "logo": "logo.png",
  "preload": "preload.js",
  "features": [
    {
      "code": "test-text",
      "description": "功能指令 —— 可搜索打开的指令示例",
      "cmds": ["功能指令"]
    },
    {
      "code": "test-regex",
      "description": "匹配指令 —— 正则匹配示例",
      "cmds": [
        {
          "type": "regex",
          "label": "打开网址",
          "match": "/^https?:\\/\\/[^\\s/$.?#]\\S+$|^[a-z0-9][-a-z0-9]{0,62}(\\.[a-z0-9][-a-z0-9]{0,62}){1,10}(:[0-9]{1,5})?$/im"
        }
      ]
    },
    {
      "code": "test-files",
      "description": "匹配指令 —— 文件或文件夹匹配示例",
      "cmds": [
        {
          "type": "files",
          "fileType": "file",
          "extensions": ["png", "jpg", "jpeg", "svg", "webp", "tiff", "avif", "heic", "bmp", "gif"],
          "label": "图片批量处理"
        }
      ]
    },
    {
      "code": "test-img",
      "description": "匹配指令 —— 图像匹配示例",
      "cmds": [
        {
          "type": "img",
          "label": "OCR 文字识别"
        }
      ]
    },
    {
      "code": "test-over",
      "description": "匹配指令 —— 任意文本匹配示例",
      "cmds": [
        {
          "type": "over",
          "label": "Google 搜索",
          "exclude": "/\\n/",
          "minLength": 1,
          "maxLength": 500
        }
      ]
    },
    {
      "code": "test-window",
      "description": "匹配指令 —— 当前活动应用窗口匹配示例",
      "cmds": [
        {
          "type": "window",
          "match": {
            "app": ["explorer.exe", "Finder.app"]
          },
          "label": "终端中打开当前窗口目录"
        }
      ]
    }
  ],
  "tools": {
    "say_hi": {
      "description": "向用户打个招呼",
      "inputSchema": { "type": "object", "additionalProperties": false }
    }
  }
}
```

## 类型提示（JSONSchema / utools-api-types）

### plugin.json JSONSchema

官方开源了 plugin.json 的 JSONSchema 文件（随 [utools-api-types](https://github.com/uTools-Labs/utools-api-types) 一同发布，关于 JSONSchema 本身可参考 [json-schema.org](https://json-schema.org/)）。在 `plugin.json` 中加入 `$schema` 字段即可获得配置提示。

远程加载（网络可直连 GitHub 时）：

```json
{
  "$schema": "https://raw.githubusercontent.com/uTools-Labs/utools-api-types/refs/heads/main/resource/utools.schema.json"
}
```

本地加载（将 `utools.schema.json` 下载到项目内，路径相对于 `plugin.json`）：

```json
{
  "$schema": "../resource/utools.schema.json"
}
```

项目已安装 `utools-api-types` 时可直接引用包内文件：

```json
{
  "$schema": "../node_modules/utools-api-types/resource/utools.schema.json"
}
```

### uTools API 类型定义（utools-api-types）

[utools-api-types](https://github.com/uTools-Labs/utools-api-types) 是 uTools 官方维护的 TypeScript 类型定义库，提供当前 utools API 的完整类型定义，并会随着 uTools API 的版本迭代持续更新。无论使用 JavaScript 还是 TypeScript 开发插件应用，都可以借助它获得 utools API 的代码提示和类型检查。它基于全局变量 `utools` 进行类型声明，安装并配置后无需手动引入，编辑器即可自动识别。

安装：

```shell
npm install utools-api-types --save-dev
```

**JavaScript 项目**——在项目根目录创建 `jsconfig.json`，并在 `compilerOptions.types` 中引入：

```jsonc
{
  "compilerOptions": {
    "types": ["utools-api-types"]
  },
  "include": [
    // 需要类型提示和类型检查的文件范围，请根据项目实际目录结构调整
    "src/**/*.js",
    "bridge/**/*.js"
  ]
}
```

**TypeScript 项目**——在 `tsconfig.json` 的 `compilerOptions.types` 中添加：

```jsonc
{
  "compilerOptions": {
    "types": ["utools-api-types"]
  },
  "include": [
    // 需要类型提示和类型检查的文件范围，请根据项目实际目录结构调整
    "src/**/*.ts",
    "bridge/**/*.js"
  ]
}
```

> 💡 如果项目已经通过其他方式配置了 `types`，请将 `utools-api-types` 追加到现有数组中，避免覆盖原有类型定义。配置完成后，在 `include` 范围内的文件中输入 `window.utools.`，编辑器即可提示可用的 API，并提供参数提示、返回值提示和类型检查。如发现类型缺失或过期，升级到最新版本：`npm install utools-api-types@latest --save-dev`。
