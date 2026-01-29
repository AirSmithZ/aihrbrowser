# LangChain 集成指南

## 概述

LangChain 是一个用于构建 LLM 应用的框架，提供模块化组件和链式组合能力。

## 核心组件

### 1. LLMs & Chat Models

**LLM (文本补全):**
```python
from langchain.llms import OpenAI

llm = OpenAI(temperature=0.7)
response = llm("解释一下什么是机器学习")
```

**Chat Model (对话模型):**
```python
from langchain.chat_models import ChatOpenAI
from langchain.schema import HumanMessage, SystemMessage

chat = ChatOpenAI(temperature=0)
messages = [
    SystemMessage(content="你是一个有用的助手"),
    HumanMessage(content="解释一下什么是机器学习")
]
response = chat(messages)
```

**多模型支持:**
```python
# OpenAI
from langchain.chat_models import ChatOpenAI
chat = ChatOpenAI(model_name="gpt-4")

# Anthropic
from langchain.chat_models import ChatAnthropic
chat = ChatAnthropic(model="claude-2")

# 本地模型
from langchain.llms import HuggingFacePipeline
llm = HuggingFacePipeline.from_model_id(
    model_id="gpt2",
    task="text-generation"
)
```

### 2. Prompts

**PromptTemplate:**
```python
from langchain.prompts import PromptTemplate

template = "你是一个{role}，请用{style}的风格回答：{question}"
prompt = PromptTemplate(
    input_variables=["role", "style", "question"],
    template=template
)

formatted = prompt.format(
    role="数据科学家",
    style="专业",
    question="什么是深度学习？"
)
```

**ChatPromptTemplate:**
```python
from langchain.prompts import ChatPromptTemplate, SystemMessagePromptTemplate, HumanMessagePromptTemplate

system_template = "你是一个{role}"
system_prompt = SystemMessagePromptTemplate.from_template(system_template)

human_template = "{question}"
human_prompt = HumanMessagePromptTemplate.from_template(human_template)

chat_prompt = ChatPromptTemplate.from_messages([
    system_prompt,
    human_prompt
])

messages = chat_prompt.format_prompt(
    role="数据科学家",
    question="什么是深度学习？"
).to_messages()
```

**Few-shot Prompting:**
```python
from langchain.prompts import FewShotPromptTemplate, PromptTemplate

examples = [
    {"word": "happy", "antonym": "sad"},
    {"word": "tall", "antonym": "short"},
]

example_template = """
单词: {word}
反义词: {antonym}
"""

example_prompt = PromptTemplate(
    input_variables=["word", "antonym"],
    template=example_template
)

few_shot_prompt = FewShotPromptTemplate(
    examples=examples,
    example_prompt=example_prompt,
    prefix="给出每个单词的反义词",
    suffix="单词: {input}\n反义词:",
    input_variables=["input"],
)
```

### 3. Chains

**简单链:**
```python
from langchain.chains import LLMChain

prompt = PromptTemplate(
    input_variables=["product"],
    template="为以下产品写一个描述：{product}"
)

chain = LLMChain(llm=llm, prompt=prompt)
result = chain.run("智能手机")
```

**顺序链:**
```python
from langchain.chains import SimpleSequentialChain

# 第一个链：生成公司名称
first_prompt = PromptTemplate(
    input_variables=["product"],
    template="为生产 {product} 的公司起一个名字"
)
chain_one = LLMChain(llm=llm, prompt=first_prompt)

# 第二个链：写口号
second_prompt = PromptTemplate(
    input_variables=["company_name"],
    template="为 {company_name} 写一个口号"
)
chain_two = LLMChain(llm=llm, prompt=second_prompt)

# 组合链
overall_chain = SimpleSequentialChain(
    chains=[chain_one, chain_two],
    verbose=True
)
result = overall_chain.run("智能手机")
```

**路由链:**
```python
from langchain.chains import ConversationChain
from langchain.chains.router import MultiPromptChain
from langchain.chains.router.llm_router import LLMRouterChain, RouterOutputParser
from langchain.prompts import PromptTemplate

# 定义多个提示
physics_template = """你是一个物理专家。回答物理问题。
问题: {input}"""

math_template = """你是一个数学专家。回答数学问题。
问题: {input}"""

prompt_infos = [
    {
        "name": "physics",
        "description": "适合回答物理问题",
        "prompt_template": physics_template,
    },
    {
        "name": "math",
        "description": "适合回答数学问题",
        "prompt_template": math_template,
    },
]

# 创建路由链
chain = MultiPromptChain.from_prompts(llm, prompt_infos, verbose=True)
```

**自定义链:**
```python
from langchain.chains.base import Chain
from typing import Dict, List

class CustomChain(Chain):
    llm: OpenAI
    prompt: PromptTemplate
    
    @property
    def input_keys(self) -> List[str]:
        return ["input"]
    
    @property
    def output_keys(self) -> List[str]:
        return ["output"]
    
    def _call(self, inputs: Dict[str, str]) -> Dict[str, str]:
        prompt_value = self.prompt.format_prompt(**inputs)
        response = self.llm(prompt_value.to_string())
        return {"output": response}
```

