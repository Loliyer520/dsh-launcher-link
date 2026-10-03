# DSHL 启动器对接状态

启动器服务端已实现、编译并完成真实插件联调。仓库：C:\Users\loliyc\Documents\Code\PCL-Deepseek-Harness-Launcher。
交付目录：C:\Users\loliyc\Desktop\linshi\DSHL-20261003-080100-588。

## 正式入口

Windows 原生实例启动时自动注入 DSH_LAUNCHER_URL、DSH_LAUNCHER_TOKEN、DSH_INSTANCE_ID、DSH_INSTANCE_LABEL、DSH_INSTANCE_PROFILE。地址为 ws://127.0.0.1:<动态端口>/dsh-link/v1，选择子协议 dsh.launcher.v1。启动器没有向局域网或公网提供这个连接端口，不包含手机入口。

实现位于 Modules/DeepSeek/ModLauncherLink.vb，注入位于 ModHarness.HarnessLaunchRunWindows，服务由第一次 Windows 实例启动时创建。插件仍需安装在目标 profile 内；此修改没有自动修改用户的插件列表。

稳定 instanceId 从 native + EntryKey + profile 的持久条目身份派生，connectionId 使用插件传入的每次连接 ID。凭据为每逻辑实例的随机 256 位值，与 WebUI token 分离。连接凭据和端口写入已有的当前用户 DPAPI 加密会话记录；只对通过现有进程身份校验的存档恢复服务。原端口被别的程序占用时不抢占，不停止 DSH，会记录提示，重启目标实例即可获得新的连接配置。旧版本启动的进程没有这组环境变量，需要首次重启。

同一逻辑条目/profile 的首个副本使用基础稳定 ID，额外运行副本使用可用 slot 身份，存入加密会话记录。不同条目、profile 或运行副本有不同身份；同一个 ID 的重复连接仍拒绝新连接 4009。同 profile 多副本身份分配已通过 WebView 测试夹具验证。

## 调用 API

ModLauncherLink.ConnectedLauncherInstances() 返回已注册 ID。
ModLauncherLink.RequestLauncherInstanceAsync(instanceId, method, parameters) 返回完整 response JObject，内置 system.ping 和 instance.info 已联调，可调用插件声明的扩展方法。请求 30 秒超时后发送 cancel；连接丢失标记结果未知，不自动重发。每连接最多 16 个未完成请求。
ModLauncherLink.LauncherLinkEventReceived(instanceId, eventName, data) 分发已核对 socket、instanceId、connectionId 的事件，运行在连接处理线程；UI 消费者须切回 UI 线程。capabilities.changed 更新方法列表。

服务支持应用层双向 ping/pong、WebSocket 控制帧、分片文本消息；限制消息 256 KiB、HTTP 头 8 KiB、总连接 32，握手绝对期限 10 秒。socket 明确禁止子进程继承，退出仅释放连接服务，不终止 DSH。

## 可重复真实联调入口

在启动器仓库运行：

powershell.exe -NoProfile -ExecutionPolicy Bypass -File output/test-launcher-link.ps1

脚本从 bin/WebViewReview 加载实际编译的启动器程序集，并从共享插件目录导入真实 LauncherLink 客户端。测试密钥只通过子进程标准输入传递，不写入日志或参数。随后启动共享 work/launcher-link-test-home 的隔离真实 DSH 0.2.0-rc.2 profile link-check，核对返回 PID。仅终止本脚本创建的测试进程，不触及用户实例。

已通过：错误认证拒绝、重复连接拒绝、token 与实例身份绑定、无效 JSON、二进制和超大帧拒绝、真实插件 system.ping / instance.info、断线重连、应用层心跳、服务恢复原端口和密钥后原客户端重新连接、真实安装包在 DSH 中注册、两个并行实例独立路由。输出为 output/launcher-link-test.log。

另已通过 output/test-webview.ps1，现有 WebView 和悬浮球未发生测试回归。WSL 与手机入口不在本轮实现范围。
