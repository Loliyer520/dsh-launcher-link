# 启动器与 DSH 连接协议 v1

DSH 是 WebSocket 客户端；启动器是服务端。手机通信由启动器另行实现。服务端可在升级之前校验来源、路径、token，在注册时校验 token 对应的实例 ID。

## 握手和注册

- 子协议：`dsh.launcher.v1`，双方必须选择此子协议。
- HTTP 头：`Authorization: Bearer <token>`。认证失败返回 HTTP 401/403。
- 地址示例：`ws://127.0.0.1:3090/dsh-link/v1`；远程使用 TLS `wss://`。
- 每帧为一个 UTF-8 JSON 对象，必须有 `v: 1` 与 `type`。只接受文本帧。
- 注册完成之前不下发业务请求。双方握手超时默认 10 秒。

连接成功后 DSH 发送：

```json
{"v":1,"type":"hello","connectionId":"random-uuid","instance":{"instanceId":"dsh-work-01","label":"工作","profile":"work","pid":1234,"pluginVersion":"0.2.0","protocol":"dsh.launcher.v1","methods":["instance.info","system.ping"],"state":"handshaking"},"capabilities":{"requests":true,"events":true,"replay":false}}
```

`instanceId` 由启动器持久保存，标识 DSH 实例；`connectionId` 每次重连生成，标识当前连接。`pid` 只用于展示。服务端接受注册并将 socket 加入实例表，然后回复：

```json
{"v":1,"type":"welcome","instanceId":"dsh-work-01","connectionId":"random-uuid"}
```

插件检查两个 ID，之后进入 `ready`。启动器可发 `{"v":1,"type":"reject"}` 拒绝注册。重复 `instanceId` 应拒绝新连接并用关闭码 `4009`，不能让一个实例覆盖另一个。断线后只删除仍指向该 socket 的实例表项。

## 心跳

双方均可发 `{"v":1,"type":"ping","id":"unique-id"}`，接收方立即回复 `{"v":1,"type":"pong","id":"unique-id"}`。插件每 10 秒发送一次，在上一条 ping 未返回时不累积新 ping；等待超过 30 秒后在下一次检查时关闭并重连。WebSocket 底层 ping/pong 不能代替这里的应用层心跳。

## 请求和响应

启动器按 `instanceId` 查找已经注册的 socket，再下发：

```json
{"v":1,"type":"request","id":"request-uuid","method":"instance.info","params":null}
```

`id` 为 1–128 字符字符串，启动器应每次生成新 UUID。`method` 必须在实例的 `methods` 中。`params` 为任意 JSON 值，省略等于 `null`。只在此 socket 上执行，插件无需再次接收目标实例 ID。

```json
{"v":1,"type":"response","id":"request-uuid","ok":true,"result":{"instanceId":"dsh-work-01"}}
```

```json
{"v":1,"type":"response","id":"request-uuid","ok":false,"error":{"code":"METHOD_NOT_FOUND","message":"Method not registered"}}
```

内置方法：`system.ping` 返回 `{"time":"ISO-8601 UTC"}`；`instance.info` 返回 hello 中的实例信息，状态更新为当前状态。其余方法由 DSH 扩展模块注册。

错误码：`INVALID_REQUEST`（请求字段无效）、`METHOD_NOT_FOUND`、`ID_CONFLICT`（同一 ID 的内容改变）、`BUSY`（并发上限）、`TIMEOUT`、`CANCELLED`、`INTERNAL_ERROR`、`INVALID_RESULT`、`RESULT_TOO_LARGE`。扩展方法可用 `LinkError` 返回自身业务错误码，普通异常的内部详情不会发到网络。

同一连接内，相同 ID 且 method/params 的序列化内容相同：处理中不重复执行，完成后返回缓存结果。仅保留最近 256 个已完成请求；缓存淘汰或断线后不保证去重。启动器不能把此机制当作跨断线的 exactly-once 保证，也不能在重连后自动重发有副作用的命令。连接丢失时将未完成请求标为状态未知，需通过业务状态查询决定下一步。

## 取消和事件

启动器可发送 `{"v":1,"type":"cancel","id":"request-uuid"}`。处理器收到 `AbortSignal`，未完成的请求返回 `CANCELLED`。已结束的请求或未知 ID 忽略取消；取消本身没有单独响应。取消是协作式的，不撤销已执行的操作。

DSH 扩展模块可发送：

```json
{"v":1,"type":"event","instanceId":"dsh-work-01","connectionId":"random-uuid","seq":1,"event":"example.progress","data":{"requestId":"request-uuid","progress":50}}
```

`seq` 在插件运行期间递增；事件不保留、不补发，序号可有间隙。启动器用 socket、instanceId 与 connectionId 三者匹配，避免旧连接污染新状态。连接恢复后应重新查询业务状态。方法注册/注销会发送 `capabilities.changed` 事件，`data.methods` 为最新完整列表。

## 关闭与限制

| 关闭码 | 含义和客户端行为 |
| --- | --- |
| `4001` / `4003` | 认证或注册被拒绝，停止重试 |
| `4009` | 实例 ID 冲突，停止重试 |
| `1002` / `1003` / `1007` | 协议、二进制帧或 JSON 错误 |
| 其他关闭或网络故障 | 自动重连，重新 hello/welcome |

无效 welcome 或子协议同样导致停止重试。正常断线重连使用指数退避，起始 500 毫秒、上限 30 秒，加入 ±20% 抖动；成功注册后重置。

默认每帧 256 KiB、发送缓冲 1 MiB、并发请求 16 个、请求超时 30 秒。超大的结果返回错误；输入帧超限或发送缓冲积压时断开连接，避免无限内存增长。启动器也应设置等价限制。
