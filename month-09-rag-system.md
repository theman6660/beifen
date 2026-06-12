# 第9个月：RAG系统构建（检索增强生成）

---

## 1. 本月目标

截至2026年，大语言模型的能力已经令人惊叹，但两个根本缺陷始终存在：**知识截止日期**和**幻觉**。GPT-4o、Claude 4、DeepSeek V4等模型的知识截止于训练完成之日，无法知晓你的私有文档、最新论文或内部数据库。更严重的是，当模型遇到不知道的问题时，它会"编造"答案——这就是幻觉。

**检索增强生成（Retrieval-Augmented Generation, RAG）** 是当前最实用的解决方案。它的核心思想非常简单：让LLM在回答前先"查资料"。具体来说，RAG系统接收用户问题后，先从知识库中检索相关片段，再将问题和检索结果一起送入LLM生成答案。这相当于给LLM配了一本可以实时查阅的百科全书。

本月的目标是让你**独立构建生产可用的RAG系统**。你将亲手走完从文档加载、分块、向量化到检索生成的全流程，理解LangChain和LlamaIndex两大框架的设计哲学，完成三个可落地的实战项目。到月底，你将能够把任何私有知识库——技术文档、产品手册、研究论文、聊天记录——接入LLM，构建出"知道就知道，不知道就说不知道"的可靠问答系统。

---

## 2. 每周详细安排

### 第1周：RAG流水线全景与文档加载

RAG的水管可以拆成五段：**文档加载 → 文档分块 → Embedding向量化 → 向量存储 → 检索生成**。本周先走通最基础的流水线，重点在"吃进文档"这一步。

#### 第1天：RAG架构全景

动手前，先在脑中建立完整的地图。画一张架构图，包含以下节点和箭头：

```
[源文档] → [文档加载器] → [分块器] → [Embedding模型] → [向量数据库]
                                                                     ↑
[用户提问] → [查询重写/扩展] → [Query Embedding] → [相似度检索] → [重排序]
                                                                     ↓
[生成答案] ← [LLM] ← [增强Prompt(上下文+问题)]
```

RAG的变体很多，但核心就这三个步骤：

1. **索引（Indexing）**：将文档切块、向量化、存入数据库。这一步是离线完成的，建好索引后复用。
2. **检索（Retrieval）**：用户提问时，将问题编码为向量，在数据库中搜索最相似的文档块。
3. **生成（Generation）**：将检索到的文档块作为上下文，连同问题一起拼接成Prompt送给LLM。

安装本周所需依赖：

```bash
pip install langchain langchain-community langchain-openai chromadb \
            pypdf pymupdf python-docx markdown unstructured \
            jieba tiktoken
```

如果你是使用DeepSeek或本地模型，按需替换安装包。

#### 第2天：文档加载器详解

文档加载器（Document Loader）是将原始文件读入LangChain `Document`对象的桥梁。每种文件格式都有自己的加载器：

**PDF加载——PyMuPDFLoader（推荐）：**

```python
from langchain_community.document_loaders import PyMuPDFLoader

loader = PyMuPDFLoader("机器学习报告.pdf")
documents = loader.load()

# 每个Document包含page_content和metadata
for doc in documents[:2]:
    print(f"页码: {doc.metadata.get('page', '?')}")
    print(f"内容预览: {doc.page_content[:100]}...")
    print("---")
```

PyMuPDF（即fitz）的优势在于：速度快、保留页码元数据、对复杂排版（多栏、表格）的支持优于PyPDF2。如果你的PDF是扫描件（图片型），需要先走OCR流程，用 `UnstructuredPDFLoader` 配合 `pytesseract`。

**Markdown与HTML加载：**

```python
from langchain_community.document_loaders import TextLoader, UnstructuredMarkdownLoader
from langchain_community.document_loaders import UnstructuredHTMLLoader

# Markdown文件
md_loader = UnstructuredMarkdownLoader("README.md")
md_docs = md_loader.load()

# HTML文件
html_loader = UnstructuredHTMLLoader("article.html")
html_docs = html_loader.load()
```

**多文件批量加载——DirectoryLoader：**

```python
from langchain_community.document_loaders import DirectoryLoader

# 加载某目录下所有PDF
loader = DirectoryLoader(
    "./knowledge_base/",
    glob="**/*.pdf",
    loader_cls=PyMuPDFLoader
)
all_docs = loader.load()
print(f"共加载 {len(all_docs)} 个文档片段")
```

#### 第3天：中文文本处理的特殊问题

RAG在中文场景下面临几个独特挑战：

1. **中文没有空格分词**。英文天然以空格分隔单词，中文的词边界需要算法推断。
2. **分块边界更敏感**。英文分块在句子边界断开即可，中文在从句中间断开可能导致语义断裂。
3. **Embedding模型的中文支持差异大**。

**中文分词工具——jieba：**

```python
import jieba

text = "检索增强生成是2026年最实用的AI工程技术"
words = jieba.lcut(text)
print(words)
# 输出: ['检索', '增强', '生成', '是', '2026', '年', '最', '实用', '的', 'AI', '工程', '技术']

# 添加自定义词典
jieba.add_word("RAG系统")
jieba.add_word("向量数据库")
```

注意：LangChain内部的分块器（如 `RecursiveCharacterTextSplitter`）基于**字符**而非token，对中文来说效果尚可。更推荐的是使用 `tiktoken` 以token为单位分块：

```python
import tiktoken

enc = tiktoken.encoding_for_model("gpt-4")
tokens = enc.encode("检索增强生成是2026年最实用的AI工程技术")
print(f"Token数: {len(tokens)}")
print(f"解码回文本: {enc.decode(tokens)}")
```

**中文分块的陷阱**：RecursiveCharacterTextSplitter默认的分隔符列表是 `["\n\n", "\n", " ", ""]`，对中文来说" "空格分隔效果不佳。应调整为 `["\n\n", "\n", "。", "！", "？", "；", "，", ""]` 来优先在句子边界断开。

#### 第4天：构建最小RAG流水线

今天把所有零件串起来，跑通第一条完整的RAG流水线。这是你的"Hello World"版本。

```python
from langchain_community.document_loaders import PyMuPDFLoader
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain_community.embeddings import OpenAIEmbeddings
from langchain_community.vectorstores import Chroma
from langchain_openai import ChatOpenAI
from langchain.chains import RetrievalQA

# 第一步：加载文档
loader = PyMuPDFLoader("知识库文档.pdf")
docs = loader.load()

# 第二步：分块
splitter = RecursiveCharacterTextSplitter(
    chunk_size=500,
    chunk_overlap=50,
    separators=["\n\n", "\n", "。", "！", "？", "；", "，", " "]
)
chunks = splitter.split_documents(docs)
print(f"文档被切分为 {len(chunks)} 个块")

# 第三步：向量化并存入数据库
embeddings = OpenAIEmbeddings(model="text-embedding-3-small")
vectorstore = Chroma.from_documents(
    documents=chunks,
    embedding=embeddings,
    persist_directory="./chroma_db"
)

# 第四步：构建检索QA链
llm = ChatOpenAI(model="gpt-4o", temperature=0)
qa_chain = RetrievalQA.from_chain_type(
    llm=llm,
    chain_type="stuff",  # 将所有检索结果放入一个prompt
    retriever=vectorstore.as_retriever(search_kwargs={"k": 3})
)

# 第五步：提问
result = qa_chain.invoke({"query": "这篇文档主要讲了什么？"})
print(result["result"])
```

这个例子包含了RAG的全部核心环节。`RetrievalQA.from_chain_type` 的 `chain_type="stuff"` 是最简单的方式——把所有检索到的文档块"塞"进Prompt。当文档块太多时（超过模型上下文窗口），需要改用 `map_reduce` 或 `refine` 策略。

#### 第5天：深入理解Embedding模型选择

**Embedding是RAG质量的基石**。检索出来的东西对不对，80%取决于Embedding模型。截至2026年，主流Embedding模型对比：

| 模型 | 维度 | 中文效果 | 最大输入 | 成本 |
|------|------|---------|---------|------|
| text-embedding-3-small | 1536 | 好（支持中文） | 8191 tokens | 低 |
| text-embedding-3-large | 3072 | 好 | 8191 tokens | 中 |
| BAAI/bge-large-zh-v1.5 | 1024 | 优秀 | 512 tokens | 免费 |
| moka-ai/m3e-base | 768 | 良好 | 512 tokens | 免费 |
| shibing624/text2vec-base-chinese | 768 | 良好 | 512 tokens | 免费 |

**选择建议**：
- 生产环境用OpenAI `text-embedding-3-small`，速度与质量均衡。
- 中文场景追求最高精度用 `bge-large-zh-v1.5`。
- 离线/隐私场景用 `m3e-base` 或 `text2vec-base-chinese`。

**使用本地Embedding模型：**

```python
from langchain_community.embeddings import HuggingFaceEmbeddings

embeddings = HuggingFaceEmbeddings(
    model_name="BAAI/bge-large-zh-v1.5",
    model_kwargs={"device": "cuda"},  # 或者 "cpu"
    encode_kwargs={"normalize_embeddings": True}
)
```

**Embedding维度与检索速度**：维度越高，每个向量占用的内存越大，检索速度越慢。1536维和768维在百万级数据量下的性能差距约2-3倍。OpenAI新模型支持通过 `dimensions` 参数截断维度：

```python
embeddings = OpenAIEmbeddings(
    model="text-embedding-3-small",
    dimensions=512  # 截断到512维，牺牲少量精度换取速度
)
```

#### 第6天：向量数据库实操

Chroma是入门最简单、无需额外部署的向量数据库。项目初期完全够用。

**Chroma进阶用法：**

