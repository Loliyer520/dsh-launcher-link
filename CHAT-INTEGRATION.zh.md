# 聊天接入：DSHL 网关实现与验证

2026-10-03。已按 CHAT-PROTOCOL.zh.md 实现并编译，源码：C:/Users/loliyc/Documents/Code/PCL-Deepseek-Harness-Launcher/Modules/DeepSeek/ModMobileGateway.vb。

## 已完成

- 完整明确方法白名单（合同表格全部方法及基础两个方法），本机代理还验证目标实例 capability；不透传任意插件命令。
- 参数类型/分页上下界/业务 ID/内容读取长度检查；业务字段由原生插件继续校验。每个手机连接最多 32 个订阅、256 个存活内容引用。
- subscriptionId 公开编号映射为网关生成 UUID，发请求之前登记所有权。result、follow、end 还原公开编号；所有权绑定手机连接和实例。
- 仅向所有者转发 session.follow/session.subscription.end。session.list.changed 与 capabilities.changed 为明确公共失效通知，其他事件拒绝。
- 保留 result/原生帧完整 JSON；返回或定向事件中的 content-ref 注册到所有者，阻止其他连接或实例偷读/释放。最多 49152 字节分块；客户端按 UTF-8 字节重组与 SHA256 校验。
- 手机断线、撤销、服务停止时退订及释放内容；响应晚于断线也回收。清理并发限制 4，最多 3 次仅针对幂等 UUID 清理的尝试，聊天写操作不自动重发。
- 请求 clientRequestId 不受本机传输请求 ID 改写影响。手机重连需重建订阅和持久游标补拉，不恢复旧临时内容引用。

## 测试入口与结果

仓库 output/test-mobile-chat.ps1 调用实际编译程序集，启动真实 TLS/WSS 网关和本机代理，并启动 Node transport 方法夹具；可直接 powershell.exe -NoProfile -ExecutionPolicy Bypass -File output/test-mobile-chat.ps1。依赖已安装的 Node、共享插件 node_modules/ws 和 src/transport.js。测试输出 output/mobile-chat-test.log，全部通过。

覆盖：TLS 指纹错误/配对复用/未认证请求；两个不同设备；相同公开订阅名及 early event；外设备读取/退订拒绝；中文 emoji/思考/工具/附件结构的超长内容完整 SHA256 重组；分块长度限制；clientRequestId；两个实际已连接实例独立路由与跨实例引用拒绝；非法分页；未知实例/未知事件；定向 follow；断线/撤销退订和引用清理；证书/撤销持久化。

上述脚本是网关业务夹具测试；此外已通过真实 DSH sessionController 与本机可控模型的端到端联调，详见下方“真实手机网关 → 原生 DSH 联调通过”。不操作用户现有会话，不调用真实收费模型。需要额外连接夹具时参考 output/test-mobile-chat.ps1 的反射 API：StartMobileServer(dataDirectory,0)、BeginMobilePairing、ConfigureLauncherLink(ProcessStartInfo,entryKey,label,profile)。该脚本通过标准输入传递凭据，不在输出/参数中打印秘密。

设备授权允许该启动器全部已认证实例；暂无账号/逐实例 ACL。每个手机连接单独资源所有权，允许同设备两条连接。传输单帧 256 KiB，128 KiB Payload/48 KiB chunk 合同可直接通过。代理请求超时 30 秒，超时不重发写操作。

手机 App 不在本轮范围；网关和协议文档已交付，最新目录见文末。

最新网关已交付：C:/Users/loliyc/Desktop/linshi/DSHL-20261003-093402-547；文件 SHA256 与原生联调修复后的测试构建逐项验证一致。

## 真实手机网关 → 原生 DSH 联调通过

2026-10-03：实际编译 DSHL 网关、真实 HTTPS/WSS 手机测试客户端、真实 DSH 0.2.0-rc.2 和安装的 0.2.0 插件包完成端到端联调。

入口：启动器仓库 output/test-mobile-native.ps1 / output/test-mobile-native-client.mjs；结果 output/native-mobile-result.json，output/mobile-native-test.log。在全新 Temp DSH_HOME 写入新会话，不改既有用户会话。只复用共享隔离测试 profile 的 node_modules，使用本机可控模型与工具，无收费 API。

结果 ok=true，34 durableEvents、52 streamFrames、8 contentRefsVerified。覆盖 native create/list/rename/model、prompt 独立 ID 去重、真实 reasoning/text/tool-result、UTF8超长中文emoji完整SHA256重组、page/single-event/projections、subscribe/unsubscribe、cancel、queue edit/remove、image attachment 原字节、phone disconnect 后内容不可复用、新订阅 replay cut 与持久补拉、fork。

网关发现并修复：content.read length 是可选字段，省略时补为49152，避免原生客户端调用被误拒绝。offset仍必须非负整数。重复退订在网关已移除所有权时返回SUBSCRIPTION_NOT_OWNED（而非插件直连的false），手机可按“本地已退订”处理。业务夹具隔离测试在修复后再次全部通过。

没有验证实体手机，也不包含手机App。未自动升级用户现有profile插件或启动真实用户实例。

本次原生联调修复后的最新交付：C:/Users/loliyc/Desktop/linshi/DSHL-20261003-093402-547，逐文件验证与测试构建一致。

