# DSH 会话与聊天协议 v1

沿用 `dsh.launcher.v1` 传输。所有方法调用指向指定实例；手机网关继续使用 `dsh.mobile.v1`，必须逐项开放下面的方法。插件版本 `0.2.0`。会话能力在 DSH 原生 `sessionController` 服务就绪后注册，普通 web/desktop profile 已提供此服务；未提供该服务的 profile 只声明基础连接能力。

本协议直接保留 DSH `0.2.0-rc.2` 的原生会话日志、投影与 assistant-stream 结构，不把消息转换成纯文本或摘要。未知事件与内容块仍保留。事件 `seq` 是会话内持久日志游标，消息本身的 id、工具 callId、attemptId 和 turn 分别保留，不能互相替代。

## 结果载荷及超长内容

读取结果、订阅 opening 和事件 frame 均使用统一的 `Payload`：

```json
{"kind":"inline","value":{"records":[]}}
```

当 JSON UTF-8 内容超过 128 KiB 时返回引用，原始 JSON 不截断：

```json
{"kind":"content-ref","contentId":"random-uuid","encoding":"utf8-json","totalBytes":300000,"sha256":"hex","chunkBytes":49152,"expiresAt":1791030000000}
```

调用 `content.read`，参数 `{contentId, offset:0, length:49152}`；返回 `{contentId, offset, nextOffset, totalBytes, encoding:"base64", data, done, sha256}`。offset 是 UTF-8 **字节**偏移。依次读取并拼接解码后的字节，校验长度和 SHA-256，最后一次性 UTF-8 解码、JSON 解析。不可逐块解码字符串后拼接，以免拆开中文和 emoji。

可用 `content.release({contentId})` 提前释放，返回 `{released:boolean}`。引用是当前连接内的临时内容快照，存活 5 分钟；断线清理。默认总缓存 64 MiB，单内容超过该上限明确报错 `CONTENT_TOO_LARGE`，不返回截断结果。过期或被资源上限淘汰返回 `CONTENT_EXPIRED`，客户端重新执行原读取。禁止将 contentId 当作磁盘路径。临时内容只留在插件进程内存，不写消息日志文件。

## 方法

| 方法 | 读写 | 参数 | 结果 |
| --- | --- | --- | --- |
| `session.list` | 只读 | `{limit?:1..100,cursor?:opaque}` | Payload：`{items:原生SessionSummary[],nextCursor:string或null,hasMore:boolean}`；游标固定第一批列表快照，5 分钟有效 |
| `session.get` | 只读 | `{sessionId}` 或 `{address}` | Payload：`{header:原生头,cursor:持久日志末尾seq,projections:原生投影基线,running:boolean}` |
| `session.page` | 只读 | `{sessionId或address,throughSeq?:-1以上,beforeSeq?:0以上,maxMessages?:1..100}` | Payload：`{records:原生事件记录[],hasMore,throughSeq,nextBeforeSeq}`；chronological records，向前翻页。throughSeq 是固定日志 cut，后续页沿用 |
| `session.events` | 只读 | `{sessionId或address,afterSeq?:-1以上,throughSeq?:-1以上,limit?:1..200}` | Payload：`{records:原生事件记录[],throughSeq,nextAfterSeq,hasMore}`；按持久 seq 顺序补拉；afterSeq 不包含在结果中 |
| `session.event` | 只读 | `{sessionId或address,seq:0以上}` | Payload：一条原生 `{type:"event",event:{type,seq,time,data,...}}`，完整单条消息/事件可分块读取 |
| `session.projections` | 只读 | `{sessionId}` | Payload：原生投影基线，含标题、模型、控制状态等已注册投影 |
| `session.attachment` | 只读 | `{sessionId,attachmentId}` | Payload：原生可达图片 `{attachment:元数据,data:base64}`，由 DSH 校验该会话对附件的访问；文件引用元数据保留在日志中 |
| `model.catalog` | 只读 | `{}` | Payload：原生模型目录 |
| `session.create` | 写 | `{sessionId?:稳定自选ID,cwd?:路径,workspaceId?:ID,agentPreset?:名称}` | 原生 `{sessionId,agentPreset?}`；cwd 和 workspaceId 二选一 |
| `session.rename` | 写 | `{sessionId,title}` | 原生 `{title,seq}` |
| `session.fork` | 写 | `{sessionId,atSeq?:0以上}` | 原生 `{sessionId}` |
| `session.selectModel` | 写 | `{sessionId,provider,model,reasoningEffort?}` | 原生 `{selected}` |
| `session.prompt` | 写 | `{sessionId,clientRequestId,content:[原生PromptContentPart],mode?:"queue"或"steer",clientTimeZone?:IANA时区}` | 立即返回 `{accepted:true,clientRequestId}`，不等待生成结束 |
| `session.cancel` | 写 | `{sessionId}` | 原生 `{accepted:true}`，停止当前 turn，保留待处理 inbox |
| `session.queue.update` | 写 | `{sessionId,itemId,action:{kind:"remove"或"steer"}或{kind:"edit",content:[{type:"text",text}]}}` | 原生 `{accepted:true}` |
| `session.subscribe` | 订阅 | `{subscriptionId,sessionId或address,afterSeq?:-1以上,maxMessages?:1..100}` | `{subscriptionId,opening:Payload,replay:{afterSeq,throughSeq}或null}` |
| `session.unsubscribe` | 退订 | `{subscriptionId}` | `{unsubscribed:boolean}` |
| `content.read` / `content.release` | 只读/释放 | 如上 | 如上 |

