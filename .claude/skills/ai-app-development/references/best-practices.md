# AI 应用开发最佳实践

## 性能优化

### 1. 缓存策略

**LLM 响应缓存:**
```python
from langchain.cache import InMemoryCache
from langchain.globals import set_llm_cache

set_llm_cache(InMemoryCache())

# 或使用 Redis 缓存
from langchain.cache import RedisCache
import redis

redis_client = redis.Redis()
set_llm_cache(RedisCache(redis_client))
```

**嵌入缓存:**
```python
from functools import lru_cache

@lru_cache(maxsize=1000)
def get_embedding(text: str) -> list:
    return embeddings.embed_query(text)
```

### 2. 批处理

**批量嵌入:**
```python
# 单个嵌入（慢）
embeddings = [embeddings.embed_query(text) for text in texts]

# 批量嵌入（快）
embeddings = embeddings.embed_documents(texts)
```

**批量 LLM 调用:**
```python
from langchain.llms import OpenAI

llm = OpenAI()
# 批量生成
results = llm.generate([prompt1, prompt2, prompt3])
```

### 3. 异步处理

```python
import asyncio
from langchain.llms import OpenAI

async def async_llm_call(prompt: str):
    llm = OpenAI()
    return await llm.agenerate([prompt])

# 并发执行
tasks = [async_llm_call(prompt) for prompt in prompts]
results = await asyncio.gather(*tasks)
```

### 4. 流式处理

```python
from langchain.callbacks.streaming_stdout import StreamingStdOutCallbackHandler

llm = OpenAI(
    streaming=True,
    callbacks=[StreamingStdOutCallbackHandler()]
)

for chunk in llm.stream("你的问题"):
    print(chunk, end="")
```

## 成本优化

### 1. 模型选择

```python
# 根据任务复杂度选择模型
# 简单任务：使用较小的模型
simple_llm = OpenAI(model="gpt-3.5-turbo")

# 复杂任务：使用较大的模型
complex_llm = OpenAI(model="gpt-4")
```

### 2. Token 管理

```python
from langchain.callbacks import get_openai_callback

with get_openai_callback() as cb:
    result = llm("你的问题")
    print(f"总 tokens: {cb.total_tokens}")
    print(f"总成本: ${cb.total_cost}")
```

### 3. 上下文窗口优化

```python
# 只保留必要的上下文
from langchain.memory import ConversationSummaryMemory

memory = ConversationSummaryMemory(llm=llm)
# 自动总结旧对话，减少 token 使用
```

### 4. 缓存重复查询

```python
# 缓存常见查询
cache = {}

def cached_llm_call(query: str):
    if query in cache:
        return cache[query]
    result = llm(query)
    cache[query] = result
    return result
```

## 安全与隐私

### 1. 输入验证

```python
def validate_input(user_input: str) -> bool:
    # 检查长度
    if len(user_input) > 10000:
        return False
    
    # 检查恶意内容
    malicious_patterns = ["<script>", "DROP TABLE", "DELETE FROM"]
    for pattern in malicious_patterns:
        if pattern in user_input.upper():
            return False
    
    return True
```

### 2. 敏感数据过滤

```python
import re

def filter_sensitive_data(text: str) -> str:
    # 移除邮箱
    text = re.sub(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b', '[EMAIL]', text)
    
    # 移除手机号
    text = re.sub(r'\b\d{11}\b', '[PHONE]', text)
    
    # 移除身份证号
    text = re.sub(r'\b\d{18}\b', '[ID]', text)
    
    return text
```

### 3. 权限控制

```python
class SecureLLMChain:
    def __init__(self, user_role: str):
        self.user_role = user_role
        self.allowed_roles = ["admin", "user"]
    
    def run(self, input_text: str):
        if self.user_role not in self.allowed_roles:
            raise PermissionError("无权限访问")
        
        # 执行 LLM 调用
        return llm(input_text)
```

### 4. API 密钥管理

```python
import os
from dotenv import load_dotenv

load_dotenv()

# 从环境变量读取
api_key = os.getenv("OPENAI_API_KEY")

# 不要硬编码密钥
# ❌ api_key = "sk-..."
```

## 错误处理

### 1. 重试机制

```python
from tenacity import retry, stop_after_attempt, wait_exponential

@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=4, max=10)
)
def llm_call_with_retry(prompt: str):
    return llm(prompt)
```

### 2. 优雅降级

