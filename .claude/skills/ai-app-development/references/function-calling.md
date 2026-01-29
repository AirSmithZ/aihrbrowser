# Function Calling 实现指南

## 概述

Function Calling 允许 AI 模型调用外部函数，实现结构化工具使用。这是构建 AI 应用的核心能力之一。

## 基本概念

### 函数定义

函数定义描述函数的名称、描述和参数结构。

```python
functions = [
    {
        "name": "get_weather",
        "description": "获取指定城市的当前天气信息",
        "parameters": {
            "type": "object",
            "properties": {
                "city": {
                    "type": "string",
                    "description": "城市名称，例如：北京、上海"
                },
                "unit": {
                    "type": "string",
                    "enum": ["celsius", "fahrenheit"],
                    "description": "温度单位"
                }
            },
            "required": ["city"]
        }
    }
]
```

### 函数调用流程

1. **用户请求**: 用户发送自然语言请求
2. **模型决策**: AI 模型决定是否需要调用函数
3. **参数提取**: 模型从请求中提取函数参数
4. **函数执行**: 执行实际函数
5. **结果返回**: 将结果返回给模型
6. **最终响应**: 模型生成最终回复

## OpenAI Function Calling

### 基本使用

```python
import openai
import json

# 定义函数
functions = [
    {
        "name": "get_weather",
        "description": "获取天气信息",
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

# 实际函数实现
def get_weather(city: str, unit: str = "celsius") -> dict:
    # 实际实现
    return {"city": city, "temperature": 25, "unit": unit}

# 调用 API
response = openai.ChatCompletion.create(
    model="gpt-4",
    messages=[{"role": "user", "content": "北京今天天气怎么样？"}],
    functions=functions,
    function_call="auto"  # 或 "none" 或 {"name": "get_weather"}
)

# 处理响应
message = response.choices[0].message

if message.get("function_call"):
    # 提取函数调用信息
    function_name = message["function_call"]["name"]
    function_args = json.loads(message["function_call"]["arguments"])
    
    # 执行函数
    function_response = get_weather(**function_args)
    
    # 将结果返回给模型
    messages.append(message)
    messages.append({
        "role": "function",
        "name": function_name,
        "content": json.dumps(function_response)
    })
    
    # 获取最终响应
    final_response = openai.ChatCompletion.create(
        model="gpt-4",
        messages=messages
    )
else:
    # 直接回复
    print(message["content"])
```

### 完整示例

```python
import openai
import json

class FunctionCallingAgent:
    def __init__(self, api_key: str):
        openai.api_key = api_key
        self.functions = self._define_functions()
        self.function_map = {
            "get_weather": self._get_weather,
            "calculate": self._calculate,
            "search": self._search
        }
    
    def _define_functions(self):
        return [
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
            },
            {
                "name": "calculate",
                "description": "执行数学计算",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "expression": {"type": "string", "description": "数学表达式"}
                    },
                    "required": ["expression"]
                }
            },
            {
                "name": "search",
                "description": "搜索信息",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "搜索查询"},
                        "limit": {"type": "integer", "description": "结果数量限制"}
                    },
                    "required": ["query"]
                }
            }
        ]
    
    def _get_weather(self, city: str, unit: str = "celsius") -> dict:
        # 实际实现
        return {"city": city, "temperature": 25, "unit": unit}
    
    def _calculate(self, expression: str) -> float:
        # 安全计算
        try:
            return eval(expression)
        except:
            return None
    
    def _search(self, query: str, limit: int = 5) -> list:
        # 实际搜索实现
        return [f"Result {i} for {query}" for i in range(limit)]
    
    def chat(self, user_message: str, conversation_history: list = None) -> str:
        messages = conversation_history or []
        messages.append({"role": "user", "content": user_message})
        
        max_iterations = 10
        iteration = 0
        
        while iteration < max_iterations:
            response = openai.ChatCompletion.create(
                model="gpt-4",
                messages=messages,
                functions=self.functions,
                function_call="auto"
            )
            
            message = response.choices[0].message
            messages.append(message)
            
            # 检查是否需要调用函数
            if message.get("function_call"):
                function_name = message["function_call"]["name"]
                function_args = json.loads(message["function_call"]["arguments"])
                
                # 执行函数
                function_result = self.function_map[function_name](**function_args)
                
                # 添加函数结果到消息
                messages.append({
                    "role": "function",
                    "name": function_name,
                    "content": json.dumps(function_result)
                })
                
                iteration += 1
            else:
                # 返回最终回复
                return message["content"]
        
        return "达到最大迭代次数"
```

## LangChain Function Calling

### Tool 定义