```python
from langchain_community.vectorstores import Chroma
from langchain_community.embeddings import OpenAIEmbeddings

embeddings = OpenAIEmbeddings(model="text-embedding-3-small")

# 创建（从已有集合加载）
vectorstore = Chroma(
    persist_directory="./chroma_db",
    embedding_function=embeddings
)

# 添加文档
vectorstore.add_documents(new_chunks)

# 删除文档（按ID）
vectorstore.delete(["doc_id_1", "doc_id_2"])

# 相似度搜索（直接返回分数）
results = vectorstore.similarity_search_with_score(
    "什么是RAG？",
    k=5
)
for doc, score in results:
    print(f"分数: {score:.4f} | 内容: {doc.page_content[:50]}...")
```

分数含义取决于使用的距离函数。Chroma默认用L2距离（欧几里得距离），值越小越相似。如果使用余弦相似度（cosine），值越大越相似（范围-1到1）。设置距离函数：

```python
vectorstore = Chroma.from_documents(
    ...,
    collection_metadata={"hnsw:space": "cosine"}  # 可选: l2, ip, cosine
)
```

**生产环境进阶**：当文档量超过百万级，Chroma可能扛不住。此时需要迁移到专用向量数据库：

- **Milvus/Zilliz**：分布式、支持十亿级、功能最全（标量过滤、混合检索）
- **Qdrant**：Rust实现、性能极高、支持过滤和分组
- **Pinecone**：云原生、零运维、但贵
- **PostgreSQL + pgvector**：如果你的数据本来就在PostgreSQL中，这是最省事的方式

```python
# 以Qdrant为例
from langchain_community.vectorstores import Qdrant

vectorstore = Qdrant.from_documents(
    chunks,
    embeddings,
    url="http://localhost:6333",
    collection_name="my_knowledge_base",
    force_recreate=True
)
```

#### 第7天：本周项目——搭建本地知识问答机器人

**项目目标**：将你电脑中某个文件夹下的所有技术文档（PDF、Markdown、TXT）构建为RAG知识库，提供一个交互式命令行问答界面。

**详细实现**：

```python
import os
from pathlib import Path
from langchain_community.document_loaders import DirectoryLoader, PyMuPDFLoader
from langchain_community.document_loaders import TextLoader, UnstructuredMarkdownLoader
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain_community.embeddings import OpenAIEmbeddings
from langchain_community.vectorstores import Chroma
from langchain_openai import ChatOpenAI
from langchain.chains import RetrievalQA

def build_knowledge_base(docs_dir: str, persist_dir: str = "./chroma_db"):
    """构建知识库：加载所有文档 -> 分块 -> 向量化 -> 存储"""
    loaders = {
        ".pdf": (PyMuPDFLoader, {}),
        ".md": (UnstructuredMarkdownLoader, {}),
        ".txt": (TextLoader, {"encoding": "utf-8"}),
        ".html": (UnstructuredHTMLLoader, {}),
    }

    all_documents = []
    docs_path = Path(docs_dir)

    for ext, (loader_cls, kwargs) in loaders.items():
        for file_path in docs_path.rglob(f"*{ext}"):
            print(f"加载: {file_path}")
            loader = loader_cls(str(file_path), **kwargs)
            docs = loader.load()
            # 保留文件路径元数据
            for doc in docs:
                doc.metadata["source"] = str(file_path)
            all_documents.extend(docs)

    print(f"共加载 {len(all_documents)} 个文档片段")

    # 分块
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=512,
        chunk_overlap=64,
        separators=["\n\n", "\n", "。", "！", "？", "；", "，", " ", ""]
    )
    chunks = splitter.split_documents(all_documents)
    print(f"切分为 {len(chunks)} 个块")

    # 向量化 + 存储
    embeddings = OpenAIEmbeddings(model="text-embedding-3-small")
    vectorstore = Chroma.from_documents(
        documents=chunks,
        embedding=embeddings,
        persist_directory=persist_dir
    )
    return vectorstore

def create_qa_chain(vectorstore):
    """创建问答链"""
    llm = ChatOpenAI(model="gpt-4o", temperature=0)
    qa_chain = RetrievalQA.from_chain_type(
        llm=llm,
        chain_type="stuff",
        retriever=vectorstore.as_retriever(search_kwargs={"k": 4}),
        return_source_documents=True  # 返回来源文档
    )
    return qa_chain

def main():
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "--rebuild":
        vectorstore = build_knowledge_base("./knowledge_base")
    else:
        embeddings = OpenAIEmbeddings(model="text-embedding-3-small")
        vectorstore = Chroma(
            persist_directory="./chroma_db",
            embedding_function=embeddings
        )

    qa_chain = create_qa_chain(vectorstore)

    print("\n知识问答机器人已启动！输入 'quit' 退出。\n")
    while True:
        query = input("\n提问: ")
        if query.lower() in ("quit", "exit"):
            break

        result = qa_chain.invoke({"query": query})
        print(f"\n答案: {result['result']}")
        print("\n--- 参考来源 ---")
        seen_sources = set()
        for doc in result["source_documents"]:
            source = doc.metadata.get("source", "未知")
            if source not in seen_sources:
                print(f"  - {source}")
                seen_sources.add(source)

if __name__ == "__main__":
    main()
```

这个程序虽然简单，但已经具备了生产RAG系统的基本架构：多格式支持、增量索引、来源追溯。下周我们将深入优化"分块"这个决定检索质量的黄金环节。

---

### 第2周：分块策略的艺术

如果说Embedding决定了"能搜到什么"，分块就决定了"搜得准不准"。同样一篇文档，分块策略不同，检索效果天差地别。

#### 第8天：固定大小分块（Fixed Size Chunking）

最朴素的方法：按固定数量的字符或token切分。

```python
from langchain.text_splitter import TokenTextSplitter

# 基于token的分块（推荐）
token_splitter = TokenTextSplitter(
    chunk_size=256,      # 每块256个token
    chunk_overlap=32,    # 重叠32个token
    encoding_name="cl100k_base"  # GPT-4/GPT-3.5所用的编码器
)

chunks = token_splitter.split_documents(docs)
```

**为什么token比字符更合理？** 因为LLM的上下文窗口是以token计量的。如果用字符分块，一个"256字符"的块可能包含80个token（英文）或150个token（中文，因为中文每个字约1-2个token），会导致不一致的填充效果。

**固定分块的致命缺陷**：它不考虑语义边界。一个句子的后半句可能在块A，前半句在块B。检索时如果命中了块B，但缺少块A的上下文，LLM会一头雾水。

#### 第9天：语义分块（Semantic Chunking）

更好的方式是在**语义完整的边界**处断开。具体策略：

1. **递归字符分割（RecursiveCharacterTextSplitter）**：按优先级列表尝试分隔符，优先在段落、句子边界断开。
2. **基于NLP的分句**：先用句子分割器拆分，再合并成固定大小的块。
3. **基于Embedding的分块**：检测Embedding向量的"突变点"，在话题转换处断开（最先进，也最贵）。

**递归字符分割的深度理解：**

```python
from langchain.text_splitter import RecursiveCharacterTextSplitter

splitter = RecursiveCharacterTextSplitter(
    chunk_size=500,
    chunk_length_function=len,  # 计算长度的函数（默认用字符数）
    separators=[
        "\n\n",    # 优先在段落之间断开
        "\n",      # 其次在换行处断开
        "。",      # 中文句号
        "！",      # 中文感叹号
        "？",      # 中文问号
        "；",      # 中文分号
        "，",      # 中文逗号
        " ",       # 空格
        ""         # 最后退化为按字符断开
    ]
)
```

算法原理：从第一个分隔符开始，如果按 `\n\n` 切分后某个块仍然大于 `chunk_size`，就在该块上尝试下一个分隔符 `\n`，依此类推，直到使用最后一个分隔符（空字符串，即按字符切分）。

**意图分割（NLP-based）：**

```python
import re
from langchain.text_splitter import TextSplitter
from langchain.schema import Document

class ChineseSentenceSplitter(TextSplitter):
    """基于中文句子的分块器"""

    def split_text(self, text: str) -> list[str]:
        # 中文句子边界正则
        sentences = re.split(r'(?<=[。！？\n])\s*', text)
        sentences = [s.strip() for s in sentences if s.strip()]

        chunks = []
        current_chunk = ""

        for sentence in sentences:
            if len(current_chunk) + len(sentence) <= self._chunk_size:
                current_chunk += sentence
            else:
                if current_chunk:
                    chunks.append(current_chunk)
                current_chunk = sentence

        if current_chunk:
            chunks.append(current_chunk)

        return chunks

# 使用
splitter = ChineseSentenceSplitter(chunk_size=500, chunk_overlap=50)
chunks = splitter.split_documents(docs)
```

#### 第10天：重叠窗口（Overlap）的精确控制

重叠窗口是为了解决"边界截断"问题。假设文档在"检索增强生成是一种..."处被切断，下个块从"增强生成是一种..."开始，如果没有重叠，"检"字的信息就被丢失了。

**重叠的作用**：
- 保证块边界附近的关键信息不会丢失
- 检索时如果问题恰好涉及边界内容，两个相邻块都可能被召回
- 代价：存储空间增加约 `overlap_ratio * 100%`，检索时可能返回更多相似但冗余的块

**最佳实践**：

```
chunk_size:  500  | chunk_overlap: 50  → 重叠率 10%（推荐，通用场景）
chunk_size:  256  | chunk_overlap: 50  → 重叠率 20%（适合短文本、密集信息）
chunk_size: 1024  | chunk_overlap: 100 → 重叠率 10%（长上下文，适合综述性文档）
chunk_size:  128  | chunk_overlap: 0   → 无重叠（仅用于对比实验）
```

**高级技巧：根据文档类型动态调整**

