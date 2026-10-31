<a id="ch-ai"></a>
# AI 能力

> 模块：AI 能力（3 API）· [← 总索引（含全局约束）](api-index.md)

uTools 为插件应用提供 AI 能力集成，包括：调用 AI 大模型完成智能对话、注册插件应用工具让 AI 通过 Function Calling 自动调用、通过 MCP 服务向第三方 AI Agent 暴露插件应用能力（见 [MCP 集成](tools.md#ch-tools)）。

> 💡 uTools AI 默认提供多个大模型，插件应用可通过 `utools.ai()` 直接调用，无需用户额外配置。默认的大模型通常启用思考模式，推理过程会增加响应时间——常规对话、文本处理等任务建议优先使用非思考模式（`reasoning_effort: "none"`）以获得更快响应；复杂推理任务可使用思考模式。建议在插件应用界面中提供模型选择和思考模式切换选项。

<a id="api-utools-registerTool"></a>
## `utools.registerTool(name, handler)`

注册插件应用工具。注册后的工具可以被以下 AI 场景使用：

- `utools.ai()` 调用时，AI 可以根据工具描述自动触发 Function Calling
- 用户开启 MCP 服务后，可作为 MCP Tool 提供给第三方 AI Agent

```ts
function registerTool(
  name: string,
  handler: (
    params: Record<string, any>,
    ctx?: ToolContext
  ) => any | Promise<any>
): void;
```

- `name` 工具名称
  - 如果需要通过 MCP 暴露给第三方 AI Agent，需要同时在 plugin.json 的 `tools` 中声明（见 [plugin.json 配置](plugin-json.md#ch-plugin-json)）
  - 推荐使用小写 snake_case，示例：`say_hi`、`get_system_info`、`video_convert`
- `handler` 调用工具时执行的函数
  - `params` 调用时传入的参数对象
  - `ctx` 工具执行上下文，仅通过 MCP 调用时提供

**`ToolContext` 类型定义**

```ts
interface ToolContext {
  /** MCP 请求 ID */
  requestId: string | number;
  /** 用于向 AI Agent 上报任务执行进度（适用于长时间任务） */
  sendProgress?: (options: {
    /** 当前进度值 */
    progress: number;
    /** 总数（可选） */
    total?: number;
    /** 进度消息（可选） */
    message?: string;
  }) => Promise<void>;
}
```

> ⚠️ 工具执行过程中抛出的异常会作为工具调用失败结果返回给 AI。建议返回清晰的错误信息，帮助 AI 继续处理。

```js
// 简单工具
utools.registerTool('say_hi', async ({ name }) => {
  return `Hello ${name}`
})

// 带进度上报的长任务
utools.registerTool('video_convert', async ({ inputPath, format }, ctx) => {
  const outputPath = `${window.utools.getPath('downloads')}/${Date.now()}.${format}`
  const args =
    format === 'webm'
      ? ['-i', inputPath, '-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', outputPath]
      : ['-i', inputPath, outputPath]
  await window.utools.runFFmpeg(args, (progress) => {
    if (!ctx?.sendProgress || progress.percent === undefined) return
    ctx.sendProgress({
      progress: progress.percent,
      total: 100,
      message: `视频处理中 ${progress.percent.toFixed(1)}%`
    })
  })
  return { outputPath }
})
```

<a id="api-utools-ai"></a>
## `utools.ai(options[, streamCallback])`

调用 AI 大模型，并支持 Function Calling 工具调用。

**流式调用**

```ts
function ai(
  options: AiOptions,
  streamCallback: (chunk: Message) => void
): AiPromise<void>;
```

**非流式调用**

```ts
function ai(options: AiOptions): AiPromise<Message>;
```

- `options`: Ai 选项
- `streamCallback`: 流式调用函数 (可选)
- 返回定制的 `AiPromise`

**`AiOptions` 类型定义**

```ts
interface AiOptions {
  /**
   * AI 模型 ID，未配置时使用默认模型（一般无需配置）
   */
  model?: string;
  /** 消息列表 */
  messages: Message[];
  /** 可供 AI 调用的工具列表 */
  tools?: Tool[];
  /**
   * 思考强度（一般无需配置）
   * "none" 表示关闭思考模式；其他值表示不同程度的思考强度。
   * 此参数及其支持的取值因 AI 模型而异。
   */
  reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}
```

**`Message` 类型定义**

```ts
interface Message {
  /**
   * 消息角色："system" 系统消息 / "user" 用户消息 / "assistant" AI 消息
   */
  role: "system" | "user" | "assistant";
  /** 消息内容 */
  content?: string;
  /** AI 推理内容，部分支持推理能力的模型会返回该字段 */
  reasoning_content?: string;
}
```

**`Tool` 类型定义**

```ts
interface Tool {
  type: "function";
  function: {
    /** 工具名称 */
    name: string;
    /** 工具描述 */
    description: string;
    /** 工具参数 */
    parameters: JSONSchema;
  };
}

interface JSONSchema {
  type?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  description?: string;
}
```

**`AiPromise` 类型定义**

`AiPromise` 可以作为普通 Promise 使用，并额外提供 `abort()` 方法，用于中止正在进行的 AI 调用。

```ts
interface AiPromise<T> extends Promise<T> {
  /** 中止 AI 调用 */
  abort(): void;
}
```

---

#### AI 对话

**流式调用**

```js
const text = `...`
const messages = [
  {
    role: "system",
    content: "总结用户提供的文本",
  },
  {
    role: "user",
    content: text,
  },
];

await utools.ai({ messages }, (chunk) => {
  console.log(chunk);
});
```

**非流式调用**

```js
const text = `...`
const messages = [
  {
    role: "system",
    content: "你是一个英文翻译专家，将用户的任何内容都翻译成英文，翻译结果要符合英文语言习惯",
  },
  {
    role: "user",
    content: text,
  },
];

const result = await utools.ai({ messages });
console.log(result.content);
```

---

#### Function Calling 调用

> 💡 `tools` 描述工具能力，`registerTool` 提供工具实现，两者通过 `name` 关联。

**App.jsx**

```js
const messages = [
  {
    role: "user",
    content: "我电脑的 CPU 是什么，内存多大",
  },
];
const tools = [
  {
    type: "function",
    function: {
      name: "get_system_info",
      description: "获取用户的电脑信息",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
];

// 流式调用
await utools.ai({ messages, tools }, (chunk) => {
  console.log(chunk);
});
// 非流式调用
const result = await utools.ai({ messages, tools });
console.log(result.content);
```

**preload.js**

```js
window.utools.registerTool('get_system_info', () => {
  const os = require("node:os");
  return {
    platform: os.platform(),
    cpuCount: os.cpus().length,
    totalMemory: os.totalmem()
  };
})
```

<a id="api-utools-allAiModels"></a>
## `utools.allAiModels()`

获取所有可用 AI 模型列表

```ts
function allAiModels(): Promise<AiModel[]>;
```

**`AiModel` 类型定义**

```ts
interface AiModel {
  /** AI 模型 ID */
  id: string;
  /** 模型显示名称 */
  label: string;
  /** 模型图标（URL 或 Data URL） */
  icon: string;
  /** 单次调用消耗的 AI 能量 */
  cost?: number;
  /** 是否支持视觉能力（图片输入） */
  vision?: boolean;
}
```

```js
const models = await utools.allAiModels();
const visionModel = models.find(model => model.vision);
if (visionModel) {
  const messages = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "分析图片"
        },
        {
          type: "image_url",
          image_url: {
            url: "data:image/png;base64,..."
          }
        }
      ]
    }
  ];
  const result = await utools.ai({
    model: visionModel.id,
    messages
  });
  console.log(result.content);
}
```
