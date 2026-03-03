# 09 进阶主题：可靠传输与发现协议深度解析

**记录时间**: 2026-03-03  
**学习时长**: 约 3 小时  
**前置知识**: 01-08 基础笔记

---

## 1. ACKNACK 与 HEARTBEAT 协议交互

### 1.1 核心概念

| 子消息 | 方向 | 作用 | 类比 |
|--------|------|------|------|
| **HEARTBEAT** | Writer → Reader | "我有这些数据，请确认" | 快递发货通知 |
| **ACKNACK** | Reader → Writer | "收到这些，缺这些，请补发" | 签收回执 |

### 1.2 HEARTBEAT 消息结构

```cpp
struct HeartbeatSubmessage {
    EntityId_t writerId;               // 发送者 Writer ID
    EntityId_t readerId;               // 目标 Reader ID
    
    SequenceNumber_t firstAvailableSeqNum;  // 我有的第一个序列号
    SequenceNumber_t lastAvailableSeqNum;   // 我有的最后一个序列号
    
    Count_t count;                     // 心跳计数器（去重）
    bool finalFlag;                    // true = 不要求回复
};
```

**发送时机**:
- 定期发送（默认 10s 周期）
- 发送数据后立即发送（提醒确认）
- 新 Reader 匹配时立即发送

### 1.3 ACKNACK 消息结构

```cpp
struct AckNackSubmessage {
    EntityId_t readerId;               // 发送者 Reader ID
    EntityId_t writerId;               // 目标 Writer ID
    
    SequenceNumberSet readerSNState;   // 位图：哪些收到/缺失
    // Base: 基准序列号
    // Bitmap: 每个 bit 表示一个序列号（1=收到，0=缺失）
    
    Count_t count;                     // 计数器
    bool finalFlag;                    // true = 全部收到
};
```

### 1.4 位图示例

```
Reader 收到 HEARTBEAT: "我有 Seq#10-20"
Reader 实际状态：
  收到: #10, #11, #12, #15, #16, #20
  缺失: #13, #14, #17, #18, #19

ACKNACK:
  Base = 10
  Bitmap = 1110001110001 (13位)
           │││└─┴─┴──┴── #13, #14 缺失 (0)
           ││└───────── #15, #16 收到 (1)
           │└────────── #17, #18, #19 缺失 (0)
           └─────────── #20 收到 (1)
```

### 1.5 完整交互流程

```
场景 A：正常传输
─────────────────────────
Writer                  Reader
  │                       │
  │── DATA(Seq#1) ───────►│  "收到包裹1"
  │── DATA(Seq#2) ───────►│  "收到包裹2"
  │                       │
  │── HEARTBEAT(1-2) ────►│  "我有1-2，请确认"
  │                       │
  │◄── ACKNACK(ACK到3) ───│  "3之前都收到了"
  │                       │
  └── 继续发送 Seq#3...

场景 B：丢包重传
─────────────────────────
Writer                  Reader
  │                       │
  │── DATA(Seq#1) ───────►│ ✅ 收到
  │── DATA(Seq#2) ───────►│ ❌ 丢失
  │── DATA(Seq#4) ───────►│ ✅ 收到（发现缺#3！）
  │                       │
  │── HEARTBEAT(1-4) ────►│
  │                       │
  │◄── ACKNACK(NACK#2) ───│  "收到了1和4，但2缺失！"
  │                       │
  │── DATA(Seq#2) 【重传】►│ ✅ 收到
  │                       │
  │◄── ACKNACK(ACK到5) ───│  "现在5之前都收到了"
```

### 1.6 关键机制

| 机制 | 作用 |
|------|------|
| **序列号去重** | Reader 丢弃重复序列号，防止重复处理 |
| **延迟 ACK** | Reader 等待 50ms 后批量确认，减少网络往返 |
| **NACK 抑制** | 防止 Reader 频繁发送 NACK 导致重传风暴 |
| **指数退避** | 重传间隔：1s → 2s → 4s → 8s... |

---

## 2. WriterProxy / ReaderProxy 代理机制

### 2.1 设计思想

**问题**: Writer 如何管理多个匹配的 Reader？如何跟踪每个 Reader 的接收状态？

**解决方案**: 为每个匹配的远端端点创建一个 **Proxy**（代理），维护其状态。

### 2.2 ReaderProxy（Writer 端）