```python
from langchain.text_splitter import RecursiveCharacterTextSplitter

def get_splitter_for_doc_type(doc_type: str):
    """根据文档类型返回不同的分块策略"""
    configs = {
        "technical_report":  {"chunk_size": 512, "chunk_overlap": 64,  "separators": ["\n\n", "\n", "。", "；", ""]},
        "conversation":      {"chunk_size": 256, "chunk_overlap": 32,  "separators": ["\n\n", "\n", "", ""]},
        "code_documentation": {"chunk_size": 1024, "chunk_overlap": 128, "separators": ["\n\n", "\n", "def ", "class ", ""]},
        "news_article":      {"chunk_size": 512, "chunk_overlap": 50,  "separators": ["\n\n", "\n", "。", "！", "？", ""]},
    }
    cfg = configs.get(doc_type, configs["technical_report"])
    return RecursiveCharacterTextSplitter(
        chunk_size=cfg["chunk_size"],
        chunk_overlap=cfg["chunk_overlap"],
        separators=cfg["separators"]
    )
```

#### 第11天：分块实验——量化不同策略的效果

今天不做开发，做实验。我们要对同一篇文档用不同分块策略，然后人工评估检索质量。

**实验框架：**

```python
import pandas as pd
from tqdm import tqdm
from langchain.text_splitter import (
    RecursiveCharacterTextSplitter,
    TokenTextSplitter
)
from langchain_community.embeddings import OpenAIEmbeddings
from langchain_community.vectorstores import Chroma

def evaluate_chunking_strategy(documents, test_questions, strategy_name, **splitter_kwargs):
    """评估一种分块策略的检索效果"""
    # 分块
    if strategy_name == "token":
        splitter = TokenTextSplitter(**splitter_kwargs)
    else:
        splitter = RecursiveCharacterTextSplitter(**splitter_kwargs)

    chunks = splitter.split_documents(documents)

    # 建索引
    embeddings = OpenAIEmbeddings(model="text-embedding-3-small")
    vectorstore = Chroma.from_documents(
        documents=chunks,
        embedding=embeddings
    )
    retriever = vectorstore.as_retriever(search_kwargs={"k": 3})

    # 测试检索
    results = []
    for question in test_questions:
        retrieved_docs = retriever.invoke(question)
        # 人工判断：相关还是不相关（这里简化，实际需要人工标注）
        results.append({
            "strategy": strategy_name,
            "question": question[:50],
            "chunks_count": len(chunks),
            "retrieved_count": len(retrieved_docs),
            "retrieved_text": [d.page_content[:100] for d in retrieved_docs]
        })

    return results

# 实验设计
experiments = [
    {"strategy": "recursive", "chunk_size": 128,  "chunk_overlap": 0},
    {"strategy": "recursive", "chunk_size": 256,  "chunk_overlap": 32},
    {"strategy": "recursive", "chunk_size": 512,  "chunk_overlap": 64},
    {"strategy": "recursive", "chunk_size": 1024, "chunk_overlap": 128},
    {"strategy": "token",     "chunk_size": 256,  "chunk_overlap": 32},
    {"strategy": "token",     "chunk_size": 512,  "chunk_overlap": 64},
]

all_results = []
for exp in experiments:
    res = evaluate_chunking_strategy(all_docs, test_questions, **exp)
    all_results.extend(res)

df = pd.DataFrame(all_results)
df.to_csv("chunking_experiment_results.csv", index=False)
```

你应当以"问题是否能在检索结果的前3条中找到对应信息"作为判断标准。记录每个策略的"命中率"。你会发现：
- 128太小：信息碎片化，缺乏上下文
- 1024太大：块内信息过多，相似度被稀释
- 256-512 + 10-15%重叠通常是甜点区

#### 第12天：元数据附加与过滤

分块时保留和附加元数据，可以实现检索时的精确过滤，大幅提升质量。

```python
from langchain.schema import Document

documents = []

# 手动构造带元数据的Document
doc = Document(
    page_content="Transformer架构是2017年由Google提出的...",
    metadata={
        "source": "transformer_paper.pdf",
        "page": 1,
        "author": "Vaswani et al.",
        "year": 2017,
        "category": "论文",
        "chunk_index": 0,
        "total_chunks": 15
    }
)

# 在分块时保留并传递元数据
from langchain.text_splitter import RecursiveCharacterTextSplitter

splitter = RecursiveCharacterTextSplitter(chunk_size=256, chunk_overlap=32)
chunks = splitter.split_documents(documents)
# 每个chunk自动继承了原始文档的metadata，并添加了 splitter 信息

# 带过滤条件的检索
retriever = vectorstore.as_retriever(
    search_kwargs={
        "k": 5,
        "filter": {"year": {"$gte": 2023}}  # 只检索2023年及之后的文档
    }
)
```

**元数据过滤的真实场景**：
- 按日期范围过滤（只检索最近3个月的内容）
- 按文档类型过滤（只看PDF不看网页）
- 按作者/来源过滤（只看权威来源）
- 按章节过滤（只查"架构设计"部分）

#### 第13天：文档总结与分层索引

一个高级技巧：对超长文档，先让LLM生成每部分的摘要，将摘要作为检索的"索引"，检索到摘要后再读取原文。

```python
from langchain_openai import ChatOpenAI
from langchain.chains.summarize import load_summarize_chain

llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)
chain = load_summarize_chain(llm, chain_type="map_reduce")

# 对每个块生成摘要
chunk_summaries = []
for chunk in chunks:
    summary = chain.run([chunk])
    chunk_summaries.append(Document(
        page_content=summary,
        metadata={"original_chunk": chunk.page_content, **chunk.metadata}
    ))

# 用摘要建索引（检索时先命中摘要）
vectorstore_with_summaries = Chroma.from_documents(
    documents=chunk_summaries,
    embedding=embeddings
)
```

这种"摘要索引 + 原文生成"的方式在长文档问答中效果显著，检索速度也更快。

#### 第14天：本周项目——文档分块质量分析器

**项目目标**：构建一个可视化工具，对同一文档的不同分块策略进行对比分析，选出最适合你数据的分块参数。

**实现思路**：
1. 输入一篇长文档
2. 用5-8种不同的分块参数分别处理
3. 对每种策略，计算：
   - 块数、平均块长度、块长度标准差
   - 每个块的"语义完整度"（人工评分或基于NLP的代理指标）
   - 检索命中率（用一组预定义的测试问题）
4. 输出对比表格和推荐参数

```python
import statistics
from prettytable import PrettyTable

def analyze_chunking(documents, strategies: list[dict]):
    """分析多种分块策略并生成对比报告"""
    table = PrettyTable()
    table.field_names = ["策略", "chunk_size", "overlap", "总块数", "平均长度", "长度标准差", "语义完整度"]

    for strategy in strategies:
        splitter = RecursiveCharacterTextSplitter(
            chunk_size=strategy["size"],
            chunk_overlap=strategy.get("overlap", 0),
        )
        chunks = splitter.split_documents(documents)
        lengths = [len(c.page_content) for c in chunks]
        semantic_score = estimate_semantic_completeness(chunks)

        table.add_row([
            strategy.get("name", "recursive"),
            strategy["size"],
            strategy.get("overlap", 0),
            len(chunks),
            f"{statistics.mean(lengths):.0f}",
            f"{statistics.stdev(lengths):.0f}",
            f"{semantic_score:.2f}/10"
        ])

    print(table)


def estimate_semantic_completeness(chunks):
    """估算每个块的语义完整度（基于句号结尾的比例）"""
    if not chunks:
        return 0
    complete_ending = sum(
        1 for c in chunks
        if c.page_content.rstrip().endswith(("。", "！", "？", "\n"))
    )
    return round(10 * complete_ending / len(chunks), 2)
```

---

### 第3周：检索策略与Prompt设计

分块搞定后，接下来是两个影响用户体验的关键环节：**检索策略**决定LLM能看到什么信息，**Prompt模板**决定LLM如何使用这些信息。

#### 第15天：基础检索策略——Top-K与相似度阈值

**Top-K检索**：返回与问题最相似的K个文档块。

```python
# 基础用法
retriever = vectorstore.as_retriever(
    search_type="similarity",
    search_kwargs={"k": 4}
)
```

K值的选择直接影响答案质量：
- **K太小（1-2）**：信息可能不足，尤其当问题涉及多个方面时
- **K中等（3-5）**：推荐值，覆盖大多数场景
- **K太大（8-10+）**：噪音增多，可能引入无关信息导致LLM混淆，且消耗更多token

**相似度阈值检索**：只返回相似度高于某个阈值的块。

```python
retriever = vectorstore.as_retriever(
    search_type="similarity_score_threshold",
    search_kwargs={
        "score_threshold": 0.5,  # 只返回相似度>0.5的
        "k": 10                  # 但最多返回10个
    }
)
```

阈值设置的技巧：
- 0.7-0.8+：严格模式，只返回高度相关的（可能漏检）
- 0.4-0.6：中等模式，平衡召回和精确
- 0.3以下：宽松模式，宁可错杀不可放过（适合开放域问题）

**MMR（最大边际相关性）检索**：在相关性和多样性之间做权衡，避免返回内容过于相似的块。

```python
retriever = vectorstore.as_retriever(
    search_type="mmr",
    search_kwargs={
        "k": 5,
        "fetch_k": 20,   # 先取20个候选
        "lambda_mult": 0.5  # 0=纯多样性, 1=纯相关性
    }
)
```

MMR适合的场景：当文档中存在大量重复或相似内容时（比如多篇讲同一技术的文章），MMR能确保检索结果覆盖不同方面。

#### 第16天：高级检索——HyDE与查询重写

**HyDE（假设性文档嵌入）**：先让LLM根据问题"脑补"一个答案，然后用这个假答案去检索。直觉：如果问题问"如何优化MySQL查询性能？"，直接检索可能匹配不佳，但LLM生成的假答案"优化MySQL查询性能的方法包括索引优化、查询重写、缓存策略..."能更好地匹配知识库中相关内容。

