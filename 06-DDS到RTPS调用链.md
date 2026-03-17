# 06 - DDS 到 RTPS 完整调用链

**来源**: 2026-03-03 深度讲解  
**整理时间**: 2026-03-17

---

## 发送流程（DataWriter → 网络）

```
DataWriter::write(data)
  ↓
DataWriterImpl::write()
  [序列化: TypeSupport::serialize()]
  ↓
RTPSWriter::write()
  [创建 CacheChange，分配 Seq#]
  ↓
WriterHistory::add_change()
  [存入 History 缓存]
  ↓
RTPSWriter::send_to_all_readers()
  [遍历所有匹配的 ReaderProxy]
  ↓
构建 RTPS Message (DATA Submessage)
  ↓
Transport Layer (UDP/TCP/SHM)
  ↓
网络发送
```

### 关键步骤详解

#### 1. 序列化
```cpp
// TypeSupport 自动生成的序列化代码
bool serialize(void* data, eprosima::fastcdr::Cdr& cdr) {
    cdr << static_cast<HelloWorld*>(data)->id();
    cdr << static_cast<HelloWorld*>(data)->message();
    return true;
}
```

#### 2. 创建 CacheChange
```cpp
CacheChange_t* change = new CacheChange_t();
change->sequenceNumber = get_next_sequence_number();
change->serializedPayload = serialized_data;
change->writerGUID = this->guid;
```

#### 3. History 管理
```cpp
// WriterHistory::add_change()
if (history_size < qos.history.depth) {
    changes.push_back(change);
} else {
    // 根据 QoS 策略处理
    // KEEP_LAST: 丢弃最旧的
    // KEEP_ALL: 返回错误
}
```

#### 4. 发送到所有 Reader
```cpp
// RTPSWriter::send_to_all_readers()
for (auto& reader_proxy : matched_readers) {
    if (reader_proxy->is_active()) {
        send_data_to_reader(reader_proxy, change);
    }
}
```

---

## 接收流程（网络 → DataReader）

```
Transport Layer (收到 UDP 包)
  ↓
RTPSParticipantImpl::receive_message()
  ↓
解析 RTPS Message
  ↓
RTPSReader::process_data()
  ↓
ReaderHistory::add_change()
  [检查序列号，去重]
  ↓
send_acknack_if_needed()
  [发送 ACKNACK 确认]
  ↓
DataReader::take_next_sample()
  [反序列化]
  ↓
应用层获得数据
```

### 关键步骤详解

#### 1. 消息解析
```cpp
// 解析 RTPS 消息头
RTPSMessageHeader header;
header.parse(packet_data);

// 解析子消息
while (has_more_submessages) {
    SubmessageHeader submsg_header;
    submsg_header.parse(packet_data);
    
    switch (submsg_header.submessageId) {
        case DATA: process_data_submsg(); break;
        case HEARTBEAT: process_heartbeat_submsg(); break;
        case ACKNACK: process_acknack_submsg(); break;
    }
}
```

#### 2. 序列号去重
```cpp
// ReaderHistory::add_change()
if (received_sequence_numbers.count(change->seqNum) > 0) {
    // 重复数据，丢弃
    return false;
}
received_sequence_numbers.insert(change->seqNum);
changes.push_back(change);
```

#### 3. ACKNACK 决策
```cpp
// send_acknack_if_needed()
if (reliability == RELIABLE) {
    if (has_missing_changes() || heartbeat_received) {
        send_acknack();
    }
}
```

#### 4. 反序列化
```cpp
// DataReader::take_next_sample()
HelloWorld data;
TypeSupport::deserialize(change->serializedPayload, &data);
return data;
```

---

## 完整数据流图

```
┌─────────────────────────────────────────────────────────────┐
│ 发送端 (Publisher)                                           │
├─────────────────────────────────────────────────────────────┤
│ Application                                                 │
│     ↓                                                       │
│ DataWriter::write()                                         │
│     ↓                                                       │
│ ┌─────────────────────┐    ┌─────────────────────┐         │
│ │   DDS Layer         │    │   RTPS Layer        │         │
│ │ DataWriterImpl      │───→│   RTPSWriter        │         │
│ │   - 序列化          │    │     ↓               │         │
│ └─────────────────────┘    │ WriterHistory       │         │
│                            │     ↓               │         │
│                            │ ReaderProxy (×N)    │         │
│                            │     ↓               │         │
│                            │ Transport (UDP/SHM) │─────────┼──►
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                         ┌─────────────────────┐
                         │      Network        │
                         └─────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 接收端 (Subscriber)                                          │
├─────────────────────────────────────────────────────────────┤
│                            │ Transport (UDP/SHM)            │
│                            │     ↓                          │
│                            │ WriterProxy                    │
│                            │     ↓                          │
│ ┌─────────────────────┐    │ ReaderHistory     ┌───────────┐│
│ │   DDS Layer         │    │     ↓             │  RTPS     ││
│ │ DataReaderImpl      │←───│ RTPSReader        │  Layer    ││
│ │   - 反序列化        │    │     ↓             │           ││
│ └─────────────────────┘    │ process_data()    │           ││
│     ↓                      └───────────────────┘           │
│ Application                                                 │
└─────────────────────────────────────────────────────────────┘
```

---

## 关键设计模式

| 模式 | 应用位置 | 目的 |
|------|----------|------|
| 分层架构 | DDS/RTPS/Transport | 职责分离，层间松耦合 |
| 模板方法 | TypeSupport 序列化 | 用户数据类型可扩展 |
| 观察者 | ReaderListener | 数据到达通知 |
| 缓存 | History | 可靠传输和 QoS 支持 |

---

_整理自 2026-03-03 调用链详解_
