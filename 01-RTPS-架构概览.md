# 01 - RTPS 架构概览

**来源**: 2026-02-27, 2026-02-28  
**整理时间**: 2026-03-17

---

## 核心类结构

```
RTPSDomain (单例管理类)
├── createParticipant() → RTPSParticipant
├── createRTPSWriter() → RTPSWriter
└── createRTPSReader() → RTPSReader

RTPSParticipant
├── 管理 Writers/Readers
├── 内置协议 (BuiltinProtocols)
└── 发现机制 (Discovery)

Endpoint (基类)
├── RTPSWriter (发送端)
│   ├── WriterHistory (缓存)
│   └── FlowController (流控)
└── RTPSReader (接收端)
    ├── ReaderHistory (缓存)
    └── ReaderListener (回调)
```

---

## 关键文件位置

| 类 | 头文件 | 功能 |
|----|--------|------|
| RTPSDomain | `include/fastdds/rtps/RTPSDomain.hpp` | 域管理单例 |
| RTPSParticipant | `include/fastdds/rtps/participant/RTPSParticipant.hpp` | 参与者 |
| Endpoint | `include/fastdds/rtps/Endpoint.hpp` | 端点基类 |
| RTPSWriter | `include/fastdds/rtps/writer/RTPSWriter.hpp` | 写入器 |
| RTPSReader | `include/fastdds/rtps/reader/RTPSReader.hpp` | 读取器 |
| WriterHistory | `include/fastdds/rtps/history/WriterHistory.hpp` | 历史缓存 |

---

## 类关系详解

### RTPSDomain - 单例工厂
- **模式**: 单例模式 (Singleton)
- **职责**: 
  - 管理所有 RTPSParticipant
  - 创建/销毁 Writer/Reader
  - 全局资源管理

### RTPSParticipant - 容器
- **Pimpl 模式**: 实现隐藏
- **职责**:
  - 管理本地 Writers/Readers
  - 参与发现协议
  - 内置协议处理 (SPDP/SEDP)

### Endpoint - 抽象基类
- **抽象工厂**: 统一 Writer/Reader 接口
- **职责**:
  - 定义通用端点行为
  - 管理 QoS 策略
  - 提供状态查询

### Writer/Reader 对
- **职责分离**:
  - Writer: 数据发送、序列号管理、重传
  - Reader: 数据接收、去重、ACKNACK

---

## DDS → RTPS 层映射

| DDS 层 | RTPS 层 | 关系 |
|--------|---------|------|
| DomainParticipant | RTPSParticipant | 1:1 |
| Publisher | - | 逻辑分组 |
| DataWriter | RTPSWriter | 1:1 |
| Subscriber | - | 逻辑分组 |
| DataReader | RTPSReader | 1:1 |
| Topic | - | 匹配标识 |

---

## 关键设计模式

| 模式 | 应用 | 目的 |
|------|------|------|
| 单例 | RTPSDomain | 全局唯一入口 |
| Pimpl | RTPSParticipant | 隐藏实现细节 |
| 抽象工厂 | Endpoint | 统一接口 |
| 代理 | WriterProxy/ReaderProxy | 维护远端状态 |

---

_整理自 2026-02-27 源码分析笔记_