```python
from langchain_openai import ChatOpenAI
from langchain.prompts import PromptTemplate

# 假设性文档生成
hyde_prompt = PromptTemplate.from_template(
    """请根据问题生成一段包含详细答案的文档。即使你不确定，也要写出可能有用的信息。

问题: {question}

假设性文档:"""
)

llm = ChatOpenAI(model="gpt-4o-mini", temperature=0.3)

def hyde_retrieve(question: str, retriever, llm):
    """HyDE检索"""
    # 生成假设性文档
    hypothetical_doc = llm.invoke(hyde_prompt.format(question=question))
    # 用生成的文档去检索
    results = retriever.invoke(hypothetical_doc.content)
    return results
```

**查询重写（Query Rewriting）**：用户的问题往往是口语化、不完整的。重写为更规范的查询可以提高检索效果。

```python
from langchain.prompts import ChatPromptTemplate

rewrite_prompt = ChatPromptTemplate.from_messages([
    ("system", "你是一个查询优化助手。将用户的问题重写为更清晰、更适合搜索的形式。"),
    ("human", "原问题: {question}\n优化后: ")
])

def rewrite_and_retrieve(question: str, retriever, llm):
    # 重写查询
    rewritten = llm.invoke(rewrite_prompt.format(question=question))
    # 用重写后的查询和原查询分别检索
    results1 = retriever.invoke(question)
    results2 = retriever.invoke(rewritten.content)
    # 合并去重
    seen_contents = set()
    combined = []
    for doc in results1 + results2:
        if doc.page_content not in seen_contents:
            combined.append(doc)
            seen_contents.add(doc.page_content)
    return combined[:5]
```

#### 第17天：混合检索——向量 + 关键词

向量检索擅长语义匹配，但不擅长精确匹配（如产品型号"iPhone 16 Pro Max 1TB"）。关键词检索（BM25）正相反。**混合检索**将两者结合，取长补短。

```python
# 安装所需包
# pip install rank_bm25

from langchain.retrievers import EnsembleRetriever
from langchain_community.retrievers import BM25Retriever

# 创建BM25检索器
bm25_retriever = BM25Retriever.from_documents(chunks)
bm25_retriever.k = 3

# 创建向量检索器
vector_retriever = vectorstore.as_retriever(search_kwargs={"k": 3})

# 混合检索（加权合并）
ensemble_retriever = EnsembleRetriever(
    retrievers=[bm25_retriever, vector_retriever],
    weights=[0.3, 0.7]  # BM25权重0.3，向量检索权重0.7
)

results = ensemble_retriever.invoke("iPhone 16 Pro Max 价格")
```

**重排序（Re-Ranking）**：混合检索返回了更多候选，但排序可能不完美。用专门的Cross-Encoder模型对候选重排序：

```python
# pip install sentence-transformers
from sentence_transformers import CrossEncoder

# 加载重排序模型（中文优化版）
ranker = CrossEncoder("BAAI/bge-reranker-v2-m3")

def rerank(query: str, documents: list, top_k: int = 3):
    """对检索结果重排序"""
    pairs = [[query, doc.page_content] for doc in documents]
    scores = ranker.predict(pairs)

    # 按分数降序排列
    scored_docs = sorted(
        zip(documents, scores),
        key=lambda x: x[1],
        reverse=True
    )
    return [doc for doc, score in scored_docs[:top_k]]

# 使用
initial_results = ensemble_retriever.invoke("什么是Transformer？")
final_results = rerank("什么是Transformer？", initial_results, top_k=3)
```

重排序通常能将答案准确率提升5-15个百分点，是性价比极高的优化手段。

#### 第18天：Prompt模板设计

RAG的Prompt是整个系统的"灵魂"。设计不良的Prompt会让LLM忽视检索结果或过度解读。

**黄金模板：**

```python
from langchain.prompts import ChatPromptTemplate

rag_prompt = ChatPromptTemplate.from_messages([
    ("system", """你是一个忠实于知识库的问答助手。你的回答必须严格遵循以下原则：

1. 只基于""" """提供的上下文""" """回答问题。
2. 如果上下文中没有足够信息回答用户的问题，直接说"抱歉，知识库中没有找到相关信息"。
3. 不要用自己的知识补充上下文没有的内容。
4. 在回答末尾，列出你参考了上下文中的哪些具体内容，格式为【参考来源：文件名，页码P.X】。
5. 如果用户的提问与上下文完全无关，回复"这个问题超出了知识库的范围"。

上下文：
{context}

——以上是知识库中检索到的相关内容——
"""),
    ("human", "{question}")
])

# 构建链
from langchain.schema.runnable import RunnablePassthrough

def format_docs(docs):
    """将检索到的文档格式化为上下文"""
    return "\n\n---\n\n".join([
        f"【来源: {d.metadata.get('source', '未知')}, 页码: {d.metadata.get('page', '?')}】\n{d.page_content}"
        for d in docs
    ])

rag_chain = (
    {"context": retriever | format_docs, "question": RunnablePassthrough()}
    | rag_prompt
    | llm
)

result = rag_chain.invoke("什么是RAG？")
print(result.content)
```

**这个Prompt的精妙之处**：

1. **明确边界**：告诉LLM"不知道就说不知道"，这是对抗幻觉最有效的单一手段。
2. **引用来源**：强制LLM标注信息的出处，这是建立用户信任的关键。
3. **上下文标记**：用`——以上是知识库中检索到的相关内容——`明确标注上下文的范围，防止LLM混淆"上下文"和"自己的知识"。
4. **结构化处理**：在format_docs中为每段内容加上来源标签，LLM可以直接引用。

**多轮对话中的Prompt设计**：

```python
rag_conv_prompt = ChatPromptTemplate.from_messages([
    ("system", """你是一个忠实于知识库的问答助手。
基于提供的上下文回答问题。如果上下文不足，请说明。

上下文：
{context}"""),
    ("placeholder", "{history}"),
    ("human", "{question}")
])
```

使用 `placeholder` 或 `MessagesPlaceholder` 可以插入历史对话：

```python
from langchain.memory import ConversationBufferMemory
from langchain.chains import ConversationChain

memory = ConversationBufferMemory(
    memory_key="history",
    return_messages=True
)
```

#### 第19天：高级Prompt技巧

**Few-shot示例注入**：在Prompt中加入问答示例，引导LLM的输出格式。

```python
rag_prompt_with_examples = ChatPromptTemplate.from_messages([
    ("system", """基于上下文回答问题。

上下文：
{context}"""),
    ("human", "Transformer的编码器有几层？"),
    ("assistant", "根据知识库，原始Transformer论文中的编码器有6层。【参考来源：transformer_paper.pdf，P.3】"),
    ("human", "什么是注意力机制？"),
    ("assistant", "注意力机制是Transformer的核心创新，它允许模型在计算每个位置的表示时，动态关注输入序列中的所有其他位置。【参考来源：transformer_paper.pdf，P.2】"),
    ("human", "{question}")
])
```

**上下文压缩**：当检索到的上下文太长时，先让LLM压缩或提取相关部分：

```python
from langchain.retrievers import ContextualCompressionRetriever
from langchain.retrievers.document_compressors import LLMChainExtractor

compressor = LLMChainExtractor.from_llm(llm)
compression_retriever = ContextualCompressionRetriever(
    base_compressor=compressor,
    base_retriever=retriever
)

# 压缩后，每个文档块只保留与问题最相关的几句话
compressed_docs = compression_retriever.invoke("什么是反向传播？")
```

#### 第20天：LangChain vs LlamaIndex 框架对比

两个框架都能实现RAG，但设计哲学不同：

| 维度 | LangChain | LlamaIndex |
|------|-----------|------------|
| 设计理念 | 通用LLM应用框架 | 专注数据索引与检索 |
| 学习曲线 | 陡峭，抽象层次多 | 较平缓，概念更少 |
| 文档加载器 | 丰富，30+种 | 丰富，20+种，但质量高 |
| 高级检索 | 需要自己组合 | 内置多种检索策略 |
| 评估工具 | 第三方集成 | 内置评估模块 |
| 社区生态 | 更庞大 | 专注检索领域 |

**LlamaIndex实现RAG：**

```python
from llama_index.core import VectorStoreIndex, SimpleDirectoryReader, Settings
from llama_index.core.embeddings import resolve_embed_model
from llama_index.llms.openai import OpenAI

# 加载文档
documents = SimpleDirectoryReader("./knowledge_base").load_data()

# 配置Embedding和LLM
Settings.embed_model = resolve_embed_model("local:BAAI/bge-large-zh-v1.5")
Settings.llm = OpenAI(model="gpt-4o", temperature=0)

# 构建索引
index = VectorStoreIndex.from_documents(documents)

# 查询
query_engine = index.as_query_engine(similarity_top_k=3)
response = query_engine.query("什么是RAG？")
print(response)
```

**何时选哪个？**
- **选LangChain**：你的应用场景不止RAG（还需要Agent、Tool use、多模态等），或需要高度定制。
- **选LlamaIndex**：你的核心需求就是文档查询，想要更简洁的API和内置的最佳实践。

我个人建议：**本月先用LangChain把原理理解透，月底再用LlamaIndex做一个对比项目**（即项目3）。

#### 第21天：本周项目——智能客服知识库

**项目目标**：为一个产品（可以是你的个人网站、开源项目或虚构产品）构建智能客服知识库，支持多轮对话、态度控制、来源追溯。

**高级实现**：