```cpp
// Writer 为每个匹配的 Reader 维护一个 ReaderProxy
struct ReaderProxy {
    // 身份
    GUID_t remoteReaderGuid;           // 远端 Reader 的唯一 ID
    LocatorList_t remoteLocators;      // 网络地址（往哪发）
    
    // 可靠性跟踪（关键！）
    SequenceNumber_t acked_seq_num;    // Reader 已确认收到的最高序列号
    SequenceNumberSet requested_changes;  // Reader 请求重传的序列号
    
    // 已发送但未确认的数据（在途数据）
    struct ChangeForReader {
        CacheChange_t* change;
        ChangeStatus status;           // UNSENT, REQUESTED, ACKNOWLEDGED
        uint32_t times_nack;           // 被 NACK 的次数
    };
    std::map<SequenceNumber_t, ChangeForReader> outstanding_changes;
};
```

**职责**:
- 跟踪每个 Reader 的确认状态
- 管理重传队列
- 处理 NACK 请求

### 2.3 WriterProxy（Reader 端）

```cpp
// Reader 为每个匹配的 Writer 维护一个 WriterProxy
struct WriterProxy {
    // 身份
    GUID_t remoteWriterGuid;           // 远端 Writer 的唯一 ID
    LocatorList_t remoteLocators;      // 网络地址（从哪收）
    
    // 接收窗口管理
    SequenceNumber_t last_available_seq;   // 最后收到的序列号
    SequenceNumber_t max_available_seq;    // 期望的下一个序列号
    SequenceNumberSet missing_changes;     // 缺失的序列号集合
    
    // 心跳跟踪
    Time_t last_heartbeat_time;        // 上次收到 HEARTBEAT 时间
    SequenceNumber_t writer_first_seq; // Writer 声明的第一个序列号
    SequenceNumber_t writer_last_seq;  // Writer 声明的最后一个序列号
};
```

**职责**:
- 跟踪 Writer 的宣告范围
- 检测丢包（missing_changes）
- 发送 ACKNACK

### 2.4 交互示例

```
Writer (有 ReaderProxy)          Reader (有 WriterProxy)
        │                                │
        │── DATA(Seq#5) ────────────────►│
        │   outstanding[5]=UNSENT        │ 收到 #5
        │   → UNDERWAY                   │
        │                                │
        │── HEARTBEAT(First=1, Last=5) ─►│
        │                                │ last_available_seq=5
        │                                │
        │◄──────── ACKNACK(Base=6) ──────│  "6之前都收到了"
        │   outstanding[5].status        │
        │   = ACKNOWLEDGED               │
        │                                │
        │  （可以从 History 删除 #5）      │
```

---

## 3. DDS → RTPS 完整调用链

### 3.1 发送流程

```
应用层调用
    │
    ▼
DataWriter::write(const void* data)
    │
    ├── 1. 序列化数据
    │   TypeSupport::serialize(data, &payload)
    │
    ▼
DataWriterImpl::write(payload, params)
    │
    ▼
RTPSWriter::write(payload)
    │
    ├── 2. 创建 CacheChange
    │   change->sequenceNumber = ++highest_seq_num_
    │   change->serializedPayload = payload
    │
    ├── 3. 存入 History
    │   WriterHistory::add_change(change)
    │   （根据 QoS: KEEP_LAST/KEEP_ALL）
    │
    ├── 4. 发送给所有匹配的 Readers
    │   for (ReaderProxy* reader : matched_readers_) {
    │       send_data_to_reader(reader, change)
    │       reader->outstanding_changes[seq] = UNDERWAY
    │   }
    │
    ▼
构建 RTPS Message
    ├── Header (协议标识、版本、GUID前缀)
    ├── DATA Submessage
    │   ├── writerId
    │   ├── sequenceNumber
    │   └── serializedPayload
    └── ...
    │
    ▼
Transport Layer (UDP/TCP/SHM)
    └── 网络发送
```

### 3.2 接收流程

```
Transport Layer 接收数据
    │
    ▼
RTPSParticipantImpl::receive_message()
    │
    ├── 解析 RTPS Header
    ├── 遍历 Submessages:
    │   case DATA: process_data_submessage()
    │   case HEARTBEAT: process_heartbeat()
    │   case ACKNACK: process_acknack()
    │
    ▼
RTPSReader::process_data(change)
    │
    ├── 1. 检查序列号（去重）
    │   if (change->seq <= last_received_seq_) return false
    │
    ├── 2. 存入 History
    │   ReaderHistory::add_change(change)
    │
    ├── 3. 检查缺失
    │   if (has_gaps()) requested_changes_.add(missing)
    │
    ├── 4. 发送 ACKNACK（可靠传输）
    │   if (is_reliable_) send_acknack()
    │
    ├── 5. 通知应用层
    │   listener_->on_data_available(this)
    │
    ▼
DataReader::take_next_sample(&data, &info)
    │
    ├── 从 ReaderHistory 取出 CacheChange
    ├── TypeSupport::deserialize(payload, data)
    ├── 填充 SampleInfo
    │   info->source_timestamp
    │   info->sequence_number
    │
    ▼
应用层获得反序列化后的数据
```

