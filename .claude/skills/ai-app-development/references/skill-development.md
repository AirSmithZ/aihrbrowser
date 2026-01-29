# Skill/Tool 开发指南

## 概述

Skill 是可复用的功能模块，扩展 AI 应用的能力。良好的 skill 设计应该遵循单一职责、接口标准化、可组合性原则。

## Skill 类型

### 1. 函数式 Skill

最简单的 skill 形式，纯函数实现。

```python
def get_weather(city: str, unit: str = "celsius") -> dict:
    """
    获取指定城市的天气信息
    
    Args:
        city: 城市名称
        unit: 温度单位 (celsius/fahrenheit)
    
    Returns:
        包含天气信息的字典
    """
    # 实现逻辑
    return {
        "city": city,
        "temperature": 25,
        "unit": unit,
        "condition": "sunny"
    }
```

### 2. 类式 Skill

需要状态管理或复杂配置的 skill。

```python
class DatabaseSkill:
    """数据库操作 Skill"""
    
    def __init__(self, connection_string: str):
        self.conn = self._connect(connection_string)
    
    def query(self, sql: str, params: dict = None) -> list:
        """执行 SQL 查询"""
        cursor = self.conn.cursor()
        cursor.execute(sql, params or {})
        return cursor.fetchall()
    
    def execute(self, sql: str, params: dict = None) -> int:
        """执行 SQL 更新"""
        cursor = self.conn.cursor()
        cursor.execute(sql, params or {})
        self.conn.commit()
        return cursor.rowcount
    
    def _connect(self, connection_string: str):
        # 连接逻辑
        pass
```

### 3. 异步 Skill

支持并发操作的 skill。

```python
import asyncio
import aiohttp

class AsyncAPISkill:
    """异步 API 调用 Skill"""
    
    async def fetch_data(self, url: str) -> dict:
        """异步获取数据"""
        async with aiohttp.ClientSession() as session:
            async with session.get(url) as response:
                return await response.json()
    
    async def fetch_multiple(self, urls: list) -> list:
        """并发获取多个 URL"""
        tasks = [self.fetch_data(url) for url in urls]
        return await asyncio.gather(*tasks)
```

### 4. 流式 Skill

支持流式输出的 skill。

```python
def stream_processing(data: list):
    """流式处理数据"""
    for item in data:
        result = process_item(item)
        yield result
```

## Skill 设计模式

### 装饰器模式

使用装饰器统一处理错误、日志、验证等。

```python
from functools import wraps

def skill_decorator(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
        try:
            # 参数验证
            validate_args(args, kwargs)
            
            # 执行函数
            result = func(*args, **kwargs)
            
            # 日志记录
            log_execution(func.__name__, args, kwargs, result)
            
            return result
        except Exception as e:
            log_error(func.__name__, e)
            raise
    
    return wrapper

@skill_decorator
def my_skill(param: str) -> str:
    return f"Processed: {param}"
```

### 工厂模式

动态创建 skill 实例。

```python
class SkillFactory:
    """Skill 工厂"""
    
    _skills = {}
    
    @classmethod
    def register(cls, name: str, skill_class):
        cls._skills[name] = skill_class
    
    @classmethod
    def create(cls, name: str, **kwargs):
        if name not in cls._skills:
            raise ValueError(f"Unknown skill: {name}")
        return cls._skills[name](**kwargs)

# 注册 skill
SkillFactory.register("weather", WeatherSkill)
SkillFactory.register("database", DatabaseSkill)

# 创建 skill
weather = SkillFactory.create("weather", api_key="xxx")
```

### 策略模式

可替换的算法实现。

```python
class SearchStrategy:
    """搜索策略接口"""
    def search(self, query: str) -> list:
        raise NotImplementedError

class VectorSearch(SearchStrategy):
    def search(self, query: str) -> list:
        # 向量搜索实现
        pass

class KeywordSearch(SearchStrategy):
    def search(self, query: str) -> list:
        # 关键词搜索实现
        pass

class SearchSkill:
    def __init__(self, strategy: SearchStrategy):
        self.strategy = strategy
    
    def search(self, query: str) -> list:
        return self.strategy.search(query)
```