```python
from langchain.memory import ConversationSummaryMemory
from langchain.chains import ConversationalRetrievalChain

# 构建对话式检索链
memory = ConversationSummaryMemory(
    llm=ChatOpenAI(model="gpt-4o-mini"),
    memory_key="chat_history",
    return_messages=True
)

qa_chain = ConversationalRetrievalChain.from_llm(
    llm=ChatOpenAI(model="gpt-4o", temperature=0),
    retriever=retriever,
    memory=memory,
    verbose=False,
    chain_type="stuff",  # 或 "map_reduce"（当上下文太大时）
    combine_docs_chain_kwargs={"prompt": rag_prompt},
    rephrase_question=True  # 自动重述多轮对话中的问题
)

# 多轮对话测试
result1 = qa_chain.invoke({"question": "你的产品支持哪些格式？"})
print(f"Q: 你的产品支持哪些格式？\nA: {result1['answer']}")

result2 = qa_chain.invoke({"question": "怎么上传文件？"})  # 能理解"它"指代产品
print(f"Q: 怎么上传文件？\nA: {result2['answer']}")
```

---

### 第4周：RAG评估与实战项目交付

前三周你学会了怎么"造"RAG系统，本周学怎么"度量"和"优化"它。

#### 第22天：RAG评估指标体系

不评估就无法优化。RAG评估分两个层面：

**1. 检索评估（Retrieval Evaluation）**

- **命中率（Hit Rate）**：测试问题中，有多少能在检索结果的前K个中找到正确答案。计算公式：`Hits@K = 有效命中数 / 总问题数`
- **平均倒数排名（MRR）**：第一个正确答案在检索结果中的位置倒数的平均值。如果正确答案排第1，得1分；排第3，得1/3分。
- **精确率（Precision）**：检索结果中，真正相关的结果占比。

**2. 生成评估（Generation Evaluation）**

- **答案准确率**：LLM给出的答案是否准确。需要人工标注或使用更强的LLM评判。
- **幻觉率**：答案中包含上下文之外信息的比例。
- **引用准确率**：如果LLM标注了来源，来源是否真的支持其说法。

**基于LLM的自动评估：**

```python
from langchain_openai import ChatOpenAI
from langchain.prompts import ChatPromptTemplate

evaluator_llm = ChatOpenAI(model="gpt-4o", temperature=0)

eval_prompt = ChatPromptTemplate.from_messages([
    ("system", """你是一个RAG质量评估员。你将收到：
- 用户问题
- 检索到的上下文
- LLM生成的答案

请评估两个维度，输出JSON格式：

1. "faithfulness"（忠实度，1-5分）：答案是否完全基于上下文，没有编造？
2. "relevance"（相关性，1-5分）：答案是否直接回答了用户的问题？
3. "citation_accuracy"（引用准确度，1-5分）：答案中的引用来源是否正确？"""),
    ("human", """用户问题：{question}

检索到的上下文：
{context}

生成的答案：
{answer}""")
])

def evaluate_rag_response(question: str, context: str, answer: str):
    result = evaluator_llm.invoke(
        eval_prompt.format(
            question=question,
            context=context,
            answer=answer
        )
    )
    return result.content
```

#### 第23天：构建评估数据集与自动化测试

没有高质量的测试集，评估就是空谈。构建评估数据集的步骤：

1. **收集代表性问题**：从真实用户提问、产品FAQ、文档标题中提炼。
2. **标注正确答案**：为每个问题标注知识库中对应的原文位置。
3. **构建基准测试**：编写脚本，自动运行评估并生成报告。

```python
import json
from tqdm import tqdm

class RAGEvaluator:
    """RAG系统自动化评估器"""

    def __init__(self, qa_chain, test_data_path: str):
        self.qa_chain = qa_chain
        with open(test_data_path, "r", encoding="utf-8") as f:
            self.test_data = json.load(f)

    def run_evaluation(self):
        """运行完整评估"""
        results = []
        for item in tqdm(self.test_data, desc="评估中"):
            question = item["question"]
            expected_answer = item.get("expected_answer", "")
            expected_source = item.get("expected_source", "")

            # 获取RAG回答
            response = self.qa_chain.invoke({"query": question})
            answer = response.get("result", "")
            source_docs = response.get("source_documents", [])

            # 判断是否命中正确答案所在文档
            hit = any(
                expected_source in doc.metadata.get("source", "")
                for doc in source_docs
            )

            results.append({
                "question": question,
                "answer": answer[:200],
                "expected_answer": expected_answer,
                "hit": hit,
                "source_count": len(source_docs)
            })

        # 计算整体指标
        hit_rate = sum(r["hit"] for r in results) / len(results)
        print(f"\n评估完成！共 {len(results)} 个问题")
        print(f"命中率 (Hit Rate): {hit_rate:.2%}")

        # 保存详细结果
        with open("evaluation_results.json", "w", encoding="utf-8") as f:
            json.dump({
                "hit_rate": hit_rate,
                "total_questions": len(results),
                "details": results
            }, f, ensure_ascii=False, indent=2)

        return results
```

**测试数据集格式示例** (`test_data.json`)：

```json
[
    {
        "question": "Transformer的编码器有几层？",
        "expected_answer": "6层",
        "expected_source": "transformer_paper.pdf"
    },
    {
        "question": "什么是注意力机制？",
        "expected_answer": "允许模型动态关注输入序列中所有位置",
        "expected_source": "transformer_paper.pdf"
    }
]
```

#### 第24天：RAG系统优化——常见问题的调优

**场景1：检索结果不相关**

| 可能原因 | 解决方案 |
|---------|---------|
| Embedding模型对中文支持差 | 换用 bge-large-zh 或 m3e-base |
| 分块太大，语义被稀释 | 减小 chunk_size 到 256-384 |
| 问题表述太模糊 | 添加查询重写步骤 |
| 知识库内容太少 | 增加相关内容或修改chunk overlap |

**场景2：答案出现幻觉**

| 可能原因 | 解决方案 |
|---------|---------|
| Prompt没有强调"只基于上下文" | 使用第18天的黄金模板 |
| LLM温度太高 | 设置 temperature=0 |
| 检索到的上下文不相关 | 增加相似度阈值 |
| 上下文中有矛盾信息 | 检查知识库质量 |

**场景3：速度太慢**

| 瓶颈 | 解决方案 |
|------|---------|
| Embedding模型推理慢 | 换用更小的模型（m3e-base）或批量处理 |
| 向量数据库检索慢 | 添加索引、使用HNSW参数调优 |
| LLM生成慢 | 使用更小的模型（gpt-4o-mini）|
| 上下文太大 | 使用上下文压缩 |
| 文档太多 | 添加元数据预过滤 |

**一个综合优化示例：**

```python
from langchain.retrievers import ContextualCompressionRetriever
from langchain.retrievers.document_compressors import LLMChainExtractor

# 更优的检索器配置
optimized_retriever = vectorstore.as_retriever(
    search_type="mmr",
    search_kwargs={
        "k": 4,
        "fetch_k": 20,
        "lambda_mult": 0.7,
        "filter": {"year": {"$gte": 2024}}
    }
)

# 添加重排序
from langchain.retrievers.document_compressors import CrossEncoderReranker
from langchain_community.cross_encoders import HuggingFaceCrossEncoder

rerank_compressor = CrossEncoderReranker(
    model=HuggingFaceCrossEncoder(model_name="BAAI/bge-reranker-v2-m3"),
    top_n=3
)

final_retriever = ContextualCompressionRetriever(
    base_compressor=rerank_compressor,
    base_retriever=optimized_retriever
)

# 使用优化的检索器
qa_chain = RetrievalQA.from_chain_type(
    llm=ChatOpenAI(model="gpt-4o-mini", temperature=0),  # 使用更小的模型加速
    retriever=final_retriever,
    chain_type="stuff",
    prompt=rag_prompt
)
```

#### 第25-27天：项目实战

这三天集中完成三个实战项目。详细内容见第4节。

#### 第28天：多模态RAG前沿（2026年新趋势）

截至2026年，RAG已经扩展到多模态领域。如果你的知识库包含图片、图表、表格，可以尝试：

**多模态RAG的基本思路**：
1. 用多模态模型（GPT-4o、Claude 4）直接理解图片内容
2. 提取图片中的文字描述，存入向量数据库
3. 检索时同时检索文本和图片描述

```python
# 提取图像描述并索引
from openai import OpenAI
import base64

client = OpenAI()

def describe_image(image_path: str) -> str:
    """用GPT-4o描述图片内容"""
    with open(image_path, "rb") as f:
        image_data = base64.b64encode(f.read()).decode("utf-8")

    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "请详细描述这张图片的内容，包括文字、图表数据、人物等。"},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/png;base64,{image_data}",
                            "detail": "high"
                        }
                    }
                ]
            }
        ]
    )
    return response.choices[0].message.content
```

**Graph RAG（知识图谱RAG）**：微软在2024年提出的Graph RAG技术已成为行业标准。它将文档构建为知识图谱，检索时沿实体关系进行多跳搜索，特别适合"需要关联多个事实才能回答"的复杂问题。

#### 第29天：部署RAG系统到生产环境

开发环境的RAG是一回事，生产部署是另一回事。关键考虑因素：

**1. 向量数据库持久化与更新**

```python
# 增量更新知识库
def update_knowledge_base(new_docs_dir: str, persist_dir: str = "./chroma_db"):
    """增量添加新文档，不需要重建整个索引"""
    embeddings = OpenAIEmbeddings(model="text-embedding-3-small")
    vectorstore = Chroma(
        persist_directory=persist_dir,
        embedding_function=embeddings
    )

    # 加载新文档
    loader = DirectoryLoader(new_docs_dir, glob="**/*.pdf", loader_cls=PyMuPDFLoader)
    new_docs = loader.load()
    splitter = RecursiveCharacterTextSplitter(chunk_size=512, chunk_overlap=64)
    new_chunks = splitter.split_documents(new_docs)

    # 添加到已有集合
    vectorstore.add_documents(new_chunks)
    vectorstore.persist()
    print(f"已添加 {len(new_chunks)} 个新块")
```