### 3.3 关键转换点

| DDS 层 | RTPS 层 | 转换内容 |
|--------|---------|----------|
| DataWriter::write() | RTPSWriter::write() | DDS QoS → RTPS Attributes |
| void* data | SerializedPayload_t | 序列化（CDR/CDR2） |
| Topic | TopicName + TypeName | 主题标识 |
| ReliabilityQos | ReliabilityKind | RELIABLE/BEST_EFFORT |
| HistoryQos | HistoryKind | KEEP_LAST/KEEP_ALL |

---

## 4. SEDP 发现匹配流程

### 4.1 匹配条件

**必须同时满足**:
1. **主题名称相同** (topic_name == topic_name)
2. **类型名称兼容** (type_name == type_name)
3. **QoS 兼容**:

| Writer QoS | Reader QoS | 结果 | 说明 |
|------------|------------|------|------|
| RELIABLE | RELIABLE | ✅ | 完全匹配 |
| RELIABLE | BEST_EFFORT | ❌ | 可靠 Writer 不能匹配不可靠 Reader |
| BEST_EFFORT | RELIABLE | ✅ | 降级匹配 |
| BEST_EFFORT | BEST_EFFORT | ✅ | 完全匹配 |
| TRANSIENT_LOCAL | VOLATILE | ✅ | 降级匹配 |
| VOLATILE | TRANSIENT_LOCAL | ❌ | 不兼容 |

### 4.2 匹配流程

```
Simple Discovery (去中心化):
────────────────────────────
Writer 创建
    │
    ▼
SEDP::announceWriter() → 组播 DATA(w)
    │                        │
    │                        ▼
    │◄───────────────────── Reader 收到 DATA(w)
    │                        ├── check_matching()
    │                        │   ├── 主题相同？✅
    │                        │   ├── 类型兼容？✅
    │                        │   └── QoS 兼容？✅
    │                        │
    │                        ├── 匹配成功！
    │                        ├── 创建 WriterProxy
    │                        └── 发送 DATA(r) 回应
    │
    ├── 收到 DATA(r)
    ├── 创建 ReaderProxy
    └── 建立连接
```

### 4.3 数据结构

```cpp
// Writer 宣告信息
struct WriterProxyData {
    GUID_t guid;                       // Writer GUID
    GUID_t participantGuid;            // 所属 Participant
    string_255 topicName;              // 主题名称
    string_255 typeName;               // 类型名称
    TopicQos topicQos;                 // 主题 QoS
    WriterQos writerQos;               // Writer QoS
    LocatorList_t unicastLocatorList;  // 单播地址
};

// Reader 宣告信息
struct ReaderProxyData {
    GUID_t guid;
    GUID_t participantGuid;
    string_255 topicName;
    string_255 typeName;
    TopicQos topicQos;
    ReaderQos readerQos;
    LocatorList_t unicastLocatorList;
};
```

---

## 5. Discovery Server 模式

### 5.1 架构对比

| 特性 | Simple Discovery | Discovery Server |
|------|-----------------|------------------|
| **宣告方式** | 组播/广播给所有 Participant | 单播给 Server |
| **数据库位置** | 每个 Participant 自己维护 | Server 集中维护 |
| **匹配触发** | 双方互相宣告后本地匹配 | Server 推送匹配信息 |
| **网络流量** | O(N²) - 随节点数平方增长 | O(N) - 线性增长 |
| **跨网段** | ❌ 困难 | ✅ 容易 |
| **NAT/防火墙** | ❌ 困难 | ✅ 只需开放 Server 端口 |

### 5.2 Client 配置

```cpp
// Participant 作为 Discovery Server Client
DomainParticipantQos qos;

// 设置为 CLIENT
qos.wire_protocol().builtin.discovery_config.discoveryProtocol = 
    DiscoveryProtocol::CLIENT;

// 指定 Server 地址
Locator_t server_locator;
server_locator.kind = LOCATOR_KIND_UDPv4;
server_locator.port = 56542;
IPLocator::setIPv4(server_locator, "192.168.1.100");

qos.wire_protocol().builtin.discovery_config.m_DiscoveryServers.push_back(server_locator);

// 可以配置多个 Server 实现冗余
Locator_t server2;
server2.port = 56542;
IPLocator::setIPv4(server2, "192.168.1.101");
qos.wire_protocol().builtin.discovery_config.m_DiscoveryServers.push_back(server2);
```