```python
from langchain.tools import Tool
from langchain.llms import OpenAI
from langchain.agents import initialize_agent

# 定义工具
def get_weather(city: str) -> str:
    return f"{city} 的天气是晴天，25°C"

weather_tool = Tool(
    name="get_weather",
    description="获取指定城市的天气信息。输入应该是城市名称。",
    func=get_weather
)

# 创建代理
agent = initialize_agent(
    [weather_tool],
    OpenAI(temperature=0),
    agent="zero-shot-react-description",
    verbose=True
)

# 使用
result = agent.run("北京今天天气怎么样？")
```

### 自定义 Tool

```python
from langchain.tools import BaseTool
from typing import Optional

class WeatherTool(BaseTool):
    name = "get_weather"
    description = "获取指定城市的天气信息。输入应该是城市名称。"
    
    def _run(self, city: str) -> str:
        # 同步实现
        return f"{city} 的天气是晴天，25°C"
    
    async def _arun(self, city: str) -> str:
        # 异步实现
        return f"{city} 的天气是晴天，25°C"
```

### Structured Tool

```python
from langchain.tools import StructuredTool
from pydantic import BaseModel, Field

class WeatherInput(BaseModel):
    city: str = Field(description="城市名称")
    unit: str = Field(default="celsius", description="温度单位")

def get_weather(city: str, unit: str = "celsius") -> str:
    return f"{city} 的温度是 25°{unit}"

weather_tool = StructuredTool.from_function(
    func=get_weather,
    name="get_weather",
    description="获取天气信息",
    args_schema=WeatherInput
)
```

## 最佳实践

### 1. 清晰的函数描述

```python
# 好的描述
{
    "name": "get_weather",
    "description": "获取指定城市的当前天气信息，包括温度、湿度、天气状况等。",
    "parameters": {
        "type": "object",
        "properties": {
            "city": {
                "type": "string",
                "description": "城市名称，使用中文或英文名称，例如：北京、Shanghai"
            }
        }
    }
}

# 不好的描述
{
    "name": "get_weather",
    "description": "获取天气",
    "parameters": {
        "type": "object",
        "properties": {
            "city": {"type": "string"}
        }
    }
}
```

### 2. 参数验证

```python
def get_weather(city: str, unit: str = "celsius") -> dict:
    # 参数验证
    if not city or not isinstance(city, str):
        raise ValueError("城市名称不能为空")
    
    if unit not in ["celsius", "fahrenheit"]:
        raise ValueError("温度单位必须是 celsius 或 fahrenheit")
    
    # 实际实现
    return {"city": city, "temperature": 25, "unit": unit}
```

### 3. 错误处理

```python
def safe_function_call(func, *args, **kwargs):
    try:
        return func(*args, **kwargs)
    except ValueError as e:
        return {"error": "validation_error", "message": str(e)}
    except Exception as e:
        return {"error": "execution_error", "message": str(e)}
```

### 4. 函数选择策略

```python
# 强制调用特定函数
response = openai.ChatCompletion.create(
    model="gpt-4",
    messages=messages,
    functions=functions,
    function_call={"name": "get_weather"}  # 强制调用
)

# 禁止函数调用
response = openai.ChatCompletion.create(
    model="gpt-4",
    messages=messages,
    functions=functions,
    function_call="none"  # 禁止调用
)
```

### 5. 多函数调用

```python
# 模型可以决定调用多个函数
response = openai.ChatCompletion.create(
    model="gpt-4",
    messages=messages,
    functions=functions,
    function_call="auto"  # 自动决定
)

# 处理多个函数调用
message = response.choices[0].message
if message.get("function_call"):
    # 单个函数调用
    pass
elif isinstance(message.get("function_calls"), list):
    # 多个函数调用（某些模型支持）
    for func_call in message["function_calls"]:
        # 处理每个调用
        pass
```

## 性能优化

### 缓存函数结果

```python
from functools import lru_cache

@lru_cache(maxsize=100)
def get_weather(city: str, unit: str = "celsius") -> dict:
    # 实现
    pass
```

### 批量处理

```python
def batch_get_weather(cities: list) -> list:
    # 批量获取天气
    results = []
    for city in cities:
        results.append(get_weather(city))
    return results
```

### 异步执行

```python
import asyncio

async def async_get_weather(city: str) -> dict:
    # 异步实现
    pass

async def batch_async_get_weather(cities: list) -> list:
    tasks = [async_get_weather(city) for city in cities]
    return await asyncio.gather(*tasks)
```

## 安全考虑

1. **输入验证**: 严格验证所有输入参数
2. **权限控制**: 检查函数调用权限
3. **资源限制**: 限制函数执行时间和资源使用
4. **敏感数据**: 避免在函数中暴露敏感信息
5. **错误信息**: 不要泄露内部实现细节
