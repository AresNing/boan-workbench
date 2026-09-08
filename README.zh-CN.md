# Boan Workbench

[English](README.md) · [贡献指南](CONTRIBUTING.md) · [安全说明](SECURITY.md)

面向 macOS 的本地 AI 工作台。交代目标、处理必要决定、验收成果，其余由工作台衔接执行与验证。**任务自动推进、无需管理会话。**

这是首个开源 MVP，版本 **0.8.1**，仍在持续开发。

## 功能

- 项目一键切换，各项目后台推进，草稿与任务上下文隔离。
- 创建任务、补充要求、设置依赖、暂停与恢复，并显式验收经过验证的成果。
- 跨项目待处理汇总、聚合工作记录，以及概览 / 成果 / 执行记录详情。
- 图片、Markdown、文本与已记录代码变更预览；粘贴截图、添加文件、引用项目文件。
- 输入框选择模型、思考强度、速度和命令权限模式。
- 中文、English 和跟随系统语言；用户内容保持原文。
- 支持 ChatGPT/Codex 登录、Claude 登录及 API 服务；模型和用量取决于服务商与账号。

Boan 是独立项目，与 OpenAI、Anthropic 无隶属关系。账号登录依赖上游组件及其服务可用性、使用条款。

## 本地运行

需要 **macOS 13+**、**Node.js 22.19+** 和 npm。桌面版主要在 Apple Silicon 验证；浏览器演示也可在 Linux 运行，暂不支持 Windows。

```sh
git clone https://github.com/AresNing/boan-workbench.git
cd boan-workbench
npm ci
npm run build
npm run demo
```

打开 [localhost:4317](http://127.0.0.1:4317)。演示无需模型账号，仅在 `.workbench/demo` 下创建示例文件，使用有限规则展示工作流，不代表通用 AI 执行能力。

启动桌面版：

```sh
npm run desktop
```

在「设置 → 项目」选择目录；「项目模型」设置默认连接；「账号与服务」管理共享登录与 API 服务；「通用 → 语言」切换语言。首次默认中文。

浏览器 API 模式可复制 `.env.example` 为 `.env`，填写本机项目路径和服务配置，然后运行 `npm start`。不要提交 `.env` 或凭据。

## 执行与权限

项目内主任务串行、项目之间并行。依赖任务等待上游最新验证成果或用户验收；受限辅助执行需要主执行者审阅并整合。

macOS 项目命令默认使用系统沙箱。联网按范围申请权限，解除沙箱必须单次批准。可暂停任务、撤销后续授权。宿主独立运行验证，用户显式确认完成；验证命令通过仅代表该命令覆盖的检查通过。

登录凭据和项目状态保存在项目外的应用数据目录。ChatGPT 凭据支持钥匙串及文件降级、本机文件、仅本次内存三种方式。本机文件仅当前系统用户可访问，但未额外加密。详见 [安全说明](SECURITY.md)。

## 开发与验证

```sh
npm test
npm run build
npx playwright install chromium
npm run test:ui
npm run test:desktop          # 仅 macOS，隐藏窗口、隔离数据
npm run desktop:pack          # 本地 Apple Silicon .app
```

`npm run dev` 启动浏览器开发环境。桌面测试使用临时项目和本地模型替身，不使用真实账号；受控端到端测试不代表任意线上模型输出均可靠。

构建位于 `release/<version>/`，仅保留最近三个版本，并保护运行中的版本。当前采用本机 ad-hoc 签名，未经公证。本次源码 MVP 不包含二进制安装包。

## 当前边界

- 暂不支持 Windows、云同步和多人协作；Intel macOS 有构建脚本，但不属于主要验收基线。
- 每次最多 8 个附件，单文件 8 MB；移除附件只删除引用，项目内已导入的副本仍保留。
- 图片预览上限 8 MB、文本 500 KB；差异仅覆盖 Boan 已记录的写入，不补造历史或任意命令修改的基线。
- 语言切换作用于界面、菜单和通知，不翻译已有任务、文件名与模型回复。模型按任务语言输出；底层诊断保留原文。

## 技术与许可证

React + Vite 界面，Electron 桌面壳，独立 Node 项目进程；pi 工具/Agent 运行时与官方 Codex、Claude 组件承载模型执行，宿主负责状态和权限边界。

见 [架构说明](docs/architecture.md) 与 [第三方声明](THIRD_PARTY_NOTICES.md)。Boan 源码使用 [MIT 许可证](LICENSE)，依赖保持各自许可证。
