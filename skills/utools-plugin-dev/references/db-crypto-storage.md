<a id="ch-dbcryptostorage"></a>
# dbCryptoStorage

> 模块：dbCryptoStorage（3 API）· [← 总索引（含全局约束）](api-index.md)

dbCryptoStorage 是基于 [本地数据库](db.md#local-db) 基础上，封装的一套类似 [LocalStorage](https://developer.mozilla.org/zh-CN/docs/Web/API/Window/localStorage) 的 API，通过键值对形式加密存储数据。

> 📜 **官方文档状态**：uTools 8.0 官方文档站已移除 `dbCryptoStorage` 相关说明（未说明是否下线运行时能力）。存量插件仍大量使用，本章保留 7.x 文档内容供维护参考；新代码的数据存储选型见[数据存储](storage.md#ch-storage)。

<a id="api-utools-dbCryptoStorage-setItem"></a>
## `utools.dbCryptoStorage.setItem(key, value)`

存储一个键值对数据，若键已存在，则覆盖它的值。

```ts
function setItem(key: string, value: any): void;
```

- `key` 键值
- `value` 要加密存储的值

```js
utools.dbCryptoStorage.setItem("key", "value will encrypt");
```

<a id="api-utools-dbCryptoStorage-getItem"></a>
## `utools.dbCryptoStorage.getItem(key)`

获取一个键值对数据。

```ts
function getItem(key: string): any;
```

- `key` 键值

```js
const value = utools.dbCryptoStorage.getItem("key");
console.log(value);
```

<a id="api-utools-dbCryptoStorage-removeItem"></a>
## `utools.dbCryptoStorage.removeItem(key)`

删除一个键值对数据。

```ts
function removeItem(key: string): void;
```

- `key` 键值

```js
utools.dbCryptoStorage.removeItem("key");
```