## Skill 注册与管理

### LangChain Tool 集成

```python
from langchain.tools import Tool

def get_weather_tool():
    return Tool(
        name="get_weather",
        description="获取指定城市的天气信息",
        func=get_weather
    )

# 使用
tools = [get_weather_tool()]
agent = initialize_agent(tools, llm, agent="zero-shot-react-description")
```

### 自定义 Tool 类

```python
from langchain.tools import BaseTool
from typing import Optional

class WeatherTool(BaseTool):
    name = "get_weather"
    description = "获取指定城市的天气信息"
    
    def _run(self, city: str, unit: str = "celsius") -> str:
        result = get_weather(city, unit)
        return f"{city} 当前温度: {result['temperature']}°{unit}"
    
    async def _arun(self, city: str, unit: str = "celsius") -> str:
        # 异步实现
        pass
```

### Skill 注册表

```python
class SkillRegistry:
    """Skill 注册表"""
    
    def __init__(self):
        self._skills = {}
    
    def register(self, name: str, skill, metadata: dict = None):
        """注册 skill"""
        self._skills[name] = {
            "skill": skill,
            "metadata": metadata or {}
        }
    
    def get(self, name: str):
        """获取 skill"""
        if name not in self._skills:
            raise ValueError(f"Skill '{name}' not found")
        return self._skills[name]["skill"]
    
    def list(self) -> list:
        """列出所有 skill"""
        return list(self._skills.keys())
    
    def get_metadata(self, name: str) -> dict:
        """获取 skill 元数据"""
        if name not in self._skills:
            raise ValueError(f"Skill '{name}' not found")
        return self._skills[name]["metadata"]

# 使用
registry = SkillRegistry()
registry.register("weather", get_weather, {"version": "1.0", "author": "AI Team"})
weather_skill = registry.get("weather")
```

## 错误处理

### 统一错误处理

```python
class SkillError(Exception):
    """Skill 基础错误类"""
    pass

class SkillExecutionError(SkillError):
    """Skill 执行错误"""
    pass

class SkillValidationError(SkillError):
    """Skill 参数验证错误"""
    pass

def safe_execute(skill_func):
    """安全执行 skill"""
    @wraps(skill_func)
    def wrapper(*args, **kwargs):
        try:
            return skill_func(*args, **kwargs)
        except SkillValidationError as e:
            return {"error": "validation_error", "message": str(e)}
        except SkillExecutionError as e:
            return {"error": "execution_error", "message": str(e)}
        except Exception as e:
            return {"error": "unknown_error", "message": str(e)}
    return wrapper
```

### 重试机制

```python
from tenacity import retry, stop_after_attempt, wait_exponential

@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=4, max=10)
)
def unreliable_skill(param: str):
    # 可能失败的 skill
    pass
```

## 测试

### 单元测试

```python
import unittest

class TestWeatherSkill(unittest.TestCase):
    def setUp(self):
        self.skill = WeatherSkill(api_key="test-key")
    
    def test_get_weather_success(self):
        result = self.skill.get_weather("北京")
        self.assertIn("temperature", result)
        self.assertIn("condition", result)
    
    def test_get_weather_invalid_city(self):
        with self.assertRaises(ValueError):
            self.skill.get_weather("")
```

### Mock 测试

```python
from unittest.mock import patch, MagicMock

@patch('weather_api.get_weather_data')
def test_weather_skill_mock(mock_api):
    mock_api.return_value = {"temp": 25, "condition": "sunny"}
    
    skill = WeatherSkill()
    result = skill.get_weather("北京")
    
    assert result["temperature"] == 25
    mock_api.assert_called_once_with("北京")
```

## 最佳实践

1. **单一职责**: 每个 skill 只做一件事
2. **接口标准化**: 统一的输入输出格式
3. **文档完整**: 清晰的 docstring 和类型注解
4. **错误处理**: 优雅的错误处理和用户友好的错误信息
5. **可测试性**: 易于单元测试和集成测试
6. **可配置性**: 通过配置而非硬编码
7. **性能考虑**: 缓存、批处理、异步处理
8. **安全性**: 输入验证、权限控制、敏感数据保护