**2. FastAPI部署**：

```python
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI()

class Query(BaseModel):
    question: str
    top_k: int = 3

class Response(BaseModel):
    answer: str
    sources: list[dict]

@app.post("/ask", response_model=Response)
async def ask(query: Query):
    result = qa_chain.invoke({"query": query.question})
    sources = [
        {
            "content": doc.page_content[:200],
            "source": doc.metadata.get("source", "unknown"),
            "page": doc.metadata.get("page", None)
        }
        for doc in result.get("source_documents", [])
    ]
    return Response(
        answer=result["result"],
        sources=sources
    )

@app.get("/health")
async def health():
    return {"status": "ok"}

# 启动: uvicorn main:app --host 0.0.0.0 --port 8000
```

#### 第30天：梳理知识体系与项目收尾

回顾整个月的学习路径，画出完整的RAG知识图谱：

```
RAG知识体系
├── 文档处理
│   ├── 加载器 (PyMuPDF/Unstructured/TextLoader)
│   ├── 分块 (固定大小/语义/递归/按token)
│   └── 元数据
├── 向量化
│   ├── Embedding模型 (OpenAI/bge/m3e/text2vec)
│   ├── 维度选择
│   └── 批量处理
├── 向量存储
│   ├── Chroma (入门)
│   ├── Qdrant/Milvus (生产)
│   └── pgvector (PostgreSQL集成)
├── 检索
│   ├── 相似度搜索 (Top-K/阈值/MMR)
│   ├── 混合检索 (向量+BM25)
│   ├── 重排序 (Cross-Encoder)
│   └── 高级技术 (HyDE/查询重写)
├── 生成
│   ├── Prompt模板 (忠实度/引用/边界)
│   ├── 上下文压缩
│   └── 多轮对话
├── 评估
│   ├── Hit Rate/MRR
│   ├── 忠实度/幻觉率
│   └── 自动化评估管线
└── 部署
    ├── 增量更新
    ├── API封装 (FastAPI)
    └── 性能优化
```

---

## 3. 核心知识点详解

### 3.1 RAG完整流水线伪代码（端到端）

```
# ========== 离线索引阶段 ==========
1. 遍历文档目录
2. 对每个文件:
   a. 用对应加载器读取 → Document(page_content, metadata)
   b. 用分块器切分 → List[Document]
3. 所有chunks → Embedding模型 → 向量列表
4. 向量列表 + chunks → 存入向量数据库

# ========== 在线推理阶段 ==========
1. 用户输入问题
2. [可选] 查询重写/扩展
3. 问题 → Embedding模型 → 查询向量
4. 查询向量 → 向量数据库 → Top-K相似块
5. [可选] 重排序
6. 相似块 + 问题 → 格式化 → Prompt
7. Prompt → LLM → 生成答案
8. 返回答案 + 来源引用
```

### 3.2 文档加载器详解

**PyMuPDFLoader（PDF首选）**：
- 优点：速度快（C++底层）、保留页码、处理复杂布局好
- 缺点：不支持OCR、扫描件需要预处理
- 适用场景：文本型PDF，技术文档、论文

```python
# PyMuPDFLoader 高级用法：按页加载
loader = PyMuPDFLoader("document.pdf")
pages = loader.load()
# pages[i] 对应第 i+1 页
# 可指定部分页面
loader = PyMuPDFLoader("document.pdf", extract_images=True)
```

**Unstructured系列（通用方案）**：
- 优点：支持格式最多（PDF、HTML、XML、EML、图片OCR）、自动检测文件类型
- 缺点：速度慢、依赖多、需要安装大量系统级库
- 适用场景：需要处理各种非标准格式时

```python
from langchain_community.document_loaders import UnstructuredFileLoader

# 自动检测文件类型
loader = UnstructuredFileLoader(
    "unknown_format.file",
    mode="elements",  # 按元素（段落、标题、表格）分割
    strategy="auto"   # 自动选择解析策略
)
docs = loader.load()
```

**TextLoader（纯文本）**：

```python
loader = TextLoader("notes.txt", encoding="utf-8", autodetect_encoding=True)
```

### 3.3 分块策略深度对比

用一个具体例子演示不同分块策略的效果：

```
原文：机器学习是人工智能的一个分支。它使计算机能够从数据中学习。深度学习是机器学习的一个子集。transformer架构在2017年被提出。

chunk_size=128, overlap=0:
  块1: "机器学习是人工智能的一个分支。它使计算机能够从数据中学习。深度学习是机器学习的一个子集。transformer架构在2017年被提出。"
  → 整个文档完整，完美

chunk_size=30, overlap=0:
  块1: "机器学习是人工智能的一个分支。它使计算机能"
  块2: "够从数据中学习。深度学习是机器学习的一个"
  块3: "子集。transformer架构在2017年被提出。"
  → "计算机能"和"够"被分开，语义断裂

chunk_size=30, overlap=10:
  块1: "机器学习是人工智能的一个分支。它使计算机能"
  块2: "计算机能够从数据中学习。深度学习是机器学习"
  块3: "是机器学习的一个子集。transformer架构在2017年"
  → overlap 确保了"计算机能"也出现在块2开头
```

**token vs 字符分块的实际差异**（中文场景）：

中文场景下，一个汉字在GPT的tokenizer中通常占1-2个token。但标点、英文单词、数字各有不同的token消耗：

```python
import tiktoken

enc = tiktoken.encoding_for_model("gpt-4")
text = "你好世界 Hello World 123 !@#"
tokens = enc.encode(text)
print(f"字符数: {len(text)}")   # 25
print(f"Token数: {len(tokens)}")  # 12
```

这意味着如果按"字符"分块设置size=500，实际token数可能在250-400之间波动，导致LLM的上下文利用率不一致。因此**专业RAG系统始终按token分块**。

### 3.4 Prompt模板深度分析

RAG的Prompt模板是系统工程，每个词都经过精心设计。逐行分析黄金模板的用意：

```
"你是一个忠实于知识库的问答助手。"
→ 角色设定，明确立场

"你的回答必须严格遵循以下原则："
→ 强制约束，引起LLM注意

"1. 只基于提供的上下文回答问题。"
→ 核心规则：禁止使用内部知识

"2. 如果上下文中没有足够信息回答用户的问题，直接说"抱歉，知识库中没有找到相关信息"。"
→ 拒绝模板，防范幻觉的关键

"3. 不要用自己的知识补充上下文没有的内容。"
→ 再次强化，防止LLM"好心办坏事"

"4. 在回答末尾，列出你参考了上下文中的哪些具体内容"
→ 引用机制，建立信任

"5. 如果用户的提问与上下文完全无关，回复"这个问题超出了知识库的范围"。"
→ 边界保护，防止滥用
```

### 3.5 引用来源的实现

引用来源是最容易被忽视但最重要的功能之一。没有来源的RAG和直接问LLM没有本质区别。

**方案一：在Prompt中要求LLM引用（最简单）**

已在Prompt模板中体现。缺点：LLM可能编造不存在的引用。

**方案二：检索时保留元数据，生成后匹配**

```python
def answer_with_provenance(question: str, retriever, llm, prompt):
    """带确定性来源追溯的RAG"""
    # 检索
    docs = retriever.invoke(question)

    # 为每个文档分配引用编号
    cited_docs = {}
    context_parts = []
    for i, doc in enumerate(docs):
        ref_id = f"[{i+1}]"
        cited_docs[ref_id] = {
            "content": doc.page_content,
            "source": doc.metadata.get("source", "未知"),
            "page": doc.metadata.get("page", "?")
        }
        context_parts.append(f"{ref_id} {doc.page_content}")

    context = "\n\n".join(context_parts)

    # 生成答案（inject引用编号）
    response = llm.invoke(prompt.format(
        context=context,
        question=question
    ))

    # 解析答案中的引用
    import re
    citations = re.findall(r'\[(\d+)\]', response.content)

    return {
        "answer": response.content,
        "citations": [cited_docs.get(f"[{c}]") for c in citations if f"[{c}]" in cited_docs]
    }
```

---

## 4. 动手项目详解

### 项目1：PDF阅读助手

**目标**：构建一个Web应用，用户上传PDF后自动索引，支持提问并定位答案所在页码。

**技术栈**：LangChain + Chroma + FastAPI + Vue.js（或Gradio）

**核心代码**：

```python
import os
import tempfile
from langchain_community.document_loaders import PyMuPDFLoader
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain_community.embeddings import OpenAIEmbeddings
from langchain_community.vectorstores import Chroma
from langchain_openai import ChatOpenAI
from langchain.chains import RetrievalQA
import gradio as gr

def process_pdf(pdf_file):
    """处理上传的PDF，构建索引"""
    # 保存到临时文件
    with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as f:
        f.write(pdf_file)
        temp_path = f.name

    # 加载
    loader = PyMuPDFLoader(temp_path)
    docs = loader.load()

    # 分块
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=512,
        chunk_overlap=64,
        separators=["\n\n", "\n", "。", "！", "？", "；", "，", " "]
    )
    chunks = splitter.split_documents(docs)

    # 为每个块添加页码元数据（继承自父文档）
    for chunk in chunks:
        chunk.metadata["source"] = os.path.basename(temp_path)

    # 向量化
    embeddings = OpenAIEmbeddings(model="text-embedding-3-small")
    vectorstore = Chroma.from_documents(
        documents=chunks,
        embedding=embeddings
    )

    # 清理临时文件
    os.unlink(temp_path)

    return vectorstore

def build_qa_chain(vectorstore):
    llm = ChatOpenAI(model="gpt-4o", temperature=0)
    qa = RetrievalQA.from_chain_type(
        llm=llm,
        retriever=vectorstore.as_retriever(search_kwargs={"k": 4}),
        return_source_documents=True
    )
    return qa

# Gradio界面
def ask_pdf(pdf, question):
    if pdf is None:
        return "请先上传PDF文件"

    vectorstore = process_pdf(pdf)
    qa = build_qa_chain(vectorstore)
    result = qa.invoke({"query": question})

    answer = result["result"]
    answer += "\n\n**参考来源：**\n"
    seen = set()
    for doc in result["source_documents"]:
        page = doc.metadata.get("page", "?")
        if page not in seen:
            answer += f"- 第{page}页\n"
            seen.add(page)

    return answer

iface = gr.Interface(
    fn=ask_pdf,
    inputs=[
        gr.File(label="上传PDF", file_types=[".pdf"]),
        gr.Textbox(label="输入问题", placeholder="关于这份文档，你想问什么？")
    ],
    outputs=gr.Markdown(label="答案"),
    title="PDF阅读助手",
    description="上传PDF文档，基于文档内容提问。系统会自动检索相关段落并生成答案。"
)

if __name__ == "__main__":
    iface.launch()
```

