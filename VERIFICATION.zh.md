# 插件验证记录：0.2.0

日期：2026-10-03。目标运行时：本机 Windows DSH `0.2.0-rc.2`，Cordis `4.0.4`。

## 已完成

- JavaScript 语法检查。
- Node test runner：20 项检查，包括多实例独立路由、认证拒绝、实例 ID 冲突、子协议和注册回复校验、动态方法和事件、重复请求去重、超时/取消/并发限制、取消前未启动的处理器、掉线取消与不重放、心跳丢失、超大及不可序列化结果、错误帧、环境配置，以及真实 Cordis 卸载清理。
- 聊天适配检查：完整原生记录、固定列表快照与日志 cut、中文 emoji 分块 SHA-256、稳定 prompt 业务 ID 与内容冲突、opening/live 顺序、退订和断线清理、读写参数与子代理所有权、过期和容量拒绝。
- 安装包通过 `dsh plugin --profile link-check add file:<package>` 安装在隔离测试目录，组合配置中包含 `launcher-link`。
- 真实 DSH 进程加载安装包，使用独立环境变量连接本机模拟启动器；完成 hello/welcome，`instance.info` 返回该 DSH 进程 PID、实例 ID 和 `ready` 状态。

测试只使用随机或专用测试密钥。基础连接脚本位于工作区 `work/launcher-link-dsh-smoke.mjs`；基础安装测试使用工作区 `work/launcher-link-test-home`。没有更改运行中的 UI profile。

## 原生会话与聊天

`0.2.0` tgz 已安装到 `work/launcher-chat-test-home` 的独立 web profile `chat-check`，实际启动本机 DSH 进程，原生 `SessionController`、会话 JSONL 持久化、代理循环、消息投影、工具执行和附件存储参与验证。模型使用本机 `LlmAdapter`，不调用收费模型。

入口：`node work/launcher-chat-dsh-smoke.mjs`。需要本机上述隔离 profile 和 `work/native-chat-overlay.yml`；测试模型实现位于 `work/native-chat-fixture.mjs`。测试配置将 web 端口设为 0，禁止打开浏览器；仅终止自己创建的 DSH 进程。验证产物 `work/native-chat-result.json`。

已通过：

- 21 个方法实际注册；创建、重命名、列表、模型目录与选择、原生投影、分叉。
- 两个不同传输请求使用相同 clientRequestId，仅产生一个对应 user/message；代理重连后再次发送仍只有一个。
- 真实 reasoning、text、tool-call、tool/result 完整保留。长回复由 `完整消息中文🙂` 重复 14000 次组成，约 308000 UTF-8 字节；完整历史页和单事件内容均经分块重组，长度及 SHA-256 校验通过。
- 原生图片输入和会话授权附件读取；返回图片字节与输入一致。
- 原生 follow snapshot、assistant-stream 和持久事件实时传输；unsubscribe 重复执行安全。
- 正在生成时排队、编辑和移除消息，再停止当前 turn；消息和控制事件可读取。
- 断线清理旧内容引用和订阅，身份保持；新订阅提供 replay cut，持久事件补拉可恢复遗漏 turn/end。

最后一次原生测试退出码 0：34 条持久事件、52 条实时帧、8 次内容引用重组校验。测试记录保留所有原生内容块，没有用纯文本摘要替代。

## 真实启动器联调

DSHL 完成服务端后，本会话已重新运行其仓库的 `output/test-launcher-link.ps1`，退出码为 0。测试加载 `bin/WebViewReview/PCL-Deepseek-Harness-Launcher.exe` 的实际服务端实现，与本插件源代码以及隔离 profile 中已安装的插件建立连接。

通过项目包括：错误 token 拒绝、重复 ID 拒绝、token 与实例 ID 绑定、无效 JSON/二进制/超限消息拒绝、`system.ping` 和 `instance.info` 请求、断线后身份保持、应用层心跳、服务恢复原端口和凭据后原客户端重连，以及真实 DSH PID 匹配和两个同时在线实例的独立路由。

交付的 `C:/Users/loliyc/Desktop/linshi/DSHL-20261003-080100-588/PCL-Deepseek-Harness-Launcher.exe` 与被测程序集 SHA-256 相同。启动器的 Windows 实例启动入口已注入连接变量，详见 [LAUNCHER-INTEGRATION.zh.md](./LAUNCHER-INTEGRATION.zh.md)。使用时还需在目标 profile 安装插件，并从新版启动器启动实例；本轮没有修改用户其他 profile 或重启用户正在运行的实例。

## 双端验证边界

上述基础连接已通过实际 DSHL 服务端；DSHL 的聊天网关使用实际编译的 TLS/WSS 服务配合业务夹具完成两个设备、多实例、引用/订阅所有权及断线清理测试，记录见 [CHAT-INTEGRATION.zh.md](./CHAT-INTEGRATION.zh.md)。

插件完成后，DSHL 对话还运行了 `output/test-mobile-native.ps1`：经证书指纹校验的 HTTPS 配对和 WSS 手机客户端 → 实际编译的 DSHL 网关/实例代理 → 安装本插件的隔离真实 DSH。该完整链路退出码为 0，输出 `output/native-mobile-result.json`，同样验证了全部原生聊天检查（34 条持久事件、52 条实时帧、8 次完整内容重组）。联调发现并修复了网关省略 content.read.length 时的参数兼容问题。手机客户端为测试程序，模型为本机可控适配器。

手机 App、手机文件上传和 WSL 跨 Windows 连接未实现或验证。仅 base bundle 的 profile 没有 sessionController，只注册基础连接；标准 web/desktop profile 才会声明聊天方法。此轮没有安装到用户现有 profile 或重启现有实例。
