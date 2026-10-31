<a id="ch-sharp"></a>
# Sharp 图片处理

> 模块：Sharp（1 API）· [← 总索引（含全局约束）](api-index.md)

[Sharp](https://sharp.pixelplumbing.com/) 是一个高性能的 Node.js 图像处理库。uTools 已内置 Sharp **v0.35.3**（7.x 时代为 v0.34.5），插件应用无需额外安装即可通过 `utools.sharp()` 创建 Sharp 实例，进行图片处理、格式转换、图片合成等操作。

<a id="api-utools-sharp"></a>
## `utools.sharp([input], [options])`

创建 Sharp 实例。

```ts
function sharp(
  input?: Buffer | Uint8Array | Uint8ClampedArray | ArrayBuffer | string | Object | Array,
  options?: SharpOptions
): Sharp;
```

- `input`（可选）：输入图片数据，类型 `Buffer | Uint8Array | Uint8ClampedArray | ArrayBuffer | string | ReadableStream | Object | Array`，支持多种方式：
  - `Buffer`：Node.js Buffer，包含图片二进制数据
  - `Uint8Array` / `ArrayBuffer`：二进制图片数据
  - `string`：图片文件路径或 URL
  - `Object`：
    - `text`：生成文本图片 `{ text: string; width?: number; height?: number; channels?: number; rgba?: boolean }`
    - `raw`：原始像素数据 `{ width: number; height: number; channels: number }`
  - `Array`：输入源集合，可用于生成多帧动画
- `options`（可选）：配置 Sharp 实例行为，常用字段：
  - `raw`：`{ width: number, height: number, channels: number }`，处理原始像素数据时使用
  - `create`：`{ width: number, height: number, channels: number, background?: string | Object }`，生成新图像
  - `limitInputPixels`：`number`，限制输入像素总量
  - `failOn`：`'error' | 'warning' | 'none'`，遇到无效像素数据时的处理策略
  - `animated`：`boolean`，处理多帧输入（GIF/WebP 动画）
  - `density`：`number`，处理 PDF 或 SVG 时的像素密度
  - `background`：`string | { r:number, g:number, b:number, alpha:number }`，图像操作时的背景色

  完整 `SharpOptions` 可参考 Sharp 官方文档。
- 返回值：`Sharp` 实例，可调用链式方法进行图像处理，如：

```js
const image = utools.sharp("input.png").resize(200, 200).rotate(90).toBuffer();
```

**常用链式方法**

- `.resize(width, height)`：调整图像尺寸
- `.rotate(angle)`：旋转图像
- `.flip()`：垂直翻转图像
- `.flop()`：水平翻转图像
- `.grayscale()`：灰度化图像
- `.negate()`：反相处理图像颜色
- `.blur(sigma?)`：高斯模糊，可选 sigma 值
- `.sharpen(sigma?, flat?, jagged?)`：锐化图像
- `.threshold(threshold?)`：二值化图像
- `.normalize()`：自动调整图像对比度
- `.gamma(gamma)`：应用 gamma 校正
- `.median(size?)`：中值滤波降噪
- `.tint(color)`：给图像添加颜色滤镜
- `.flatten([background])`：去除 alpha 通道，添加背景色
- `.extend({ top, bottom, left, right, background })`：扩展画布边界
- `.trim(tolerance?)`：裁剪图片边缘的相同颜色区域
- `.extract({ left, top, width, height })`：裁剪指定区域
- `.composite([{ input, top, left, blend }])`：图像合成
- `.jpeg(options)` / `.png(options)` / `.webp(options)` / `.tiff(options)`：转换图像格式
- `.toBuffer()`：获取处理后的图片二进制数据
- `.toFile(path)`：将处理后的图片保存到文件
- `.metadata()`：获取图像元信息（宽高、格式、通道等）
- `.clone()`：复制 Sharp 实例，继续独立链式操作

**示例代码**

修改 JPG 尺寸：

```js
await utools.sharp("/path/to/input.jpg").resize(300, 200).toFile("/path/to/output.jpg");
```

创建空的 PNG 图像：

```js
await utools
  .sharp({
    create: {
      width: 300,
      height: 200,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 0.5 },
    },
  })
  .png()
  .toBuffer();
```

将 GIF 动画转为 webp 格式：

```js
await utools.sharp("/path/to/in.gif", { animated: true }).toFile("/path/to/out.webp");
```

读取像素的原始数组并将其保存为 PNG 格式：

```js
const input = Uint8Array.from([255, 255, 255, 0, 0, 0]); // or Uint8ClampedArray
const image = utools.sharp(input, {
  raw: {
    width: 2,
    height: 1,
    channels: 3,
  },
});
await image.toFile("/path/to/my-two-pixels.png");
```

生成 RGB 高斯噪声：

```js
await utools
  .sharp({
    create: {
      width: 300,
      height: 200,
      channels: 3,
      noise: { type: "gaussian", mean: 128, sigma: 30 },
    },
  })
  .toFile("/path/to/noise.png");
```

根据文本生成图像：

```js
await utools
  .sharp({
    text: {
      text: "Hello, world!",
      width: 400, // max width
      height: 300, // max height
    },
  })
  .toFile("/path/to/text_bw.png");
```

生成 GIF 动画：

```js
const images = ["😀", "😛"].map((text) => ({
  text: { text, width: 64, height: 64, channels: 4, rgba: true },
}));
await utools.sharp(images, { join: { animated: true } }).toFile("/path/to/out.gif");
```

根据图片 metadata 处理：

```js
const image = utools.sharp("/path/to/input.jpg");
image
  .metadata()
  .then(function (metadata) {
    return image.resize(Math.round(metadata.width / 2)).webp().toBuffer();
  })
  .then(function (data) {
    // data contains a WebP image half the width and height of the original JPEG
  });
```

**Sharp 官方文档参考**

- [Constructor](https://sharp.pixelplumbing.com/api-constructor/)
- [Input metadata](https://sharp.pixelplumbing.com/api-input/)
- [Output options](https://sharp.pixelplumbing.com/api-output/)
- [Resizing images](https://sharp.pixelplumbing.com/api-resize/)
- [Compositing images](https://sharp.pixelplumbing.com/api-composite/)
- [Image operations](https://sharp.pixelplumbing.com/api-operation/)
- [Colour manipulation](https://sharp.pixelplumbing.com/api-colour/)
- [Channel manipulation](https://sharp.pixelplumbing.com/api-channel/)
- [Global properties](https://sharp.pixelplumbing.com/api-utility/)
