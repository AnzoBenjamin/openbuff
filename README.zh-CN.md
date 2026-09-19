# Openbuff

[English](./README.md) | 简体中文

**Openbuff** 是一款开源、本地优先的智能编程 CLI，通过用户配置的 OpenAI 兼容或 Anthropic 兼容提供商，根据自然语言指令直接修改你的代码库。

与那种"一个模型干所有事"的工具不同，Openbuff 会协调多个专业化的智能体（agent）协同工作，理解你的项目并做出精准的改动。

> **兼容性说明：** Openbuff 保留了一些上游兼容别名，确保已有项目继续可用。SDK 包名为 `@openbuff/sdk`，主导出类是 `OpenbuffClient`，`CodebuffClient` 仍是兼容别名。环境变量 `CODEBUFF_API_KEY` 可作为 `OPENBUFF_API_KEY` 的回退。其他旧版 `CODEBUFF_*` 环境变量和 `codebuff.json` 配置路径已在 BYOK 重构中移除，不再受支持。新的文档和示例应优先使用 Openbuff 品牌以及 `openbuff` / `OPENBUFF_*` / `openbuff.json` 主名称，除非是在说明这些兼容别名。参见 [Openbuff 本地/BYOK 提供商模式](./docs/local-mode.md)。

<div align="center">
  <img src="./assets/codebuff-vs-claude-code.png" alt="Openbuff vs Claude Code" width="400">
</div>

Openbuff 的多智能体架构基于真实开源仓库的编码任务评测持续优化（[评测详情](evals/README.md)）。

## 工作原理

当你让 Openbuff "给我的 API 加上身份验证"时，它可能会调用：

1. **File Picker Agent** —— 扫描代码库、理解架构、找出相关文件
2. **Planner Agent** —— 规划哪些文件需要改、按什么顺序改
3. **Editor Agent** —— 执行精确的修改
4. **Reviewer Agent** —— 校验改动是否正确

<div align="center">
  <img src="./assets/multi-agents.png" alt="Openbuff Multi-Agents" width="250">
</div>

这种多智能体方案能带来更准的上下文理解、更精确的修改，以及更少的错误。

## CLI：装好就能写代码

安装：

```bash
npm install -g @openbuff/cli
```

运行：

```bash
cd your-project
openbuff
```

配置提供商：在 TUI 内运行 `/setup <preset>`（如 `/setup openai`）快速套用预设，或在 `openbuff.json` 中声明提供商和模型路由。然后导出提供商 `apiKeyEnv` 指定的 API key 环境变量（如 `export OPENAI_API_KEY="..."`），再告诉 Openbuff 你想做什么。