`address` 是原生地址：普通会话 `{kind:"session",sessionId}`；子代理 `{kind:"subagent",parentSessionId,childSessionId,mode:"one-shot"或"continuable"或"unknown"}`。子代理读历史和跟随必须提供父会话地址，由原生 API 核验。子代理不能用普通会话的 prompt/cancel 路径越过原生所有权限制。

PromptContentPart 支持 `{type:"text",text}`、`{type:"image",mediaType,data:base64,name?}`，以及已有文件上传回执 `{type:"file",receiptId}`。本轮不另造手机文件上传服务，输入仍受传输单帧上限约束。大图片读取走上述内容分块。

`clientRequestId` 是发送者生成的永久唯一业务请求 ID，与会被代理改写的传输 `request.id` 独立。网关必须原样传递。插件将其传入原生 prompt 的 `requestId`，原生 inbox/持久日志用于同一 prompt 的去重；进程内还检查同一 session/clientRequestId 的内容冲突。客户端不能把此 ID 用于另一段内容，也不能自动重发有副作用的操作。原生会话可合并排队的用户输入，故不伪造一个提前确定的 runId；持久 user/message 中的 source.rpcId 用于消息关联，turn/start 与 assistant-stream 的 turn/attemptId 用于运行关联。

## 订阅与断线恢复

subscriptionId 由网关或客户端在请求前生成，必须与传输 request.id 独立；每个实例内唯一，最多 32 个同时订阅。网关在发起订阅前记录 `(手机连接,instanceId,subscriptionId)` 所有权，不把别的连接的编号直接复用。插件先返回原生 follow 的 opening snapshot，再发送后续帧。

```json
{"v":1,"type":"event","instanceId":"dsh-...","connectionId":"...","seq":5,"event":"session.follow","data":{"subscriptionId":"unique-subscription-id","frame":{"kind":"inline","value":{"type":"event","event":{"type":"assistant/message","seq":17,"time":1,"data":{}}}}}}
```

opening.value 为原生 snapshot：header、cursor、records、hasMore、projections、assistantStream。`session.follow` 的 frame.value 为原生 `event` 或 `assistant-stream`，完整保留结构。assistant-stream 没有持久 seq，使用其 revision/index/attemptId；已提交的事件以持久 seq 去重。

客户端恢复时以最后已落地的持久 seq 发起新订阅。返回 replay 指定旧游标到 opening.cursor 的缺口；按 `session.events` 分页补拉至该固定 cut，同时暂存后续 live 帧，补完后按 seq 合并。afterSeq 超过现有 cursor 返回 `CURSOR_AHEAD`，不静默重置。没有旧游标时直接采用 opening 的当前窗口，旧历史用 session.page 读取。opening 的 assistantStream 基线恢复进行中的流式展示。

订阅正常关闭或出错可收到 `session.subscription.end`，data 为 `{subscriptionId,error?:{code,message}}`；错误后需重新订阅。普通取消传输请求不能代替 `session.cancel` 或 `session.unsubscribe`。手机断线/撤销授权/服务停止时网关发送 unsubscribe；DSH 代理断线时插件取消全部订阅、清理临时读取缓存。重连后不自动恢复旧订阅，客户端重新建立并补拉。网关只向订阅所有者转发对应事件；队列溢出断开并要求重同步，禁止静默丢帧。

列表变化发 `session.list.changed`，data 为 `{sessionId,change}`，change 为 `added`、`removed`、`status`、`activity` 或 `error`。这是列表失效提示，客户端重新分页读取列表；不携带消息正文。网关可向已认证连接转发此明确白名单事件。`capabilities.changed` 仍仅携带方法列表。

## 验证与限制

严格检查字段和参数，不允许远程调用任意 service 方法。读取的 Payload 上限按 128 KiB 分流，分块固定不超过 48 KiB，外层 event/response 留足网关封装空间。业务错误保留受控原生错误码，内部异常不包含到网络返回值中。内容读取和补拉不驱动聊天；原生 follow 可激活持久会话，其行为与官方 UI 一致。