### 4. Agents

**零样本 ReAct Agent:**
```python
from langchain.agents import initialize_agent, Tool
from langchain.llms import OpenAI

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

agent = initialize_agent(
    tools,
    OpenAI(temperature=0),
    agent="zero-shot-react-description",
    verbose=True
)

agent.run("计算 123 * 456，然后搜索这个结果的相关信息")
```

**ReAct 文档 Agent:**
```python
from langchain.agents import initialize_agent
from langchain.agents.react.base import ReActDocstoreAgent
from langchain import OpenAI, Wikipedia

tools = [
    Wikipedia()
]

agent = initialize_agent(
    tools,
    OpenAI(temperature=0),
    agent=ReActDocstoreAgent,
    verbose=True
)
```

**自定义 Agent:**
```python
from langchain.agents import Agent, AgentExecutor
from langchain.agents.mrkl.base import ZeroShotAgent

prompt = ZeroShotAgent.create_prompt(tools)
llm_chain = LLMChain(llm=llm, prompt=prompt)
agent = ZeroShotAgent(llm_chain=llm_chain, tools=tools)
agent_executor = AgentExecutor.from_agent_and_tools(
    agent=agent,
    tools=tools,
    verbose=True
)
```

### 5. Memory

**ConversationBufferMemory:**
```python
from langchain.memory import ConversationBufferMemory
from langchain.chains import ConversationChain

memory = ConversationBufferMemory()
conversation = ConversationChain(
    llm=llm,
    memory=memory,
    verbose=True
)

conversation.predict(input="你好，我叫张三")
conversation.predict(input="我的名字是什么？")
```

**ConversationBufferWindowMemory:**
```python
from langchain.memory import ConversationBufferWindowMemory

memory = ConversationBufferWindowMemory(k=2)  # 只保留最近 2 轮对话
```

**ConversationSummaryMemory:**
```python
from langchain.memory import ConversationSummaryMemory

memory = ConversationSummaryMemory(llm=llm)
```

**ConversationSummaryBufferMemory:**
```python
from langchain.memory import ConversationSummaryBufferMemory

memory = ConversationSummaryBufferMemory(
    llm=llm,
    max_token_limit=1000
)
```

**Entity Memory:**
```python
from langchain.memory import ConversationEntityMemory

memory = ConversationEntityMemory(llm=llm)
```

### 6. Retrievers

**向量存储检索器:**
```python
from langchain.vectorstores import Chroma
from langchain.embeddings import OpenAIEmbeddings

vectorstore = Chroma.from_documents(documents, embeddings)
retriever = vectorstore.as_retriever()
```

**自定义检索器:**
```python
from langchain.schema import BaseRetriever, Document
from typing import List

class CustomRetriever(BaseRetriever):
    def get_relevant_documents(self, query: str) -> List[Document]:
        # 自定义检索逻辑
        return [Document(page_content="相关文档内容")]
    
    async def aget_relevant_documents(self, query: str) -> List[Document]:
        # 异步检索
        return [Document(page_content="相关文档内容")]
```

## 高级特性

### 流式处理

```python
from langchain.callbacks.streaming_stdout import StreamingStdOutCallbackHandler

llm = OpenAI(
    streaming=True,
    callbacks=[StreamingStdOutCallbackHandler()],
    temperature=0.7
)
```

### 回调系统

```python
from langchain.callbacks import BaseCallbackHandler

class CustomCallbackHandler(BaseCallbackHandler):
    def on_llm_start(self, serialized, prompts, **kwargs):
        print("LLM 开始")
    
    def on_llm_end(self, response, **kwargs):
        print("LLM 结束")
    
    def on_llm_error(self, error, **kwargs):
        print(f"LLM 错误: {error}")

handler = CustomCallbackHandler()
chain.run("输入", callbacks=[handler])
```

### 链式组合

```python
from langchain.chains import LLMChain, SimpleSequentialChain

# 创建多个链
chain1 = LLMChain(llm=llm, prompt=prompt1)
chain2 = LLMChain(llm=llm, prompt=prompt2)
chain3 = LLMChain(llm=llm, prompt=prompt3)

# 顺序组合
sequential_chain = SimpleSequentialChain(
    chains=[chain1, chain2, chain3]
)
```

### 并行执行

```python
from langchain.chains import LLMChain, TransformChain
from langchain.chains.parallel import ParallelChain

chain1 = LLMChain(llm=llm, prompt=prompt1, output_key="output1")
chain2 = LLMChain(llm=llm, prompt=prompt2, output_key="output2")

parallel_chain = ParallelChain(
    chains=[chain1, chain2],
    input_variables=["input"],
    output_variables=["output1", "output2"]
)
```

## 最佳实践

1. **模块化设计**: 将复杂流程拆分为多个链
2. **错误处理**: 为每个链添加错误处理
3. **性能优化**: 使用缓存、批处理、异步处理
4. **可观测性**: 添加日志和监控
5. **测试**: 为每个组件编写单元测试
