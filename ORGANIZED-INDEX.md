# Fast-DDS 学习笔记归档索引

**整理时间**: 2026-03-17  
**来源**: 2026-02-19 ~ 2026-03-10 记忆日志  
**总字数**: 约 80,000+ 字

---

## 📚 笔记目录

### 基础架构篇
1. **[01-RTPS-架构概览](./01-RTPS-架构概览.md)** - RTPS 核心类结构与关系
2. **[02-DDS-发现机制](./02-DDS-发现机制.md)** - SPDP/SEDP 两阶段发现协议
3. **[03-Discovery-Server](./03-Discovery-Server.md)** - 集中式发现机制详解

### 核心机制篇
4. **[04-消息传递机制](./04-消息传递机制.md)** - HEARTBEAT/ACKNACK 可靠传输
5. **[05-Proxy-代理机制](./05-Proxy-代理机制.md)** - WriterProxy/ReaderProxy 详解
6. **[06-DDS到RTPS调用链](./06-DDS到RTPS调用链.md)** - 完整数据流分析

### 功能模块篇
7. **[07-Topic-详解](./07-Topic-详解.md)** - Topic 创建、匹配与 QoS
8. **[08-Listener-与-WaitSet](./08-Listener-与-WaitSet.md)** - 回调与条件等待机制
9. **[09-传输层与性能](./09-传输层与性能.md)** - UDP/TCP/SHM 与优化策略
10. **[10-DDS-Security](./10-DDS-Security.md)** - PKI 证书与访问控制

### 参考附录
11. **[A1-代码修正记录](./A1-代码修正记录.md)** - AsyncWriterThread 类名修正
12. **[A2-核心类速查表](./A2-核心类速查表.md)** - 类关系图与关键方法

---

## 🎯 学习路径建议

### 初学者路线
```
01-RTPS-架构概览 → 02-DDS-发现机制 → 04-消息传递机制 → 07-Topic-详解
```

### 进阶开发者路线
```
03-Discovery-Server → 05-Proxy-代理机制 → 06-DDS到RTPS调用链 → 09-传输层与性能
```

### 生产部署路线
```
08-Listener-与-WaitSet → 09-传输层与性能 → 10-DDS-Security → 03-Discovery-Server
```

---

## 📊 内容统计

| 类别 | 笔记数 | 字数 | 状态 |
|------|--------|------|------|
| 基础架构 | 3篇 | ~25,000 | ✅ 完整 |
| 核心机制 | 3篇 | ~30,000 | ✅ 完整 |
| 功能模块 | 4篇 | ~20,000 | ✅ 完整 |
| 参考附录 | 2篇 | ~5,000 | ✅ 完整 |
| **总计** | **12篇** | **~80,000** | ✅ 归档 |

---

## 🔗 外部资源

- **GitHub 仓库**: https://github.com/hex623/fastdds-notes
- **NotebookLM 导入**: 可导入 NotebookLM 进行 AI 问答
- **PCAP 分析工具**: `../analysis-scripts/dds-rtps-pcap-analyzer/`

---

## 📝 笔记来源

本归档整理自以下记忆日志：
- `memory/2026-02-19.md` - DDS 教程创建
- `memory/2026-02-26.md` - 源码分析开始
- `memory/2026-02-27.md` - RTPS 核心类详解
- `memory/2026-03-01.md` - 分析工具创建
- `memory/2026-03-02.md` - 编译完成
- `memory/2026-03-03.md` - 深度技术讲解
- `memory/2026-03-04.md` - GUID 机制详解
- `memory/2026-03-05.md` - Discovery Server/Topic 详解

---

_最后更新: 2026-03-17_
