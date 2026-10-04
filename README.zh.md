# DSH Launcher Link

第二个独立的 DSH 后端插件。每个 DSH 进程主动建立一条到启动器的 WebSocket 连接；启动器维护实例表，再对接手机。与截图风格 UI 插件可以同时安装。

```text
手机 → 启动器 → DSH 实例 A
             → DSH 实例 B
             → DSH 实例 C
```

版本 `0.2.0` 已实现连接、认证、实例注册、心跳、断线重连，以及 DSH 原生会话和聊天适配。启动器可读取会话列表和完整历史，创建、重命名、分叉会话，选择模型，发送消息、停止生成、编辑待发送队列，订阅实时消息，读取图片附件。完整保留思考、工具调用和结果、控制事件及原生消息 ID；超长内容按 UTF-8 字节分块读取并校验 SHA-256。

协议见 [CHAT-PROTOCOL.zh.md](./CHAT-PROTOCOL.zh.md)。手机连接由 DSHL 网关处理，本插件不包含手机 App。

## 安装

适配 DSH `0.2.0-rc.2`。在需要连接的每个 DSH profile 安装包：

```powershell
dsh plugin --profile my-profile add 'file:C:/absolute/path/dsh-launcher-link-0.2.8.tgz'
```

启动器在创建每个 DSH 子进程时，单独注入以下环境变量。不要通过系统全局环境变量区分多个实例。

| 变量 | 用途 |
| --- | --- |
| `DSH_LAUNCHER_URL` | 启动器 WebSocket 地址，例如 `ws://127.0.0.1:3090/dsh-link/v1` |
| `DSH_LAUNCHER_TOKEN` | Bearer 认证密钥，至少 16 个字符，建议随机生成 32 字节 |
| `DSH_INSTANCE_ID` | 启动器分配并保存的唯一稳定 ID，例如 `dsh-work-01` |
| `DSH_INSTANCE_LABEL` | 可选，人类可读的实例名称 |
| `DSH_INSTANCE_PROFILE` | 可选，profile 名称，用于展示 |

实例 ID 在重启、重连时保持不变，不使用 PID 当作身份。同一 ID 同时连接两次时，启动器应拒绝新连接。不同实例可使用不同密钥，由启动器在认证时将密钥绑定到预期实例 ID。

没有 `DSH_LAUNCHER_URL` 时插件处于 `disabled`，不会建立连接。连接配置也可写到 Cordis 插件配置中；显式配置优先于环境变量。

仅回环地址允许 `ws://`；远程地址使用 `wss://`，正常校验证书。凭据只放在升级请求的 `Authorization` 头中，URL 不接受用户名、密码、查询参数或 fragment。插件不开监听端口。

## 启动器接入

DSHL 的 Windows 本机服务端已与此插件完成双端联调。使用新版 DSHL，在目标实例实际使用的 profile 和 `DSH_HOME` 下安装本插件，然后从启动器重新启动该实例。DSHL 自动注入上述环境变量，端口和密钥由启动器管理，无需手动设置。旧进程没有连接环境变量，安装插件后也需要重启才能接入。

聊天网关交付目录为 `C:/Users/loliyc/Desktop/linshi/DSHL-20261003-093402-547/`。不同实例和同 profile 的并行副本由启动器分配独立身份。原生连接目前验证于 Windows DSH；手机网关对接状态见 [CHAT-INTEGRATION.zh.md](./CHAT-INTEGRATION.zh.md)。

聊天适配默认开启，在宿主 `sessionController` 服务就绪后注册。标准 web/desktop profile 提供该服务；仅有 base bundle 的 profile 保留基础连接能力，不自动加载前端依赖。`instance.info.methods` 和 `capabilities.changed` 是实际可用方法的依据。插件配置 `chat: false` 可关闭聊天适配。

实现 [PROTOCOL.zh.md](./PROTOCOL.zh.md) 中的 `dsh.launcher.v1` 协议即可。`examples/mock-launcher.mjs` 是本机联调服务端，支持多实例注册、认证、心跳，并向刚上线的实例发送一次 `system.ping`。它不负责启动 DSH 或连接手机。

```powershell
$env:DSH_LAUNCHER_TOKEN = '<your-random-token>'
node examples/mock-launcher.mjs
```

在另一个终端为 DSH 设置相同的 token、URL 和独立实例 ID，然后启动对应 profile。启动器应对每次启动生成或读取自己的 token；不要把示例值用于实际环境。

## 扩展命令和事件

其他 DSH 插件通过 Cordis 服务 `ctx.launcherLink` 注册允许远程调用的方法：

```js
export const inject = ['launcherLink'];
export function apply(ctx) {
  ctx.effect(() => ctx.launcherLink.registerMethod('example.echo', async (params, request) => {
    request.signal.throwIfAborted();
    request.publish('example.progress', { requestId: request.requestId, progress: 100 });
    return params;
  }));
}
```

返回值必须能序列化为 JSON。处理器应响应 `AbortSignal`，在执行产生副作用的操作前检查取消状态。取消无法撤销已经发生的修改；断线会取消当前请求，旧连接的处理器不会往新连接发送事件。插件不会自动重发命令，也不缓存离线事件。

服务提供 `state`、`ready` 事件；状态包括 `disabled`、`stopped`、`connecting`、`handshaking`、`ready`、`reconnecting`、`rejected`。认证或实例冲突导致 `rejected` 后停止重试，应修正配置再重新加载插件。正常断线按 0.5–30 秒指数退避并加入抖动重连。

## 默认限制与开发

每帧最大 256 KiB，发送缓冲最大 1 MiB，同时最多 16 个请求，每个请求超时 30 秒；每条连接缓存最近 256 个已完成请求以避免短期重复执行。可通过同名配置项调整，见 `types/index.d.ts`。握手超时 10 秒；每 10 秒发送心跳，等待同一心跳的回复超过 30 秒后在下一次检查时重连。

读取结果超过 128 KiB 时使用临时内容引用，每块不超过 48 KiB，默认缓存 64 MiB、有效期 5 分钟。断线清理引用和订阅，客户端重新订阅并按持久 seq 补拉。发送消息使用独立 `clientRequestId`；插件传入原生 inbox 和日志去重，不把传输请求 ID 当作业务身份。附件上传仍受单帧上限约束；已有文件上传回执可发送，此版本未增加手机文件上传接口。

```powershell
npm ci --ignore-scripts
npm run check
npm test
npm pack
```

插件卸载或 DSH 退出时清理连接、计时器和请求。测试覆盖真实本机 WebSocket 连接；若要运行宿主生命周期测试，将 `DSH_CORDIS_MODULE` 设置为宿主 `@deepseek-ai/cordis/lib/index.js` 的文件 URL，然后运行 `npm test`。

已在真实 DSH `0.2.0-rc.2` 隔离 profile 中验证原生会话、实时生成、工具结果、完整历史、图片读取、超长内容、队列编辑、取消、断线补拉；模型使用本机确定性测试适配器。20 项自动测试通过。实际 DSHL 服务端的基础连接及多实例路由也已验证；真实手机网关与原生插件联调的范围见 [VERIFICATION.zh.md](./VERIFICATION.zh.md)。