**扩展方向**：
- 支持多PDF同时上传
- 添加对话历史
- 支持高亮答案在原文中的位置（需要前端配合）
- 添加OCR支持扫描件

---

### 项目2：AI笔记本

**目标**：一个笔记应用，用户写的所有笔记自动建立索引，可以基于所有笔记内容提问。

**核心架构**：

```python
import json
import datetime
from pathlib import Path
from langchain_community.embeddings import OpenAIEmbeddings
from langchain_community.vectorstores import Chroma
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain_openai import ChatOpenAI
from langchain.schema import Document

class AINotebook:
    """AI笔记本核心类"""

    def __init__(self, storage_dir: str = "./ai_notebook"):
        self.storage_dir = Path(storage_dir)
        self.storage_dir.mkdir(exist_ok=True)
        self.notes_file = self.storage_dir / "notes.json"
        self.vectorstore_dir = str(self.storage_dir / "vectorstore")
        self.embeddings = OpenAIEmbeddings(model="text-embedding-3-small")

        # 加载现有笔记
        self.notes = self._load_notes()
        self.vectorstore = None
        self._load_or_build_index()

    def _load_notes(self):
        if self.notes_file.exists():
            with open(self.notes_file, "r", encoding="utf-8") as f:
                return json.load(f)
        return []

    def _save_notes(self):
        with open(self.notes_file, "w", encoding="utf-8") as f:
            json.dump(self.notes, f, ensure_ascii=False, indent=2)

    def _load_or_build_index(self):
        """加载或重建向量索引"""
        if Path(self.vectorstore_dir).exists():
            self.vectorstore = Chroma(
                persist_directory=self.vectorstore_dir,
                embedding_function=self.embeddings
            )
        else:
            self._rebuild_index()

    def _rebuild_index(self):
        """从所有笔记重建索引"""
        if not self.notes:
            self.vectorstore = None
            return

        documents = []
        for note in self.notes:
            doc = Document(
                page_content=note["content"],
                metadata={
                    "note_id": note["id"],
                    "title": note["title"],
                    "created_at": note["created_at"],
                    "tags": note.get("tags", [])
                }
            )
            documents.append(doc)

        splitter = RecursiveCharacterTextSplitter(
            chunk_size=512, chunk_overlap=64
        )
        chunks = splitter.split_documents(documents)

        self.vectorstore = Chroma.from_documents(
            documents=chunks,
            embedding=self.embeddings,
            persist_directory=self.vectorstore_dir
        )

    def add_note(self, title: str, content: str, tags: list[str] = None):
        """添加新笔记"""
        note = {
            "id": str(len(self.notes) + 1),
            "title": title,
            "content": content,
            "tags": tags or [],
            "created_at": datetime.datetime.now().isoformat()
        }
        self.notes.append(note)
        self._save_notes()
        self._rebuild_index()  # 简化处理，实际应增量更新
        return note["id"]

    def search_notes(self, query: str, k: int = 5):
        """搜索笔记（全文搜索 + 语义搜索）
        注意：此处是简易实现，完整版应包含BM25混合检索"""
        if not self.vectorstore:
            return {"answer": "还没有任何笔记，先写点东西吧！", "sources": []}

        retriever = self.vectorstore.as_retriever(search_kwargs={"k": k})
        docs = retriever.invoke(query)

        # 构建来源
        sources = []
        for doc in docs:
            sources.append({
                "title": doc.metadata.get("title", "未命名"),
                "content": doc.page_content[:100] + "...",
                "note_id": doc.metadata.get("note_id", "?"),
                "tags": doc.metadata.get("tags", [])
            })

        # 生成答案
        context = "\n\n".join([
            f"【{d.metadata.get('title', '笔记')}】\n{d.page_content}"
            for d in docs
        ])

        llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)
        prompt = f"""基于以下笔记内容回答问题。如果笔记中没有相关信息，请如实说明。

笔记内容：
{context}

问题：{query}

答案："""
        answer = llm.invoke(prompt).content

        return {"answer": answer, "sources": sources}

    def list_notes(self):
        return [
            {"id": n["id"], "title": n["title"], "tags": n["tags"],
             "created_at": n["created_at"]}
            for n in self.notes
        ]


# 使用示例
if __name__ == "__main__":
    nb = AINotebook()

    # 写笔记
    nb.add_note("Transformer架构笔记", """
    Transformer是2017年由Google提出的序列到序列模型。
    核心组件包括：自注意力机制、多头注意力、位置编码、前馈网络。
    编码器由6层组成，每层包含自注意力和前馈网络。
    解码器也是6层，额外包含交叉注意力层。
    """, tags=["深度学习", "NLP"])

    nb.add_note("RAG学习总结", """
    RAG = Retrieval-Augmented Generation。
    核心流程：文档->分块->Embedding->向量库->检索->LLM生成。
    分块策略影响检索质量，推荐chunk_size=256-512,token为单位。
    检索可以结合向量搜索和关键词搜索（混合检索）。
    """, tags=["LLM", "RAG"])

    # 提问
    result = nb.search_notes("什么是自注意力机制？")
    print(f"答案: {result['answer']}")
    print("---来源---")
    for s in result['sources']:
        print(f"  [{s['title']}] {s['content']}")
```

---

### 项目3：RAG对比实验

**目标**：系统性地对比不同参数组合对RAG答案质量的影响，形成一份实验报告，确凿数据指导后续决策。

**实验设计**：

```
实验变量:
  分块大小: 128, 256, 512, 1024
  重叠窗口: 0%, 10%, 20%
  检索策略: Top-3, Top-5, MMR
  Embedding: text-embedding-3-small, bge-large-zh

控制变量:
  同一份测试文档（5篇技术文章）
  同一组测试问题（30道，覆盖不同难度）
  LLM: gpt-4o (temperature=0)
  同一条评估管线

评估指标:
  检索命中率 (Hit@3, Hit@5)
  答案忠实度 (LLM打分)
  答案相关性 (LLM打分)
  生成时间
```

**完整实验框架**：

```python
import time
import json
import itertools
import pandas as pd
from tqdm import tqdm
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain_community.embeddings import OpenAIEmbeddings
from langchain_community.embeddings import HuggingFaceEmbeddings
from langchain_community.vectorstores import Chroma
from langchain_openai import ChatOpenAI

class RAGExperiment:
    """RAG参数对比实验"""

    def __init__(self, docs, test_questions):
        self.docs = docs
        self.test_questions = test_questions  # list of {"question": ..., "expected_source": ...}
        self.results = []

    def run_one_config(self, chunk_size, chunk_overlap, retriever_k, search_type,
                       embedding_model, embedding_name):
        """运行一组参数配置"""
        config_name = f"CS{chunk_size}_OV{chunk_overlap}_K{retriever_k}_{search_type}_{embedding_name}"

        # 分块
        splitter = RecursiveCharacterTextSplitter(
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
            separators=["\n\n", "\n", "。", "！", "？", "；", "，", " "]
        )
        chunks = splitter.split_documents(self.docs)

        # Embedding
        if embedding_model == "openai":
            embeddings = OpenAIEmbeddings(model=embedding_name)
        else:
            embeddings = HuggingFaceEmbeddings(model_name=embedding_name)

        # 建索引
        start_time = time.time()
        vectorstore = Chroma.from_documents(documents=chunks, embedding=embeddings)
        index_time = time.time() - start_time

        # 检索器
        retriever = vectorstore.as_retriever(
            search_type=search_type,
            search_kwargs={"k": retriever_k}
        )

        # 逐题测试
        hit_count = 0
        retrieval_times = []
        for q in self.test_questions:
            q_start = time.time()
            retrieved = retriever.invoke(q["question"])
            retrieval_times.append(time.time() - q_start)

            # 判断命中
            hit = any(
                q.get("expected_source", "") in d.metadata.get("source", "")
                for d in retrieved
            )
            if hit:
                hit_count += 1

        hit_rate = hit_count / len(self.test_questions) if self.test_questions else 0
        avg_retrieval_time = sum(retrieval_times) / len(retrieval_times)

        self.results.append({
            "config": config_name,
            "chunk_size": chunk_size,
            "chunk_overlap": chunk_overlap,
            "retriever_k": retriever_k,
            "search_type": search_type,
            "embedding": embedding_name,
            "num_chunks": len(chunks),
            "index_time_s": round(index_time, 2),
            "hit_rate": round(hit_rate, 4),
            "avg_retrieval_time_ms": round(avg_retrieval_time * 1000, 1),
            "index_size_mb": round(sum(
                len(c.page_content) for c in chunks
            ) / 1024 / 1024, 2)
        })

        return self.results[-1]

    def run_all(self):
        """运行所有参数组合"""
        param_grid = [
            # (chunk_size, chunk_overlap, retriever_k, search_type, embedding_model, embedding_name)
            (128, 0, 3, "similarity", "openai", "text-embedding-3-small"),
            (256, 0, 3, "similarity", "openai", "text-embedding-3-small"),
            (256, 32, 3, "similarity", "openai", "text-embedding-3-small"),
            (512, 0, 3, "similarity", "openai", "text-embedding-3-small"),
            (512, 64, 3, "similarity", "openai", "text-embedding-3-small"),
            (512, 64, 5, "similarity", "openai", "text-embedding-3-small"),
            (1024, 0, 3, "similarity", "openai", "text-embedding-3-small"),
            (512, 64, 3, "mmr", "openai", "text-embedding-3-small"),
            (512, 64, 3, "similarity", "huggingface", "BAAI/bge-large-zh-v1.5"),
        ]

        for params in tqdm(param_grid, desc="实验进度"):
            self.run_one_config(*params)

        df = pd.DataFrame(self.results)
        df.to_csv("rag_experiment_results.csv", index=False)

        # 打印排行榜
        print("\n===== RAG实验排行榜（按Hit Rate降序）=====")
        df_sorted = df.sort_values("hit_rate", ascending=False)
        print(df_sorted[["config", "hit_rate", "avg_retrieval_time_ms", "num_chunks"]].to_string())

        return df

# 运行实验
experiment = RAGExperiment(all_docs, test_questions)
df = experiment.run_all()

# 分析：最佳参数
best = df.loc[df["hit_rate"].idxmax()]
print(f"\n最佳配置: {best['config']}")
print(f"命中率: {best['hit_rate']:.2%}")
```

