# RAG (检索增强生成) 实现指南

## 概述

RAG 通过结合信息检索和生成能力，让 AI 应用能够访问外部知识库，生成基于事实的响应。

## 架构组件

### 1. 文档加载

**支持的文档类型：**
- 文本文件 (.txt, .md)
- PDF 文档
- Word 文档 (.docx)
- 网页内容
- 数据库记录
- API 响应

**LangChain 加载器示例：**
```python
from langchain.document_loaders import (
    TextLoader,
    PyPDFLoader,
    Docx2txtLoader,
    WebBaseLoader
)

# 文本文件
loader = TextLoader("document.txt")
documents = loader.load()

# PDF
loader = PyPDFLoader("document.pdf")
documents = loader.load()

# 网页
loader = WebBaseLoader(["https://example.com"])
documents = loader.load()
```

### 2. 文档分块

**分块策略：**

**固定大小分块：**
```python
from langchain.text_splitter import RecursiveCharacterTextSplitter

splitter = RecursiveCharacterTextSplitter(
    chunk_size=1000,
    chunk_overlap=200,
    separators=["\n\n", "\n", " ", ""]
)
chunks = splitter.split_documents(documents)
```

**语义分块：**
```python
from langchain.text_splitter import SemanticChunker
from langchain.embeddings import OpenAIEmbeddings

embeddings = OpenAIEmbeddings()
splitter = SemanticChunker(embeddings, breakpoint_threshold_type="percentile")
chunks = splitter.split_documents(documents)
```

**层次化分块：**
```python
# 先按章节分，再按段落分
from langchain.text_splitter import RecursiveCharacterTextSplitter

chapter_splitter = RecursiveCharacterTextSplitter(
    chunk_size=5000,
    separators=["\n## ", "\n### "]
)
paragraph_splitter = RecursiveCharacterTextSplitter(
    chunk_size=1000,
    chunk_overlap=200
)
```

### 3. 向量化与嵌入

**嵌入模型选择：**

**OpenAI Embeddings:**
```python
from langchain.embeddings import OpenAIEmbeddings

embeddings = OpenAIEmbeddings(
    model="text-embedding-ada-002",
    openai_api_key="your-key"
)
```

**本地模型 (Sentence Transformers):**
```python
from langchain.embeddings import HuggingFaceEmbeddings

embeddings = HuggingFaceEmbeddings(
    model_name="sentence-transformers/all-MiniLM-L6-v2"
)
```

**Cohere Embeddings:**
```python
from langchain.embeddings import CohereEmbeddings

embeddings = CohereEmbeddings(cohere_api_key="your-key")
```

### 4. 向量数据库

**Chroma (本地):**
```python
from langchain.vectorstores import Chroma

vectorstore = Chroma.from_documents(
    documents=chunks,
    embedding=embeddings,
    persist_directory="./chroma_db"
)
```

**Pinecone (云端):**
```python
from langchain.vectorstores import Pinecone
import pinecone

pinecone.init(api_key="your-key", environment="us-east-1")
vectorstore = Pinecone.from_documents(
    chunks,
    embeddings,
    index_name="my-index"
)
```

**Weaviate:**
```python
from langchain.vectorstores import Weaviate
import weaviate

client = weaviate.Client("http://localhost:8080")
vectorstore = Weaviate.from_documents(
    chunks,
    embeddings,
    client=client
)
```

**FAISS (本地):**
```python
from langchain.vectorstores import FAISS

vectorstore = FAISS.from_documents(chunks, embeddings)
vectorstore.save_local("./faiss_index")
```

### 5. 检索策略

**基础相似度搜索：**
```python
retriever = vectorstore.as_retriever(
    search_kwargs={"k": 5}
)
docs = retriever.get_relevant_documents("查询问题")
```

**MMR (最大边际相关性) 检索：**
```python
retriever = vectorstore.as_retriever(
    search_type="mmr",
    search_kwargs={"k": 5, "fetch_k": 20}
)
```

**相似度阈值过滤：**
```python
retriever = vectorstore.as_retriever(
    search_kwargs={"k": 5, "score_threshold": 0.7}
)
```