端到端验证应包含：创建/重命名/分页、包含中文和 emoji 的超长内容 SHA-256 完整重组、native 思考/工具调用/结果结构保持、prompt 立即 ACK 与稳定业务 ID 去重、取消和队列动作、opening 与 live seq 连续、断线补拉、多实例与两个设备的订阅隔离，以及权限撤销时退订清理。测试使用隔离 DSH_HOME 和本机可控模型 provider，不调用用户真实模型或修改已有会话。


## 0.2.1 扩展

新增归档/恢复、分块文件上传、continued 问题回答与一次性权限审批。启动器及手机端的稳定方法、参数、能力、所有权和限额以启动器仓库 docs/mobile-protocol.zh.md 的 0.2.1 契约为准。审批只支持 allowed-once/rejected，不修改持久权限策略。

## 0.2.2 队列附件保留

新增 `session.queue.editText({sessionId,itemId,text,expectedContentHash})`，返回 `{accepted:true,itemId,contentHash}`。摘要算法和原生 inbox 结构详见启动器 docs/mobile-protocol.zh.md 的“队列内容与保留附件的文本编辑”。仅更改普通待处理用户消息的文字，通过原生 Inbox.replace 保留图片/文件引用及原 id/source。旧 session.queue.update 的 edit 遇到已有附件返回 QUEUE_ATTACHMENT_EDIT_REQUIRED，禁止无声丢附件。已在真实 DSH 0.2.0-rc.2 中验证混合内容编辑及实际消费；原生 updateQueue 本身仍是整体文本替换，未修改上游代码。

## 0.2.3 文件读取与归档只读

新增 file.download.begin/read/release：按普通会话日志证明 FileBlock 附件可达后调用原生 AttachmentStore.readFileStream；顺序字节 offset、最多48KiB一块、EOF才确认完整性、连接/实例隔离、五分钟空闲过期，最大1GiB和4个下载槽。所有字段、失效条件和手机暂存校验要求见启动器 docs/mobile-protocol.zh.md。归档 session.subscribe 返回 ARCHIVED_READ_ONLY，因为原生 follow 会在快照后激活冷 Agent；改用 get/page/events/projections 冷安全读取。真实临时 DSH 0.2.0-rc.2 已验证文件长度/原字节/SHA-256及冷归档读取不激活。


连接插件 0.2.4 扩展既有 session.search：原生 current 索引跨会话搜索，可显式包含冷归档，返回真实匹配 seq、元数据、范围说明与私有分页游标；新增 session.search.cancel。以实例同时声明两个方法识别，openAt=never 不声明、不修改用户配置。完整参数、返回值、取消限制、跳转及证据见 docs/mobile-protocol.zh.md 的“跨会话索引搜索（连接插件 0.2.4）”（本文件位于 docs 时为同目录 mobile-protocol.zh.md）。


0.2.5 新增 session.context：原生完整 surface 判定后返回固定 cut 的小原始事件窗口和前后读取位置，窗口外 replace 仍被考虑；冷归档不激活。宿主仍读取完整原生日志，cut 变化返回 CONTEXT_STALE。完整合同及证据见 mobile-protocol.zh.md 的“搜索命中上下文窗口”（插件目录文档对应仓库 docs/mobile-protocol.zh.md）。


0.2.6 修复 hello→welcome 期间注册方法丢失能力通知的竞态：每次握手完成/重连补发完整 capabilities.changed，启动器同步方法快照。HTTPS instances/WSS ready 与真实 instance.info 一致性已通过非 fixture DSH 的 pinned 网络验证，见 docs/mobile-protocol.zh.md 和 output/mobile-capabilities-live-result.json；Flutter 本体联调由客户端单独验收。


0.2.7 复用原生 WorkspaceRegistry 持久置顶和 WorkspaceEntity 手动排序：session.pin、workspace.list、workspace.insertSessionBefore；session.list 补 pinned/pinOrder/workspaceId/workspaceOrder，可选工作区 manual 排序。原生 pin 属于实例 registry 全局集合，归档移除 pin、pin 不自动恢复；原生 workspace domain 变化通知全客户端刷新。完整合同/边界/证据见 docs/mobile-protocol.zh.md 的“原生置顶与工作区手动排序”。

### 0.2.8 原生标题变更通知

原生 `session/title` 提交后广播 `session.list.changed`，数据为 `{sessionId, change:"updated", reason:"title", seq}`。覆盖手机重命名、桌面重命名和原生自动标题生成，不要求观察设备订阅该会话。收到通知后重新读取列表首页；旧分页快照保持稳定，不应继续旧游标来刷新标题。标题以新的 `session.list` 投影为准，通知不包含伪造标题。