```python
def robust_llm_call(prompt: str):
    try:
        # 尝试使用 GPT-4
        return gpt4_llm(prompt)
    except Exception as e:
        print(f"GPT-4 失败: {e}")
        try:
            # 降级到 GPT-3.5
            return gpt35_llm(prompt)
        except Exception as e:
            print(f"GPT-3.5 失败: {e}")
            # 返回默认响应
            return "抱歉，服务暂时不可用"
```

### 3. 超时控制

```python
import signal
from contextlib import contextmanager

@contextmanager
def timeout(seconds):
    def timeout_handler(signum, frame):
        raise TimeoutError("操作超时")
    
    signal.signal(signal.SIGALRM, timeout_handler)
    signal.alarm(seconds)
    try:
        yield
    finally:
        signal.alarm(0)

# 使用
try:
    with timeout(30):
        result = llm(prompt)
except TimeoutError:
    print("LLM 调用超时")
```

## 监控与日志

### 1. 日志记录

```python
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def logged_llm_call(prompt: str):
    logger.info(f"LLM 调用开始: {prompt[:50]}...")
    try:
        result = llm(prompt)
        logger.info("LLM 调用成功")
        return result
    except Exception as e:
        logger.error(f"LLM 调用失败: {e}")
        raise
```

### 2. 性能监控

```python
import time
from functools import wraps

def monitor_performance(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
        start_time = time.time()
        result = func(*args, **kwargs)
        end_time = time.time()
        print(f"{func.__name__} 执行时间: {end_time - start_time:.2f}秒")
        return result
    return wrapper

@monitor_performance
def llm_call(prompt: str):
    return llm(prompt)
```

### 3. 指标收集

```python
class MetricsCollector:
    def __init__(self):
        self.call_count = 0
        self.total_tokens = 0
        self.total_cost = 0
    
    def record_call(self, tokens: int, cost: float):
        self.call_count += 1
        self.total_tokens += tokens
        self.total_cost += cost
    
    def get_stats(self):
        return {
            "call_count": self.call_count,
            "total_tokens": self.total_tokens,
            "total_cost": self.total_cost,
            "avg_tokens": self.total_tokens / self.call_count if self.call_count > 0 else 0
        }
```

## 测试

### 1. 单元测试

```python
import unittest
from unittest.mock import patch, MagicMock

class TestLLMChain(unittest.TestCase):
    @patch('langchain.llms.OpenAI')
    def test_chain_execution(self, mock_llm):
        mock_llm.return_value.generate.return_value = ["测试响应"]
        
        chain = LLMChain(llm=mock_llm(), prompt=prompt)
        result = chain.run("测试输入")
        
        self.assertEqual(result, "测试响应")
```

### 2. 集成测试

```python
def test_rag_system():
    # 设置测试数据
    documents = ["文档1", "文档2", "文档3"]
    
    # 创建 RAG 系统
    vectorstore = create_vectorstore(documents)
    qa_chain = create_qa_chain(vectorstore)
    
    # 测试查询
    result = qa_chain.run("测试问题")
    
    # 验证结果
    assert "相关" in result.lower()
```

### 3. 端到端测试

```python
def test_end_to_end():
    # 模拟用户交互
    user_input = "北京天气怎么样？"
    
    # 执行完整流程
    response = agent.run(user_input)
    
    # 验证响应
    assert len(response) > 0
    assert "天气" in response or "temperature" in response.lower()
```

## 部署

### 1. 容器化

```dockerfile
FROM python:3.9

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

CMD ["python", "app.py"]
```

### 2. 环境配置

```python
# config.py
import os

class Config:
    OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
    MODEL_NAME = os.getenv("MODEL_NAME", "gpt-3.5-turbo")
    TEMPERATURE = float(os.getenv("TEMPERATURE", "0.7"))
    MAX_TOKENS = int(os.getenv("MAX_TOKENS", "1000"))
```

### 3. 健康检查

```python
from flask import Flask, jsonify

app = Flask(__name__)

@app.route("/health")
def health_check():
    return jsonify({
        "status": "healthy",
        "llm_available": check_llm_connection()
    })
```

## 总结

遵循这些最佳实践可以构建出高性能、安全、可靠的 AI 应用：

1. **性能**: 缓存、批处理、异步处理
2. **成本**: 模型选择、token 管理、上下文优化
3. **安全**: 输入验证、数据过滤、权限控制
4. **可靠性**: 错误处理、重试、超时控制
5. **可观测性**: 日志、监控、指标收集
6. **质量**: 测试、验证、持续改进
