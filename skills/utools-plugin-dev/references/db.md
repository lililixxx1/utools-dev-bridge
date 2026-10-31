<a id="ch-db"></a><a id="local-db"></a>
# 本地数据库

> 模块：db（9 API）· [← 总索引（含全局约束）](api-index.md)

uTools 提供了本地数据库的 API，基于 nosql 的设计，通过它可以实现一些简单的数据存储和读取。
它可以很方便的使用，数据存储在本地计算机系统，如果用户开启数据同步，可**备份**到 uTools 服务端同时可在用户的多个设备间实现**秒级同步**。
uTools 的插件应用是一个轻型的应用程序，在没有远端服务器提供数据存储，提供本地数据持久化存储至关重要。

除文档型数据库 API 外，还提供 [dbStorage](db-storage.md#ch-dbstorage) 键值存储 API，用于存储简单的配置数据。关于插件应用的数据存储方案选型（同步数据库 / 本地数据目录 / 临时目录 / 用户文件），见[数据存储](storage.md#ch-storage)。

> ⚠️ **警告**：
> 在多个设备编辑同一个数据库文档时，将产生冲突，数据库会统一选择一个版本作为最终版本，为了尽可能避免冲突，应该将内容合理的分散在多个文档，而不是都存放在一个数据库文档中。

<a id="api-utools-db-put"></a>
## `utools.db.put(doc)` / `utools.db.promises.put(doc)`

创建或更新数据库文档，文档内容不超过 **1M**

**同步版本**

```ts
function put(doc: DbDoc): DbResult;
```

**异步版本**

```ts
function put(doc: DbDoc): Promise<DbResult>;
```

- `doc` 文档对象

<a id="def-dbdoc"></a>
**`DbDoc` 类型定义**

```ts
interface DbDoc {
  _id: string;
  _rev?: string;
  [key:string]: unknown
}
```

**字段说明：**

- `_id`
  - 文档 ID，如果 `_id` 不存在，则创建一个新文档，如果 `_id` 已经存在，则更新文档。
- `_rev`
  - 文档版本，对文档更新时，`_rev` 不可省略，否则将更新失败。

<a id="def-dbresult"></a>
**`DbResult` 类型定义**

```ts
interface DbResult {
  id: string,
  rev?: string,
  ok?: boolean,
  error?: boolean,
  name?: string,
  message?: string
}
```

**字段说明：**

- `id`
  - 文档 ID，即文档字段 `_id`。
- `rev`
  - 最新文档版本
- `ok`
  - 是否成功
- `error`
  - 是否错误
- `name`
  - 错误名称
- `message`
  - 错误原因

**同步版本**

```ts
// 新建文档
const doc = {
  _id: "test/doc-1",
  a: "value 1",
  b: "value 2"
}
let result = utools.db.put(doc);
if (result.ok) {
  // 保存成功, 更新文档版本
  doc._rev = result.rev;
} else if (result.error) {
  // 保存出错，打印错误原因
  console.log(result.message);
}

// 修改文档
doc.a = "updated value 1";
doc.b = "updated value 2";
result = utools.db.put(doc);
if (result.ok) {
  // 保存成功, 更新文档版本
  doc._rev = result.rev;
} else if (result.error) {
  // 保存出错，打印错误原因
  console.log(result.message);
}
```

**异步版本**

```ts
// 新建文档
const doc = {
  _id: "test/doc-1",
  a: "value 1",
  b: "value 2"
}
let result = await utools.db.promises.put(doc);
if (result.ok) {
  // 保存成功, 更新文档版本
  doc._rev = result.rev;
} else if (result.error) {
  // 保存出错，打印错误原因
  console.log(result.message);
}

// 修改文档
doc.a = "updated value 1";
doc.b = "updated value 2";
result = await utools.db.promises.put(doc);
if (result.ok) {
  // 保存成功, 更新文档版本
  doc._rev = result.rev;
} else if (result.error) {
  // 保存出错，打印错误原因
  console.log(result.message);
}
```

<a id="api-utools-db-get"></a>
## `utools.db.get(id)` / `utools.db.promises.get(id)`

根据文档 ID `id` 获取文档，不存在则返回 null

**同步版本**

```ts
function get(id: string): DbDoc | null;
```

**异步版本**

```ts
function get(id: string): Promise<DbDoc | null>;
```

- `id` 文档 ID
- DbDoc 参考 [`DbDoc` 类型定义](#def-dbdoc)

**同步版本**

```ts
// 获取文档
const doc = utools.db.get("test/doc-1");
console.log(doc);
if (doc) {
  // 修改文档
  doc.c = 123;
  const result = utools.db.put(doc);
  if (result.ok) {
    // 保存成功, 更新文档版本
    doc._rev = result.rev;
  } else if (result.error) {
    // 保存出错，打印错误原因
    console.log(result.message);
  }
}
```

**异步版本**

```ts
// 获取文档
const doc = await utools.db.promises.get("test/doc-1");
console.log(doc);
if (doc) {
  // 修改文档
  doc.c = 123;
  const result = await utools.db.promises.put(doc);
  if (result.ok) {
    // 保存成功, 更新文档版本
    doc._rev = result.rev;
  } else if (result.error) {
    // 保存出错，打印错误原因
    console.log(result.message);
  }
}
```

<a id="api-utools-db-remove"></a>
## `utools.db.remove(doc)` / `utools.db.promises.remove(doc)`

删除数据库文档，可以通过文档对象或者文档 `id` 删除

**同步版本**

```ts
function remove(doc: DbDoc): DbResult;
function remove(id: string): DbResult;
```

**异步版本**

```ts
function remove(doc: DbDoc): Promise<DbResult>;
function remove(id: string): Promise<DbResult>;
```

- `doc` 文档对象
- `id` 文档 ID
- DBResult 参考 [`DbResult` 类型定义](#def-dbresult)

**同步版本**

```ts
// 删除文档
const doc = utools.db.get("test/doc-1");
if (doc) {
  const result = utools.db.remove(doc);
  if (result.ok) {
    console.log("删除成功");
  } else if (result.error) {
    // 删除失败，打印错误原因
    console.log(result.message);
  }
}

// 根据文档 ID 删除文档
const result = utools.db.remove("test/doc-1");
if (result.ok) {
  console.log("删除成功");
} else if (result.error) {
  // 删除失败，打印错误原因
  console.log(result.message);
}
```

**异步版本**

```ts
// 删除文档
const doc = await utools.db.promises.get("test/doc-1");
if (doc) {
  const result = await utools.db.promises.remove(doc);
  if (result.ok) {
    console.log("删除成功");
  } else if (result.error) {
    // 删除失败，打印错误原因
    console.log(result.message);
  }
}

// 根据文档 ID 删除文档
const result = await utools.db.promises.remove("test/doc-1");
if (result.ok) {
  console.log("删除成功");
} else if (result.error) {
  // 删除失败，打印错误原因
  console.log(result.message);
}
```

<a id="api-utools-db-bulkDocs"></a>
## `utools.db.bulkDocs(docs)` / `utools.db.promises.bulkDocs(docs)`

批量创建或更新数据库文档

**同步版本**

```ts
function bulkDocs(docs: DbDoc[]): DbResult[];
```

**异步版本**

```ts
function bulkDocs(docs: DbDoc[]): Promise<DbResult[]>;
```

- `docs` 文档对象数据
- DbDoc 参考 [`DbDoc` 类型定义](#def-dbdoc)
- DbResult 参考 [`DbResult` 类型定义](#def-dbresult)

**同步版本**

```ts
// 批量创建文档
const docs = [
  { _id: "test/doc-2", a: "a 2222222", b: "b 2222222" },
  { _id: "test/doc-3", a: "a 3333333", b: "b 3333333" }
];
const results = utools.db.bulkDocs(docs);
results.forEach(ret => {
  // 更新文档版本
  if (ret.ok) {
    docs.find(x => x._id === ret.id)?._rev = ret.rev;
  }
})
```

**异步版本**

```ts
// 批量创建文档
const docs = [
  { _id: "test/doc-2", a: "a 2222222", b: "b 2222222" },
  { _id: "test/doc-3", a: "a 3333333", b: "b 3333333" }
];
const results = await utools.db.promises.bulkDocs(docs);
results.forEach(ret => {
  // 更新文档版本
  if (ret.ok) {
    docs.find(x => x._id === ret.id)?._rev = ret.rev;
  }
})
```

<a id="api-utools-db-allDocs"></a>
## `utools.db.allDocs([filter])` / `utools.db.promises.allDocs([filter])`

获取插件应用数据库文档。支持：不传参数获取全部文档；传入字符串根据文档 ID 前缀过滤；传入数组根据指定 ID 获取文档。

**同步版本**

```ts
function allDocs(idStartsWith?: string): DbDoc[];
function allDocs(ids: string[]): DbDoc[];
```

**异步版本**

```ts
function allDocs(idStartsWith?: string): Promise<DbDoc[]>;
function allDocs(ids: string[]): Promise<DbDoc[]>;
```

- `idStartsWith` 文档 ID 前缀
- `ids` 文档 ID 数组
- `DbDoc` 参考 [`DbDoc` 类型定义](#def-dbdoc)

**同步版本**

```ts
// 获取所有 id 以 "test/" 作为前缀的文档
const docs1 = utools.db.allDocs("test/");
// 根据 id 数组获取对应文档数组
const docs2 = utools.db.allDocs(["test/doc-2", "test/doc-3"]);
// 获取插件应用所有文档
const docs3 = utools.db.allDocs();
console.log(docs1, docs2, docs3)
```

**异步版本**

```ts
// 获取所有 id 以 "test/" 作为前缀的文档
const docs1 = await utools.db.promises.allDocs("test/");
// 根据 id 数组获取对应文档数组
const docs2 = await utools.db.promises.allDocs(["test/doc-2", "test/doc-3"]);
// 获取插件应用所有文档
const docs3 = await utools.db.promises.allDocs();
console.log(docs1, docs2, docs3)
```

<a id="api-utools-db-postAttachment"></a>
## `utools.db.postAttachment(id, attachment, type)` / `utools.db.promises.postAttachment(id, attachment, type)`

存储附件到新文档，附件只能被创建不能被更新，创建的附件最大不超过 10M

**同步版本**

```ts
function postAttachment(id: string, attachment: Buffer | Uint8Array, type: string): DbResult;
```

**异步版本**

```ts
function postAttachment(id: string, attachment: Buffer | Uint8Array, type: string): Promise<DbResult>;
```

- `id` 文档 ID
- `attachment` 附件二进制数据，支持 `Buffer` 或 `Uint8Array`
- `type` 为附件类型，参考 [mime/type](https://developer.mozilla.org/zh-CN/docs/Web/HTTP/Basics_of_HTTP/MIME_types)，比如 `image/png`、`text/plain` 。
- `DbResult` 参考 [`DbResult` 类型定义](#def-dbresult)

**同步版本**

```ts
const fileBuffer = fs.readFileSync("/path/to/test.png");
const result = utools.db.postAttachment("test-image-file", fileBuffer, "image/png");
if (result.ok) {
  console.log("附件存储成功");
} else if (result.error) {
  // 存储失败，打印错误原因
  console.log(result.message);
}
```

**异步版本**

```ts
const fileBuffer = await fs.promises.readFile("/path/to/test.png");
const result = await utools.db.promises.postAttachment("test-image-file", fileBuffer, "image/png");
if (result.ok) {
  console.log("附件存储成功");
} else if (result.error) {
  // 存储失败，打印错误原因
  console.log(result.message);
}
```

<a id="api-utools-db-getAttachment"></a>
## `utools.db.getAttachment(id)` / `utools.db.promises.getAttachment(id)`

获取附件，不存在返回 null

**同步版本**

```ts
function getAttachment(id: string): Uint8Array;
```

**异步版本**

```ts
function getAttachment(id: string): Promise<Uint8Array>;
```

- `id` 附件文档 ID

**同步版本**

```ts
const buf = utools.db.getAttachment("test-image-file");
if (buf) {
  fs.writeFileSync(utools.getPath('downloads') + "/test.png", buf);
}
```

**异步版本**

```ts
const buf = await utools.db.promises.getAttachment("test-image-file");
if (buf) {
  await fs.promises.writeFile(utools.getPath('downloads') + "/test.png", buf);
}
```

<a id="api-utools-db-getAttachmentType"></a>
## `utools.db.getAttachmentType(id)` / `utools.db.promises.getAttachmentType(id)`

获取附件类型

**同步版本**

```ts
function getAttachmentType(id: string): string;
```

**异步版本**

```ts
function getAttachmentType(id: string): Promise<string>;
```

- `id` 附件文档 ID

**同步版本**

```ts
const type = utools.db.getAttachmentType("test-image-file");
console.log("附件类型为", type);
```

**异步版本**

```ts
const type = await utools.db.promises.getAttachmentType("test-image-file");
console.log("附件类型为", type);
```

<a id="db-sync"></a>
<a id="api-utools-db-replicateStateFromCloud"></a>
## `utools.db.replicateStateFromCloud()` / `utools.db.promises.replicateStateFromCloud()`
云端同步数据到本地的状态，该 API 是解决在某些环境下需要判断数据是否从云端复制完成。

**同步版本**

```ts
function replicateStateFromCloud(): State;
```

**异步版本**

```ts
function replicateStateFromCloud(): Promise<State>;
```

**`State` 类型定义**

```ts
type State = null | 0 | 1;
```

- `null`: 未开启数据同步
- `0`: 已完成同步
- `1`: 同步中

**同步版本**

```ts
const state = utools.db.replicateStateFromCloud();
if (state === 1) {
  console.log("数据从云端拉取同步中...");
} else {
  console.log("数据已从云端同步完成");
}
```

**异步版本**

```ts
const state = await utools.db.promises.replicateStateFromCloud();
if (state === 1) {
  console.log("数据从云端拉取同步中...");
} else {
  console.log("数据已从云端同步完成");
}
```
