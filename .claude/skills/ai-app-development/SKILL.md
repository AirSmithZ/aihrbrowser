---
name: ai-app-development
description: Comprehensive guide for building AI applications including RAG (Retrieval-Augmented Generation), skill development, function calling, LangChain integration, and other modern AI development patterns. Use when building AI-powered applications, implementing RAG systems, creating custom skills/tools, integrating function calling capabilities, working with LangChain or similar frameworks, or developing agent-based systems.
---

# AI 应用开发

## 概述

本 skill 提供构建现代 AI 应用的完整指南，涵盖 RAG、技能开发、函数调用、LangChain 集成等核心技术。适用于从简单的 AI 助手到复杂的多智能体系统的开发。

## 核心能力

### 1. RAG (检索增强生成)

RAG 系统通过结合检索和生成能力，让 AI 应用能够访问外部知识库。

**基本架构：**
- 文档加载与分块
- 向量化与嵌入
- 向量数据库存储
- 检索与重排序
- 上下文注入与生成

**实现要点：**
- 选择合适的嵌入模型（OpenAI, Cohere, 本地模型）
- 分块策略（固定大小、语义分块、层次化分块）
- 检索策略（相似度搜索、混合搜索、重排序）
- 上下文窗口管理

详细实现指南见 [references/rag.md](references/rag.md)

### 2. Skill/Tool 开发

创建可复用的技能和工具，扩展 AI 应用的能力边界。

**设计原则：**
- 单一职责：每个 skill 专注一个领域
- 接口标准化：统一的输入输出格式
- 可组合性：skill 之间可以组合使用
- 错误处理：优雅的失败处理机制

**实现模式：**
- 函数式 skill：简单的函数包装
- 类式 skill：复杂的状态管理
- 异步 skill：支持并发操作
- 流式 skill：支持流式输出

详细指南见 [references/skill-development.md](references/skill-development.md)

### 3. Function Calling

实现结构化工具调用，让 AI 能够执行外部操作。

**核心概念：**
- 函数定义：描述函数签名和用途
- 函数选择：AI 根据需求选择函数
- 参数提取：从自然语言提取参数
- 执行与返回：执行函数并返回结果

**最佳实践：**
- 清晰的函数描述
- 完整的参数验证
- 错误处理与重试
- 成本与性能优化

详细指南见 [references/function-calling.md](references/function-calling.md)

### 4. LangChain 集成

使用 LangChain 构建复杂的 AI 应用链。

**核心组件：**
- **LLMs & Chat Models**: 语言模型接口
- **Prompts**: 提示词模板管理
- **Chains**: 组合多个组件
- **Agents**: 自主决策与工具使用
- **Memory**: 对话历史管理
- **Retrievers**: 文档检索器

**常见模式：**
- 简单链：线性处理流程
- 路由链：条件分支处理
- 代理链：工具调用与决策
- 自定义链：复杂业务逻辑

详细指南见 [references/langchain.md](references/langchain.md)

### 5. 其他重要技术

- **流式处理**: 实时响应生成
- **多模态支持**: 文本、图像、音频处理
- **缓存策略**: 减少 API 调用成本
- **监控与日志**: 应用性能追踪
- **安全与隐私**: 数据保护机制

## 快速开始

### RAG 系统示例

```python
from langchain.embeddings import OpenAIEmbeddings
from langchain.vectorstores import Chroma
from langchain.chains import RetrievalQA
from langchain.llms import OpenAI

# 1. 加载文档并分块
from langchain.document_loaders import TextLoader
loader = TextLoader("documents.txt")
documents = loader.load_and_split()

# 2. 创建向量存储
embeddings = OpenAIEmbeddings()
vectorstore = Chroma.from_documents(documents, embeddings)

# 3. 创建检索链
qa_chain = RetrievalQA.from_chain_type(
    llm=OpenAI(),
    retriever=vectorstore.as_retriever()
)

# 4. 查询
result = qa_chain.run("你的问题")
```

### Function Calling 示例

```python
import openai

# 定义函数
functions = [
    {
        "name": "get_weather",
        "description": "获取指定城市的天气信息",
        "parameters": {
            "type": "object",
            "properties": {
                "city": {"type": "string", "description": "城市名称"},
                "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}
            },
            "required": ["city"]
        }
    }
]

# 调用 API
response = openai.ChatCompletion.create(
    model="gpt-4",
    messages=[{"role": "user", "content": "北京今天天气怎么样？"}],
    functions=functions,
    function_call="auto"
)
```

### LangChain Agent 示例

```python
from langchain.agents import initialize_agent, Tool
from langchain.llms import OpenAI

# 定义工具
tools = [
    Tool(
        name="搜索",
        func=search_function,
        description="用于搜索最新信息"
    ),
    Tool(
        name="计算器",
        func=calculator,
        description="用于数学计算"
    )
]

# 创建代理
agent = initialize_agent(
    tools,
    OpenAI(temperature=0),
    agent="zero-shot-react-description",
    verbose=True
)

# 使用代理
agent.run("计算 123 * 456，然后搜索这个结果的相关信息")
```

## 工作流程

### 开发新 AI 应用的步骤

1. **需求分析**
   - 确定应用类型（问答、对话、分析等）
   - 识别所需能力（检索、工具调用、多模态等）
   - 评估技术栈选择

2. **架构设计**
   - 选择核心框架（LangChain、LlamaIndex、自定义）
   - 设计数据流（输入 → 处理 → 输出）
   - 规划组件交互

3. **实现核心功能**
   - 实现 RAG（如需要）
   - 开发自定义 skill/tool
   - 集成 function calling
   - 构建处理链

4. **优化与测试**
   - 性能优化（缓存、批处理）
   - 成本优化（模型选择、调用策略）
   - 错误处理与边界测试

5. **部署与监控**
   - 部署到生产环境
   - 设置监控与日志
   - 持续优化

## 参考资料

详细的实现指南和最佳实践请参考：

- **[RAG 实现指南](references/rag.md)**: RAG 系统的详细实现
- **[Skill 开发指南](references/skill-development.md)**: 如何开发可复用的技能
- **[Function Calling 指南](references/function-calling.md)**: 函数调用的完整实现
- **[LangChain 指南](references/langchain.md)**: LangChain 框架的深入使用
- **[最佳实践](references/best-practices.md)**: 性能、安全、成本优化建议

## 脚本工具

`scripts/` 目录包含可执行的辅助脚本：

- `setup_rag.py`: 快速搭建 RAG 系统
- `create_skill_template.py`: 生成 skill 模板代码
- `test_function_calling.py`: 测试 function calling 实现

## 资源

### scripts/
可执行的 Python 脚本，用于自动化常见任务。

### references/
详细的参考文档，包含实现细节、API 参考和最佳实践。

### assets/
模板代码和示例项目，可直接使用或作为起点。
