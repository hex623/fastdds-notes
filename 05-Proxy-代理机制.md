# 05 - Proxy 代理机制

**来源**: 2026-03-03 深度讲解  
**整理时间**: 2026-03-17

---

## 为什么需要 Proxy

在分布式系统中，Writer 和 Reader 位于不同节点，需要维护对方的状态信息：
- 哪些数据已发送/已确认？
- 哪些数据需要重传？
- 对方是否还存活？

Proxy 就是用来维护这些**远端端点状态**的本地代理。

---

## WriterProxy（位于 Writer 端）

### 数据结构
```cpp
struct ReaderProxy {
    GUID_t remoteReaderGuid;              // 远端 Reader ID
    SequenceNumber_t acked_seq_num;       // Reader 已确认到
    SequenceNumberSet requested_changes;  // 请求重传的序列号
    std::set<SequenceNumber_t> outstanding_changes; // 已发送未确认
    
    // QoS 匹配信息
    ReliabilityQosPolicy reliability;
    DurabilityQosPolicy durability;
    
    // 状态
    bool is_active;
    Time_t last_heartbeat_response;
};
```

### 核心职责

#### 1. 跟踪未确认数据 (outstanding_changes)
```
Writer 发送 Seq#1 → 加入 outstanding_changes
Writer 发送 Seq#2 → 加入 outstanding_changes
Reader ACKNACK(Seq#2) → 从 outstanding 移除 #1, #2
```

#### 2. 处理重传请求 (requested_changes)
```
Reader ACKNACK: "缺 Seq#3, #5"
Writer 收到 ACKNACK:
  → 将 #3, #5 加入 requested_changes
  → 从 History 读取数据
  → 重新发送
  → 从 requested_changes 移除
```

#### 3. 活性检测
- 记录最后一次收到 ACKNACK 的时间
- 超时未收到则认为 Reader 离线
- 清理对应 ReaderProxy

---

## ReaderProxy（位于 Reader 端）

### 数据结构
```cpp
struct WriterProxy {
    GUID_t remoteWriterGuid;
    SequenceNumber_t last_available_seq;   // Writer 最新序列号
    SequenceNumberSet missing_changes;     // 检测到的丢包
    Time_t last_heartbeat_time;            // 上次收到 HEARTBEAT
    
    // 预期接收序列号
    SequenceNumber_t next_expected_seq;
    
    // QoS
    ReliabilityQosPolicy reliability;
    LifespanQosPolicy lifespan;
};
```

### 核心职责

#### 1. 检测丢包 (missing_changes)
```
收到 HEARTBEAT(First=1, Last=10)
本地已收到: 1, 2, 3, 5, 6, 8, 9, 10
缺失: 4, 7
→ missing_changes = {4, 7}
→ 发送 ACKNACK 请求重传
```

#### 2. 序列号连续性检查
```
收到 DATA(Seq#5)，预期 Seq#4
→ 4 丢失！
→ 将 4 加入 missing_changes
→ 接收 5 存入 History
→ 发送 ACKNACK 请求 4
```

#### 3. 活性检测
- 记录最后一次收到 HEARTBEAT 的时间
- 超时未收到则认为 Writer 离线
- 通知应用层连接断开

---

## Proxy 创建流程

### Writer 端创建 ReaderProxy
```
SEDP 匹配成功
  ↓
Writer 得知有新的 Reader 匹配
  ↓
创建 ReaderProxy(remoteReaderGuid)
  ↓
开始发送数据
  ↓
处理 ACKNACK，维护 outstanding_changes
```

### Reader 端创建 WriterProxy
```
SEDP 匹配成功
  ↓
Reader 得知有新的 Writer 匹配
  ↓
创建 WriterProxy(remoteWriterGuid)
  ↓
接收 DATA，检测丢包
  ↓
发送 ACKNACK，请求重传
```

---

## Proxy 关系图

```
Node A                          Node B
┌─────────────────┐             ┌─────────────────┐
│ Writer          │             │ Reader          │
│ ┌─────────────┐ │             │ ┌─────────────┐ │
│ │ Writer      │ │             │ │ Reader      │ │
│ │ History     │ │             │ │ History     │ │
│ └─────────────┘ │             │ └─────────────┘ │
│       ↓         │             │       ↑         │
│ ┌─────────────┐ │   DATA      │ ┌─────────────┐ │
│ │ReaderProxy  │◄├─────────────│ WriterProxy  │ │
│ │(代表B的Reader)│ │   ACKNACK   │ │(代表A的Writer)│ │
│ └─────────────┘ │────────────►│ └─────────────┘ │
└─────────────────┘             └─────────────────┘
```

---

## 设计模式：代理模式

| 模式 | 应用 | 目的 |
|------|------|------|
| 代理模式 | WriterProxy/ReaderProxy | 维护远端端点状态，解耦本地逻辑与网络通信 |

**优点**:
- 本地操作无需关心网络细节
- 统一的状态管理
- 支持离线检测和故障恢复

---

_整理自 2026-03-03 Proxy 机制详解_
