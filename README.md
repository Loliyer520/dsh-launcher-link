# DSH Launcher Link

DSH 后端连接插件。每个实例主动连接启动器，通过启动器统一接入手机客户端。

版本 **0.2.0**，适配 DeepSeek Harness **0.2.0-rc.2**。

支持会话列表、创建、重命名、分叉、模型选择、完整聊天历史、实时消息、停止生成、待发送队列编辑、图片附件读取和断线补拉。保留原生思考、工具调用与结果；超长内容通过 UTF-8 字节分块及 SHA-256 校验完整读取。

- [安装与使用](README.zh.md)
- [连接协议](PROTOCOL.zh.md)
- [会话与聊天协议](CHAT-PROTOCOL.zh.md)
- [DSHL 网关对接与联调](CHAT-INTEGRATION.zh.md)
- [验证记录](VERIFICATION.zh.md)

安装包见本仓库 Releases。安装后，从支持连接协议的 DSHL 启动目标实例。

```powershell
dsh plugin --profile my-profile add 'file:C:/path/to/dsh-launcher-link-0.2.0.tgz'
```

聊天功能需要宿主提供 `sessionController`，标准 web/desktop profile 已包含该服务。仅 base bundle 的 profile 提供基础连接能力。手机 App 不在本插件内。

## 开发

```powershell
npm ci --ignore-scripts
npm run check
npm test
npm pack
```

真实宿主生命周期测试需要设置 `DSH_CORDIS_MODULE` 为宿主 Cordis 模块的文件 URL；未设置时该测试跳过。真实 DSH 与已编译 DSHL 网关已在隔离环境联调通过，使用本机可控模型，无收费 API。

License: MIT.