**预期实验结果参考**（基于典型中文技术文档）：

| chunk_size | overlap | k  | 命中率(Hit@3) | 说明 |
|-----------|---------|----|-------------|------|
| 128       | 0       | 3  | 52%         | 信息碎片化严重 |
| 256       | 32      | 3  | 71%         | 甜点区，推荐 |
| 512       | 64      | 3  | 68%         | 适合长段落文档 |
| 1024      | 128     | 3  | 55%         | 块内噪音过多 |
| 512       | 64      | 5  | 76%         | 更多候选，但生成质量可能下降 |

这些数据说明：**不存在普适的最优参数，必须针对你的数据和场景进行实验**。这正是项目3的价值所在。

---

## 5. 推荐学习资源

**书籍**：
- 《Building LLM Apps》by Valentina Alto — 2025年出版，全面覆盖RAG设计模式
- 《Advanced RAG Patterns》by O'Reilly — 2026年新书，Graph RAG、Agent RAG等前沿内容

**论文（按阅读顺序）**：
1. Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks (Lewis et al., 2020) — RAG原论文
2. Lost in the Middle: How Language Models Use Long Contexts (Liu et al., 2023) — 理解为什么检索质量比上下文长度更重要
3. Search-Augmented Instruction Tuning (2024) — 检索增强微调
4. Graph RAG: Unlocking LLM Discovery on Narrative Private Data (Microsoft, 2024) — 知识图谱+RAG

**开源项目**：
- [langchain-ai/langchain](https://github.com/langchain-ai/langchain) — 你已熟悉
- [run-llama/llama_index](https://github.com/run-llama/llama_index) — 对比学习
- [chatchat-space/Langchain-Chatchat](https://github.com/chatchat-space/Langchain-Chatchat) — 完整的中文知识库问答项目，可做参考实现
- [FlagOpen/FlagEmbedding](https://github.com/FlagOpen/FlagEmbedding) — BGE系列Embedding模型官方仓库

**在线课程**：
- [DeepLearning.AI: Building Systems with the ChatGPT API](https://www.deeplearning.ai/) — RAG相关章节
- [LangChain官方教程](https://python.langchain.com/docs/tutorials/rag/) — 最权威的LangChain RAG教程

---

## 6. AI工具使用指南

**本月如何用AI辅助学习**：

1. **用AI作为RAG的调试助手**。当你遇到检索结果不相关时，把问题和检索结果喂给Claude/GPT，问"为什么这个结果不相关？如何改进？"

2. **用AI生成测试数据**。找AI帮你生成20-50个针对你知识库的测试问题，覆盖简单事实查询、跨文档综合、边界情况。

3. **用AI做代码审查**。把你的RAG实现代码发给AI，问"这段RAG代码有什么潜在问题？幻觉风险在哪里？"

4. **用AI解释评估结果**。把实验数据（CSV）发给AI，要求它分析模式并提出优化建议。

---

## 7. 月底自检清单

完成本月学习后，你应该能回答以下问题：

**基础概念**
- [ ] 能用自己的话向别人解释RAG的工作原理和为什么需要它
- [ ] 能画出RAG完整流水线的框图，标注每个组件的功能
- [ ] 能解释"知识截止日期"和"幻觉"两个痛点，以及RAG如何缓解

**文档处理**
- [ ] 能使用PyMuPDF/Unstructured/TextLoader加载至少3种格式的文档
- [ ] 能对中文文档正确配置RecursiveCharacterTextSplitter的separators参数
- [ ] 能解释chunk_size和chunk_overlap对检索质量的影响

**向量化与检索**
- [ ] 能对比至少两种Embedding模型在中文场景下的优劣
- [ ] 能配置Chroma的相似度阈值和MMR检索
- [ ] 能实现BM25 + 向量的混合检索
- [ ] 能解释HyDE和查询重写的原理

**生成与Prompt**
- [ ] 能设计一个防止幻觉的RAG Prompt模板
- [ ] 能实现带来源引用的回答
- [ ] 知道什么时候用"stuff"、什么时候用"map_reduce"的chain type

**评估**
- [ ] 能计算Hit Rate、MRR等检索指标
- [ ] 能构建评估数据集并运行自动化评估
- [ ] 能解读评估结果并给出优化方向

**框架对比**
- [ ] 能用LangChain和LlamaIndex分别实现RAG
- [ ] 能说出LangChain和LlamaIndex各自的适用场景

**项目交付**
- [ ] 完成了PDF阅读助手（项目1）
- [ ] 完成了AI笔记本（项目2）
- [ ] 完成了RAG对比实验并得出了有意义的结论（项目3）

---

## 8. 常见坑与解决方案

### 坑1：检索结果为空或极少

**现象**：无论问什么，检索结果都是0个或1个。

**原因分析**：
1. Embedding模型与文本语言不匹配（如用英文模型处理中文文本）
2. 相似度阈值设置太高
3. 知识库内容太少或与问题无关

**解决方案**：
```python
# 调试：查看实际相似度分数
results = vectorstore.similarity_search_with_score("你的问题", k=10)
for doc, score in results:
    print(f"相似度: {score:.4f} | 内容: {doc.page_content[:50]}")
# 如果所有分数都很低（<0.3），说明知识库中确实没有相关内容
# 如果分数中等但被过滤了，降低阈值
```

### 坑2：LLM无视上下文，自己编答案

**原因**：
1. Prompt中的约束不够强硬（没有强调"只基于上下文"）
2. LLM温度太高
3. 模型的"乐于助人"倾向压过了指令遵循

**解决方案**：
- 使用第18天的黄金模板，特别是"不知道就说不知道"条款
- 设置 temperature=0
- 尝试用不同模型，指令遵循能力：GPT-4o > Claude 4 > DeepSeek V4 > 开源模型

### 坑3：中文分块后语义断裂

**现象**：一句话被拦腰截断，检索时只能看到半句话。

**解决方案**：
- 在separators列表中加入中文标点："。", "！", "？", "；"
- 增加overlap到10-20%
- 使用TokenTextSplitter（以token为单位）而非按字符

### 坑4：多轮对话中的指代消解问题

**现象**：用户问"它的作者是谁？"，但"它"指代的是前文提到的某篇论文，LLM无法理解。

**解决方案**：
- 使用 `ConversationalRetrievalChain`，它的 `rephrase_question=True` 会自动将"它"替换为具体名词
- 或者在Prompt中加入历史对话的摘要

### 坑5：部署后知识库更新问题

**现象**：知识库更新了，但用户提问时仍然返回旧内容。

**原因**：没有正确重新加载向量数据库。

**解决方案**：
- 每次更新后调用 `vectorstore.persist()` 或设置 `persist_directory`
- 重启应用时要重新加载persist_directory
- 或用独立的脚本管理知识库更新，通过API通知应用重载

```python
# 🚫 错误方式
vectorstore = Chroma(embedding_function=embeddings)
# 没有指定 persist_directory，数据在内存中，重启后丢失

# ✅ 正确方式
vectorstore = Chroma(
    persist_directory="./chroma_db",
    embedding_function=embeddings
)
# 重启后也能恢复数据
```

### 坑6：Token消耗超出预期

**现象**：每次查询消耗大量token，成本飙升。

**原因**：
- K值太大（检索了太多文档块）
- 每个chunk太大
- 没有使用上下文压缩
- 历史对话不断累积

**解决方案**：
```
单次查询的token消耗 ≈ prompt模板固定部分 + (chunk_size × K) + 问题 + 历史对话
```
- 保持 chunk_size=256-512, K=3-4
- 启用上下文压缩
- 使用ConversationSummaryMemory替代保留完整历史
- 监控token用量

---

**结束语**：RAG是2026年AI工程师的"基础技能"而非"进阶技能"。它不复杂——核心代码不过几十行——但要把每个环节做精，需要深入理解分块、检索、生成三者的相互作用。本月的三个项目不是终点而是起点：生产级RAG系统还需要做缓存、监控、A/B测试、用户反馈闭环等工程化工作。第10个月我们将深入Agent系统，那是RAG的自然延伸——让AI不仅能"查资料"，还能"动手干活"。