### 5.3 Server 端匹配

```
集中式匹配:
─────────────────────────
Client A (Writer)         Server                    Client B (Reader)
    │                        │                           │
    ├── Writer 宣告 ────────►│                           │
    │   DATA(w)              │                           │
    │                        │                           │
    │                        │◄──────── Reader 宣告 ─────┤
    │                        │           DATA(r)         │
    │                        │                           │
    │                        ├── 匹配检查 ──────────────┤
    │                        │   Topic: Hello ✅        │
    │                        │   Type: HelloWorld ✅    │
    │                        │   QoS: 兼容 ✅           │
    │                        │                           │
    │                        ├── 匹配成功！              │
    │                        │                           │
    ├──◄ 推送匹配结果 ───────┤                           │
    │   "有个 Reader 匹配你"  │                           │
    │                        ├── 推送匹配结果 ─────────►│
    │                        │   "有个 Writer 匹配你"    │
    │                        │                           │
    ├── 建立连接 ────────────┼──────────────────────────►│
```

### 5.4 Server 冗余

**特点**:
- Client 配置多个 Server 地址
- 向 **所有 Server** 宣告
- 从 **任意一个 Server** 接收匹配信息
- Server 之间 **不需要通信**（无状态）
- 部分 Server 故障不影响发现功能

### 5.5 心跳保活

**Client → Server**:
- 周期性 PDP 宣告（默认 3s 周期）
- 声明租约期限（默认 20s）
- Server 超过租约未收到则清理条目

**Server → Client**:
- 响应中附带 Server 租约（默认 10s）
- Client 检测 Server 是否存活
- Server 超时则切换到其他 Server

### 5.6 持久化

**问题**: Server 重启后发现数据库丢失

**解决方案**:
- 定期将数据库保存到磁盘（JSON）
- 重启时加载持久化数据
- 标记为"待验证"，等待 Client 重新宣告确认
- 清理未重新宣告的条目（崩溃节点）
- 实现秒级恢复

```cpp
// 持久化配置
qos.wire_protocol().builtin.discovery_config.persistence.enabled = true;
qos.wire_protocol().builtin.discovery_config.persistence.filename = 
    "/var/lib/fastdds/server-db.json";
qos.wire_protocol().builtin.discovery_config.persistence.autosave_period = 
    Duration_t(5, 0);  // 5秒自动保存
```

---

## 6. 关键设计模式总结

| 模式 | 应用位置 | 目的 |
|------|---------|------|
| **单例 (Singleton)** | RTPSDomain | 全局唯一入口，管理所有 Participant |
| **Pimpl (Pointer to Implementation)** | RTPSParticipant | 隐藏实现细节，接口稳定 |
| **抽象基类 (ABC)** | Endpoint | 统一 Writer/Reader 接口 |
| **工厂 (Factory)** | RTPSDomain::createParticipant | 创建 Participant |
| **代理 (Proxy)** | WriterProxy/ReaderProxy | 维护远端端点状态 |
| **租约 (Lease)** | 心跳机制 | 故障检测 |
| **发布订阅 (Pub-Sub)** | RTPS 消息 | 解耦发送接收 |
| **位图 (Bitmap)** | ACKNACK | 高效确认大量序列号 |

---

## 7. 学习建议

### 下一步深入学习

1. **阅读源码**:
   - `Fast-DDS/src/cpp/rtps/writer/StatefulWriter.cpp`
   - `Fast-DDS/src/cpp/rtps/builtin/discovery/endpoint/EDPSimple.cpp`
   - `Fast-DDS/src/cpp/rtps/builtin/discovery/participant/PDPClient.cpp`

2. **调试练习**:
   - 使用 Wireshark 抓取 RTPS 包，观察 HEARTBEAT/ACKNACK
   - 修改 QoS，观察匹配行为变化

3. **实践部署**:
   - 配置 Discovery Server 模式
   - 测试 Server 故障转移

---

## 参考链接

- [01 RTPS源码分析](./01-RTPS-Source-Analysis.md)
- [03 发现机制](./03-Discovery-Mechanism.md)
- Fast-DDS 官方文档: https://fast-dds.docs.eprosima.com/