**混合搜索 (关键词 + 向量):**
```python
from langchain.retrievers import BM25Retriever
from langchain.retrievers import EnsembleRetriever

# 关键词检索
bm25_retriever = BM25Retriever.from_documents(chunks)
bm25_retriever.k = 5

# 向量检索
vector_retriever = vectorstore.as_retriever(search_kwargs={"k": 5})

# 组合检索
ensemble_retriever = EnsembleRetriever(
    retrievers=[bm25_retriever, vector_retriever],
    weights=[0.5, 0.5]
)
```

### 6. 重排序

**使用 Cohere 重排序：**
```python
from langchain.retrievers import ContextualCompressionRetriever
from langchain.retrievers.document_compressors import CohereRerank

compressor = CohereRerank(cohere_api_key="your-key", top_n=3)
compression_retriever = ContextualCompressionRetriever(
    base_compressor=compressor,
    base_retriever=retriever
)
```

### 7. 构建 RAG 链

**简单 QA 链：**
```python
from langchain.chains import RetrievalQA
from langchain.llms import OpenAI

qa_chain = RetrievalQA.from_chain_type(
    llm=OpenAI(temperature=0),
    chain_type="stuff",
    retriever=retriever,
    return_source_documents=True
)

result = qa_chain({"query": "你的问题"})
```

**带对话历史的 QA 链：**
```python
from langchain.chains import ConversationalRetrievalChain
from langchain.memory import ConversationBufferMemory

memory = ConversationBufferMemory(
    memory_key="chat_history",
    return_messages=True
)

qa_chain = ConversationalRetrievalChain.from_llm(
    llm=OpenAI(temperature=0),
    retriever=retriever,
    memory=memory
)

result = qa_chain({"question": "你的问题"})
```

**Map-Reduce 链（处理长文档）：**
```python
qa_chain = RetrievalQA.from_chain_type(
    llm=OpenAI(),
    chain_type="map_reduce",
    retriever=retriever
)
```

**Refine 链（迭代优化）：**
```python
qa_chain = RetrievalQA.from_chain_type(
    llm=OpenAI(),
    chain_type="refine",
    retriever=retriever
)
```

## 高级特性

### 元数据过滤

```python
retriever = vectorstore.as_retriever(
    search_kwargs={
        "k": 5,
        "filter": {"source": "document.pdf", "page": 1}
    }
)
```

### 多查询检索

```python
from langchain.retrievers.multi_query import MultiQueryRetriever

retriever = MultiQueryRetriever.from_llm(
    retriever=vectorstore.as_retriever(),
    llm=OpenAI()
)
```

### 父文档检索

```python
from langchain.retrievers import ParentDocumentRetriever
from langchain.storage import InMemoryStore

store = InMemoryStore()
parent_splitter = RecursiveCharacterTextSplitter(chunk_size=2000)
child_splitter = RecursiveCharacterTextSplitter(chunk_size=400)

retriever = ParentDocumentRetriever(
    vectorstore=vectorstore,
    docstore=store,
    child_splitter=child_splitter,
    parent_splitter=parent_splitter
)
```

## 性能优化

### 缓存嵌入

```python
from langchain.cache import InMemoryCache
from langchain.globals import set_llm_cache

set_llm_cache(InMemoryCache())
```

### 批处理

```python
# 批量嵌入
embeddings.embed_documents(chunks)
```

### 异步处理

```python
import asyncio
from langchain.vectorstores import Chroma

async def async_retrieve():
    retriever = vectorstore.as_retriever()
    docs = await retriever.aget_relevant_documents("query")
```

## 最佳实践

1. **分块大小**: 根据模型上下文窗口和文档类型调整（通常 500-2000 tokens）
2. **重叠大小**: 设置 10-20% 的重叠以保持上下文连续性
3. **检索数量**: 根据任务复杂度选择（简单任务 3-5，复杂任务 5-10）
4. **嵌入模型**: 平衡质量、速度和成本
5. **元数据**: 添加来源、时间戳等元数据便于追踪
6. **评估**: 使用 RAGAS 等工具评估 RAG 系统质量
