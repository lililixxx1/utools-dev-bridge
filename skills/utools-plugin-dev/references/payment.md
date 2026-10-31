<a id="ch-payment"></a>
# 支付

> 模块：支付（2 API）· [← 总索引（含全局约束）](api-index.md)

uTools 支持插件应用向用户提供付费功能。开发者需要开通支付权限后，才能使用相关支付 API。

> 💡 插件应用可以根据业务需求选择以下付费模式：
> - **基础功能免费，高级功能付费**：用户可以免费使用基础功能，购买后解锁高级功能。推荐使用此模式
> - **完全付费**：用户购买授权后，才能使用插件应用的功能
>
> 用户购买商品后，将获得对应的授权，授权在有效期内可以使用对应的付费功能。如果商品配置为永久授权，则用户购买后可以永久使用对应功能。推荐使用永久授权。
>
> 支付权限申请条件与结算规则见官方 [支付 FAQ](https://www.u-tools.cn/docs/faq/payment.html)。

<a id="api-utools-isPurchasedUser"></a>
## `utools.isPurchasedUser()`

获取当前用户的购买授权状态。

```ts
function isPurchasedUser(): boolean | string
```

**返回**：

- `false`：用户未购买，或当前授权已失效
- `true`：用户拥有永久授权
- `string`：用户拥有有效期授权，返回授权到期时间，格式为 `yyyy-MM-dd HH:mm:ss`

该 API 返回的是当前用户的授权状态，插件应用可以据此判断用户是否可以使用需要付费授权的功能。

```js
const purchasedUser = utools.isPurchasedUser();

if (purchasedUser) {
  // 已获得有效授权，可使用付费功能

  if (purchasedUser === true) {
    // 永久授权
  } else {
    // 有效期授权
    console.log(`授权到期时间：${purchasedUser}`);
  }
} else {
  // 未获得有效授权，打开插件应用的购买弹窗
  utools.openPurchase({
    goodsId: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  }, () => {
    console.log("购买成功");
  });
}
```

<a id="api-utools-openPurchase"></a>
## `utools.openPurchase(options, callback)`

打开插件应用的购买弹窗。

```ts
function openPurchase(
  options: OpenPurchaseOptions,
  callback?: () => void
): void
```

- `options` 购买参数
- `callback` 购买成功后的回调函数

**`OpenPurchaseOptions` 类型定义**

```ts
interface OpenPurchaseOptions {
  /** 商品 ID，在「uTools 开发者工具」中创建 */
  goodsId: string;
  /** 第三方服务生成的订单号，长度为 6～64 个字符 */
  outOrderId?: string;
  /** 第三方服务附加数据。在订单查询 API 和支付通知中原样返回，可用于传递自定义参数。最多 256 个字符 */
  attach?: string;
}
```

```js
utools.openPurchase({
  goodsId: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}, () => {
  const purchasedUser = utools.isPurchasedUser();

  if (purchasedUser) {
    console.log("用户已获得有效授权");
  }
});
```

---

## 历史 API（官方 8.0 文档已移除）

> 📜 以下 API 在 uTools 7.x 文档中存在（「服务付费模式」按次/按量购买），官方 8.0 文档已移除。存量插件可能仍在使用，维护旧代码时可参考；新代码不建议依赖。

<a id="api-utools-openPayment"></a>
### `utools.openPayment(options, callback)`（已移除）

打开支付（适用服务付费模式：用户按使用量购买应用服务，购买后可在固定的次数或者数量下使用应用服务，如服务 API 按次/按量购买、售卖虚拟商品）。

```ts
function openPayment(options: OpenPaymentOptions, callback?: () => void): void
```

`OpenPaymentOptions` 字段与 [`OpenPurchaseOptions`](#api-utools-openPurchase) 相同（`goodsId` + 可选 `outOrderId`/`attach`）。8.0 起统一使用 `openPurchase`。

<a id="api-utools-fetchUserPayments"></a>
### `utools.fetchUserPayments()`（已移除）

获取用户支付记录。

```ts
function fetchUserPayments(): Promise<Payment[]>
```

```ts
interface Payment {
  order_id: string;      // uTools 订单 ID
  out_order_id: string;  // 外部或第三方服务生成的订单号
  open_id: string;       // uTools 用户 ID
  pay_fee: number;       // 支付金额，单位为分
  body: string;          // 商品描述
  attach: string;        // 附加数据
  goods_id: string;      // 商品 ID
  paid_at: string;       // 支付时间
  created_at: string;    // 订单生成时间
}
```