完整流程——安装 → 提供商配置 → 模型路由 → 验证——见下文[快速上手](#快速上手)（英文原版见 [docs/getting-started.md](./docs/getting-started.md)）。

## 快速上手

> 英文权威版本见 [docs/getting-started.md](./docs/getting-started.md)。

Openbuff 是一款本地优先、自带密钥（BYOK）的智能编程 CLI：没有账号、没有积分、也没有托管推理——你为自己的提供商（OpenAI、Anthropic/Claude、OpenRouter、本地 Ollama，或任何 OpenAI 兼容端点）提供 API key，每次模型请求都在本地根据你的配置完成解析。本指南带你从安装一路走到可用的 CLI 会话。

### 1. 安装

```bash
npm install -g @openbuff/cli
```

在你的项目目录中运行：

```bash
cd your-project
openbuff
```

### 2. 配置提供商

Openbuff 自身不运行任何模型——把它指向一个你有密钥的提供商即可。提供商配置按以下优先级从多个来源读取：

1. `OPENBUFF_PROVIDER_CONFIG` —— 指向单个配置文件的环境变量
2. `~/.config/openbuff/provider-config.json` —— 用户全局配置
3. `~/.config/openbuff/openbuff.json` —— 用户全局配置（备用名称）
4. 当前目录及其各级祖先目录（含 `$HOME`）中的 `openbuff.json` —— 项目本地配置

多文件合并语义详见 [configuration.md](./docs/configuration.md)。

有两条快速路径。

#### 在 TUI 内（推荐）

运行你提供商对应的预设命令：

```text
/setup openai   # 预设：openai, anthropic, codex, openrouter, ollama,
                # glm, opencode-go, bedrock, freemodel
```

或使用交互式向导（包括自定义提供商）：

```text
/provider add
```

对于 ChatGPT/Codex 订阅，先连接 OAuth：

```text
/provider connect codex
```

#### 手动（`openbuff.json`）

按照上面的搜索顺序，创建一个 `openbuff.json`（项目本地或用户全局），包含一个提供商和默认路由：

```jsonc
{
  "providers": {
    "openai": {
      "type": "openai-compatible",
      "baseURL": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY",
      "models": ["gpt-5.5", "gpt-5.4-mini"]
    }
  },
  "defaultModel": "openai/gpt-5.5",
  "modes": { "default": "openai/gpt-5.5" }
}
```

`apiKeyEnv` 指定存放 API key 的环境变量——在启动 Openbuff 之前先导出：

```bash
export OPENAI_API_KEY="..."
```

### 3. 路由你的模型

Openbuff 根据 `openbuff.json` 为每个智能体步骤路由模型：

- `modes.default` 和 `modes.plan` 覆盖内置的根智能体。
- `agents[agentId]` 覆盖子智能体及其他非 mode 智能体。
- `defaultModel` 是上述都未匹配时的兜底。

**没有硬编码的兜底模型。** 如果某个智能体没有配置模型，Openbuff 会报错：

```text
No model configured for agent '<id>'. Run /setup or set defaultModel ...
```

用 `/models` 打开模型路由选择器，或用 `/models configure` 打开交互式路由向导。完整的解析顺序见 [local-mode.md](./docs/local-mode.md)。

### 4. 验证

在 TUI 内：

```text
/provider status   # 已加载配置、提供商 URL、缺失环境变量
/models            # 模型路由选择器
```

导出 API key 后，可选择性运行冒烟测试：

```bash
bun run smoke:openbuff
```

### 5. 故障排查

- **`No model configured for agent '<id>'`** —— 该智能体没有路由到任何模型。运行 `/setup <preset>`，或在 `openbuff.json` 中设置 `defaultModel`（或 `agents['<id>']`）。
- **缺少 API key 环境变量** —— 提供商的 `apiKeyEnv` 变量未导出。导出它（例如 `export OPENAI_API_KEY="..."`）后重启。`/provider status` 会列出每个提供商缺失的环境变量。
- **`chatgpt-oauth` 提供商失败** —— ChatGPT/Codex OAuth 提供商需要先执行 `/provider connect codex` 才能提供服务。
- **配置未生效** —— `/provider status` 会显示实际加载了哪个文件。检查第 2 节的优先级顺序；当多个文件匹配时，[configuration.md](./docs/configuration.md) 中的合并规则决定哪些值生效。

## 创建自定义智能体

要开始构建自己的智能体，先启动 Openbuff 然后执行 `/init`：

```bash
openbuff
```

进入 CLI 后：

```
/init
```

这会生成：

```
knowledge.md               # Openbuff 用的项目上下文
.agents/
└── types/                 # TypeScript 类型定义
    ├── agent-definition.ts
    ├── tools.ts
    └── util-types.ts
```

通过编写智能体定义文件，你可以最大程度地控制智能体的行为。

通过指定工具、可派生的子智能体和提示词来实现自己的工作流。我们还提供了 TypeScript 生成器，方便你以更程序化的方式控制流程。

下面是一个 `git-committer` 智能体的例子，它会基于当前的 git 状态生成提交。注意它先跑 `git diff` 和 `git log` 分析改动，然后再把决策权交给 LLM，让它撰写有意义的 commit message 并完成实际提交。

```typescript
export default {
  id: 'git-committer',
  displayName: 'Git Committer',
  model: 'openai/gpt-5.4-nano',
  toolNames: ['read_files', 'run_terminal_command', 'end_turn'],

  instructionsPrompt:
    'You create meaningful git commits by analyzing changes, reading relevant files for context, and crafting clear commit messages that explain the "why" behind changes.',

  async *handleSteps() {
    // 分析改动
    yield { tool: 'run_terminal_command', command: 'git diff' }
    yield { tool: 'run_terminal_command', command: 'git log --oneline -5' }

    // 暂存文件，并用合适的 message 生成提交
    yield 'STEP_ALL'
  },
}
```

## SDK：在生产环境里跑智能体

安装 [SDK 包](https://www.npmjs.com/package/@openbuff/sdk)。SDK 包名为 `@openbuff/sdk`，主导出类是 `OpenbuffClient`（`CodebuffClient` 仍为兼容别名）。

```bash
npm install @openbuff/sdk
```

引入 client，开始跑智能体：

```typescript
import { OpenbuffClient } from '@openbuff/sdk'

// 1. 初始化 client
const client = new OpenbuffClient({
  cwd: '/path/to/your/project',
  onError: (error) => console.error('Openbuff error:', error.message),
})

// 2. 跑一个编码任务……
const result = await client.run({
  agent: 'base', // Openbuff 默认的基础编码智能体
  prompt: 'Add error handling to all API endpoints',
  handleEvent: (event) => {
    console.log('Progress', event)
  },
})

// 3. 也可以跑自定义智能体！
const myCustomAgent: AgentDefinition = {
  id: 'greeter',
  displayName: 'Greeter',
  model: 'openai/gpt-5.5',
  instructionsPrompt: 'Say hello!',
}
await client.run({
  agent: 'greeter',
  agentDefinitions: [myCustomAgent],
  prompt: 'My name is Bob.',
  customToolDefinitions: [], // 也可以加自定义工具！
  handleEvent: (event) => {
    console.log('Progress', event)
  },
})
```

更多 SDK 用法请看[这里](https://www.npmjs.com/package/@openbuff/sdk)。

## 提供商配置

刚接触 Openbuff？[快速上手](#快速上手)完整讲解了从安装、配置提供商、路由模型到验证的全流程。

Openbuff 默认在本地/BYOK 模式下运行：不需要托管认证、积分或平台推理。在 `openbuff.json` 中配置 OpenAI 兼容或 Anthropic 兼容提供商和按智能体路由的模型。详情请见 [Openbuff 本地/BYOK 提供商模式](./docs/local-mode.md)。

在 CLI 内：

```text
/setup opencode-go   # 或 openai, anthropic, codex, openrouter, ollama, glm
/provider            # 打开交互式提供商选择器
/provider add        # 交互式提供商向导，包括自定义提供商
/provider status     # 显示已加载配置、提供商 URL、缺失环境变量
/models             # 打开模型路由选择器
/models configure   # 交互式模型路由向导
```

从 shell：

```bash
export OPENCODE_GO_API_KEY="your_key"
bun run smoke:openbuff
```

## 为什么选 Openbuff

**自定义工作流**：用 TypeScript 生成器把 AI 生成和程序化控制混着用。智能体可以派生子智能体、按条件分支、跑多步流程。

**灵活的提供商**：与单提供商工具不同，Openbuff 可以将每个智能体路由到任何已配置的提供商：OpenAI API、Anthropic/Claude API、ChatGPT/Codex 订阅 OAuth、OpenRouter、opencode 网关、GLM/Z.ai、本地 Ollama/LM Studio，或其他 OpenAI 兼容或 Anthropic 兼容端点。

**复用本地智能体**：组合打包的和项目本地 `.agents/`，无需依赖托管注册表。

**SDK**：把 Openbuff 嵌进你自己的应用里。可以创建自定义工具、对接 CI/CD，或把编码能力内嵌进你的产品。

## 进阶用法

### 自定义智能体工作流

用 `/init` 命令创建带专门工作流的智能体：

```bash
openbuff
/init
```

这会在 `.agents/` 下生成一套可自定义的智能体结构。

## 参与贡献

我们 ❤️ 来自社区的贡献——无论是修 bug、调整智能体、还是改进文档。

**想参与？** 看一眼[贡献指南](./CONTRIBUTING.md) 就能上手。

### 运行测试

跑测试套件：

```bash
cd cli
bun test
```

**交互式端到端测试**需要 tmux：

```bash
# macOS
brew install tmux

# Ubuntu/Debian
sudo apt-get install tmux

# Windows（通过 WSL）
wsl --install
sudo apt-get install tmux
```

更完整的测试文档见 [cli/src/**tests**/README.md](cli/src/__tests__/README.md)。

可以帮忙的方向：

- 🐛 **修 bug** 或新增功能
- 🤖 **打造专用智能体**并分享可复用的本地模板
- 📚 **完善文档**或撰写教程
- 💡 **分享想法**：在 [GitHub Issues](https://github.com/AnzoBenjamin/openbuff/issues) 留言

## 开始使用

### 安装

**CLI**：`npm install -g @openbuff/cli`

**SDK**：`npm install @openbuff/sdk`

### 资源

**文档**：参见 [docs/](./docs) 目录和 [AGENTS.md](./AGENTS.md)

**社区与支持**：[GitHub Issues](https://github.com/AnzoBenjamin/openbuff/issues)

**贡献指南**：[CONTRIBUTING.md](./CONTRIBUTING.md) ——想贡献从这里开始！

## Star 历史

[![Star History Chart](https://api.star-history.com/svg?repos=AnzoBenjamin/openbuff&type=Date)](https://www.star-history.com/#AnzoBenjamin/openbuff&Date)
