# Fast-DDS 数据收发完整流程详解

> 📌 **代码来源说明**：本文中的代码示例分为两类：
> 1. **实际源码**：来自 [Fast-DDS 官方仓库](https://github.com/eProsima/Fast-DDS)，链接已标注
> 2. **简化示例**：为教学目的简化，省略了锁、异常处理等细节
>
> **重要更正**：文中使用的 `AsyncWriterThread` 是**概念性命名**，实际源码中的对应实现为 `FlowControllerAsyncPublishMode`，位于 `src/cpp/rtps/flowcontrol/FlowControllerImpl.hpp`

---


**创建时间**: 2026-03-10  
**源码版本**: Fast-DDS 3.5.0  
**作者**: 旭旭助手

---

## 目录

1. [Writer 发送数据流程](#一writer-发送数据流程)
2. [Reader 接收数据流程](#二reader-接收数据流程)
3. [可靠传输 vs 尽力传输对比](#三可靠传输-vs-尽力传输对比)
4. [ACKNACK 与 HEARTBEAT 交互](#四acknack-与-heartbeat-交互)
5. [完整数据流图](#五完整数据流图)
6. [关键源码解析](#六关键源码解析)

---

## 一、Writer 发送数据流程

### 1.1 整体流程图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Writer 发送数据流程                                 │
└─────────────────────────────────────────────────────────────────────────────┘

【应用层】
   │
   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 1. 应用调用 writer->write(&data)                                       │
│                                                                        │
│   DataWriter::write(void* data)                                        │
│   └── 委托给 DataWriterImpl                                            │
│       └── 序列化数据                                                    │
└────────────────────────────────────────────────────────────────────────┘
   │
   ▼
【RTPS Layer - 准备阶段】
┌────────────────────────────────────────────────────────────────────────┐
│ 2. 创建 CacheChange                                                    │
│                                                                        │
│   RTPSWriter::new_change(                                              │
│       []() { return serialized_size; },  // 数据大小计算器              │
│       ALIVE,                             // 变更类型                    │
│       instance_handle                     // 实例句柄（keyed topics）    │
│   )                                                                    │
│                                                                        │
│   └── CacheChange_t* change = new CacheChange_t()                      │
│       ├── change->kind = ALIVE                                         │
│       ├── change->writerGUID = this->m_guid                            │
│       ├── change->sequenceNumber = next_sequence_number++              │
│       ├── change->sourceTimestamp = now()                              │
│       └── 序列化数据到 change->serializedPayload                       │
└────────────────────────────────────────────────────────────────────────┘
   │
   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 3. 存入 WriterHistory                                                  │
│                                                                        │
│   WriterHistory::add_change(change)                                    │
│                                                                        │
│   └── 根据 QoS 策略管理缓存：                                           │
│       ├── KEEP_LAST: 保留最近 N 个，旧的丢弃                            │
│       └── KEEP_ALL:  保留所有（直到内存限制）                           │
│                                                                        │
│   【重要】可靠传输时，数据会保留直到被所有 Reader 确认                    │
└────────────────────────────────────────────────────────────────────────┘
   │
   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 3.5 触发数据发送 - 哪个线程？                                          │
│                                                                        │
│   取决于 PublishMode 配置：                                            │
│                                                                        │
│   【同步模式 SYNCHRONOUS】                                             │
│   ├── 当前用户线程直接发送                                             │
│   │   StatefulWriter::unsent_change_added_to_history()                 │
│   │   └── send_any_unsent_changes()  ← 同线程立即执行                   │
│   │                                                                    │
│   └── 特点：                                                           │
│       • write() 阻塞直到数据发送完成                                   │
│       • 低延迟（无线程切换）                                           │
│       • 适合实时性要求高的场景                                         │
│                                                                        │
│   【异步模式 ASYNCHRONOUS】                                            │
│   ├── 数据入队，由 FlowControllerAsyncPublishMode 发送                              │
│   │   FlowController::add_new_sample()                                 │
│   │   └── FlowControllerAsyncPublishMode::wake_up()  ← 唤醒后台线程                  │
│   │                                                                    │
│   └── FlowControllerAsyncPublishMode 工作流程：                                     │
│       while (running) {                                                │
│           for each async_writer:                                       │
│               writer->send_any_unsent_changes();                       │
│           wait_until(next_wakeup);  // 流控或新数据唤醒                 │
│       }                                                                │
│                                                                        │
│   └── 特点：                                                           │
│       • write() 立即返回（非阻塞）                                     │
│       • 支持流量控制（FlowController）                                 │
│       • 支持批量发送优化                                               │
│                                                                        │
│   【关键代码】src/cpp/rtps/writer/StatefulWriter.cpp:                  │
│   bool StatefulWriter::unsent_change_added_to_history(...) {           │
│       if (is_async()) {                                                │
│           FlowControllerAsyncPublishMode::wake_up(this);  // 异步：通知后台线程      │
│           return true;                                                 │
│       } else {                                                         │
│           return send_any_unsent_changes();  // 同步：立即发送          │
│       }                                                                │
│   }                                                                    │
└────────────────────────────────────────────────────────────────────────┘
   │
   ▼
【匹配与发送阶段】
┌────────────────────────────────────────────────────────────────────────┐
│ 4. 遍历所有匹配的 Reader                                                │
│                                                                        │
│   StatefulWriter::send(...)                                            │
│   └── for each ReaderProxy in m_matchedReaders:                        │
│       └── send_change_to_reader(change, reader_proxy)                  │
└────────────────────────────────────────────────────────────────────────┘
   │
   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 5. 数据发送（StatefulWriter）                                          │
│                                                                        │
│   ├── 5.1 添加到 ReaderProxy 的 outstanding_changes                    │
│   │       ReaderProxy::outstanding_changes[seq_num] = {                │
│   │           change,                                                  │
│   │           status = UNDERWAY,  // 在途                              │
│   │           times_nack = 0                                           │
│   │       }                                                            │
│   │                                                                    │
│   ├── 5.2 通过网络层发送                                                │
│   │       └── send_data_to_locators(change, reader_proxy->locators)    │
│   │           └── UDP/TCP/SHM 发送                                     │
│   │                                                                    │
│   └── 5.3 启动重传定时器（可靠传输）                                     │
│           └── 设置超时回调，超时后重传                                   │
└────────────────────────────────────────────────────────────────────────┘
   │
   ▼
【网络层】
   │
   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 6. RTPS 消息封装与发送                                                  │
│                                                                        │
│   RTPSMessageGroup::send(...)                                          │
│   ├── 创建 RTPS 消息头                                                  │
│   │   ├── Header: protocol version, vendor ID, guid prefix             │
│   │   └── Submessages:                                                 │
│   │       ├── DATA submessage: 序列号、时间戳、序列化数据                │
│   │       └── 可选 HEARTBEAT: 提醒 Reader 确认                          │
│   │                                                                    │
│   └── 调用 Transport 层: send_to_locator()                             │
│       ├── UDP: sendto()                                                │
│       ├── TCP: send()                                                  │
│       └── SHM: 写入共享内存                                            │
└────────────────────────────────────────────────────────────────────────┘
```

### 1.2 关键代码详解

**DataWriter::write() 流程：**

```cpp
// include/fastdds/dds/publisher/DataWriter.hpp
ReturnCode_t DataWriter::write(void* data) {
    // 1. 获取实现类
    DataWriterImpl* impl = get_impl();
    
    // 2. 序列化数据
    SerializedPayload_t payload;
    impl->type_->serialize(data, &payload);
    
    // 3. 委托给 RTPSWriter
    CacheChange_t* change = impl->writer_->new_change(
        [&payload]() -> uint32_t { return payload.length; },
        ALIVE,                              // 变更类型
        HANDLE_NIL                          // 实例句柄
    );
    
    // 4. 拷贝序列化数据
    change->serializedPayload = payload;
    
    // 5. 添加到 History
    if (!impl->history_->add_change(change)) {
        return ReturnCode_t::RETCODE_ERROR;
    }
    
    // 6. 触发发送（异步或同步）
    // StatefulWriter 会自动将 change 发送给所有匹配的 Readers
    
    return ReturnCode_t::RETCODE_OK;
}
```

**RTPSWriter::new_change()：**

```cpp
// src/cpp/rtps/writer/RTPSWriter.cpp
CacheChange_t* RTPSWriter::new_change(
    const std::function<uint32_t()>& dataSizeCalculator,
    ChangeKind_t changeKind,
    InstanceHandle_t handle) {
    
    // 1. 计算数据大小
    uint32_t size = dataSizeCalculator();
    
    // 2. 从缓存池分配 CacheChange
    CacheChange_t* change = mp_history->create_change(size);
    
    // 3. 填充元数据
    change->kind = changeKind;
    change->writerGUID = m_guid;
    change->instanceHandle = handle;
    change->sequenceNumber = ++m_current_sequence_number;
    change->sourceTimestamp = Time_t::now();
    
    return change;
}
```

**StatefulWriter::send()：**

```cpp
// src/cpp/rtps/writer/StatefulWriter.cpp
bool StatefulWriter::send(CacheChange_t* change) {
    // 1. 上锁保护
    std::lock_guard<RecursiveTimedMutex> guard(mp_mutex);
    
    // 2. 遍历所有匹配的 ReaderProxy
    for (ReaderProxy* reader : m_matchedReaders) {
        // 3. 添加到该 Reader 的在途队列
        reader->add_change_for_reader(change);
        
        // 4. 发送数据
        send_data_to_reader(change, reader);
        
        // 5. 如果是可靠传输，启动重传定时器
        if (m_isReliable) {
            schedule_nack_response(reader);
        }
    }
    
    return true;
}
```

---

## 二、Reader 接收数据流程

### 2.1 整体流程图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Reader 接收数据流程                                 │
└─────────────────────────────────────────────────────────────────────────────┘

【网络层】
   │
   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 1. 接收 RTPS 消息                                                      │
│                                                                        │
│   Transport 层接收到 UDP/TCP/SHM 数据                                  │
│   └── MessageReceiver::processCDRMsg()                                 │
│       └── 解析 RTPS Header + Submessages                               │
└────────────────────────────────────────────────────────────────────────┘
   │
   ▼
【RTPS Layer - 处理阶段】
┌────────────────────────────────────────────────────────────────────────┐
│ 2. 分发到对应的 Reader                                                 │
│                                                                        │
│   RTPSParticipantImpl::receive(...)                                    │
│   └── 根据 entityId 找到目标 Reader                                    │
│       └── 调用 RTPSReader::processDataMsg()                            │
└────────────────────────────────────────────────────────────────────────┘
   │
   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 3. 解析 DATA Submessage                                                │
│                                                                        │
│   RTPSReader::processDataMsg(...)                                      │
│   ├── 提取信息：                                                        │
│   │   ├── writer_guid = msg.writerGUID                                 │
│   │   ├── seq_num = msg.sequenceNumber                                 │
│   │   ├── data = msg.serializedPayload                                 │
│   │   └── timestamp = msg.sourceTimestamp                              │
│   │                                                                    │
│   └── 查找匹配的 WriterProxy                                            │
│       └── Reader::matched_writer_lookup(writer_guid)                   │
└────────────────────────────────────────────────────────────────────────┘
   │
   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 4. 序列号检查与去重                                                    │
│                                                                        │
│   StatefulReader::processDataMsg(...)                                  │
│   └── 检查 WriterProxy::received_sequence_numbers                      │
│       ├── 情况 A：seq_num 已经收到过                                   │
│       │   └── 丢弃（重复数据）                                         │
│       │                                                                │
│       ├── 情况 B：seq_num 是期望的下一个                                │
│       │   └── 正常接收                                                 │
│       │                                                                │
│       └── 情况 C：seq_num 大于期望值（丢包！）                          │
│           └── 标记 missing_changes[expect..seq_num-1]                  │
│           └── 存储当前数据                                             │
└────────────────────────────────────────────────────────────────────────┘
   │
   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 5. 存入 ReaderHistory                                                  │
│                                                                        │
│   ReaderHistory::received_change(change, sample_size)                  │
│   └── 根据 QoS 策略存储：                                               │
│       ├── KEEP_LAST: 保留最近 N 个                                     │
│       └── KEEP_ALL:  保留所有                                          │
└────────────────────────────────────────────────────────────────────────┘
   │
   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 6. 触发回调（异步通知）                                                 │
│                                                                        │
│   ReaderListener::onNewCacheChangeAdded(reader, change)                │
│   └── 应用层实现此回调来处理数据                                        │
└────────────────────────────────────────────────────────────────────────┘
   │
   ▼
【可靠传输反馈】
┌────────────────────────────────────────────────────────────────────────┐
│ 7. 发送 ACKNACK（StatefulReader）                                      │
│                                                                        │
│   如果启用了可靠传输：                                                  │
│   ├── 7.1 更新 received_sequence_numbers                               │
│   ├── 7.2 检查是否有缺失的序列号                                        │
│   │       └── missing_changes = get_missing_sequence_numbers()         │
│   ├── 7.3 构建 ACKNACK Submessage                                      │
│   │       ├── Base = last_received_seq + 1                             │
│   │       └── Bitmap = 接收状态位图                                    │
│   └── 7.4 发送 ACKNACK 给 Writer                                       │
│           └── 告知 Writer 哪些收到了，哪些缺失了                        │
└────────────────────────────────────────────────────────────────────────┘
   │
   ▼
【应用层】
   │
   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 8. 应用读取数据                                                        │
│                                                                        │
│   DataReader::take_next_sample(void* data, SampleInfo* info)           │
│   └── 从 ReaderHistory 读取数据                                         │
│       ├── 反序列化：type_->deserialize(&change->serializedPayload, data)│
│       ├── 填充 SampleInfo（时间戳、序列号等）                           │
│       └── 从 History 移除 change                                       │
└────────────────────────────────────────────────────────────────────────┘
```

### 2.2 关键代码详解

**MessageReceiver::processCDRMsg()：**

```cpp
// src/cpp/rtps/messages/MessageReceiver.cpp
void MessageReceiver::processCDRMsg(
    const Locator_t& source,
    const Locator_t& destination,
    CDRMessage_t& msg) {
    
    // 1. 解析 RTPS Header
    Header_t header;
    CDRMessage::readHeader(&msg, &header);
    
    // 2. 遍历所有 Submessages
    while (msg.pos < msg.length) {
        SubmessageHeader_t submsg_header;
        CDRMessage::readSubmessageHeader(&msg, &submsg_header);
        
        switch (submsg_header.submessageId) {
            case DATA:
                processDataSubmessage(msg, submsg_header, source);
                break;
            case HEARTBEAT:
                processHeartbeatSubmessage(msg, submsg_header);
                break;
            case ACKNACK:
                processAckNackSubmessage(msg, submsg_header);
                break;
            // ... 其他子消息类型
        }
    }
}
```

**RTPSReader::processDataMsg()：**

```cpp
// src/cpp/rtps/reader/RTPSReader.cpp
bool RTPSReader::processDataMsg(
    CacheChange_t* change,
    std::unique_lock<RecursiveTimedMutex>& lock) {
    
    // 1. 查找匹配的 WriterProxy
    WriterProxy* writer_proxy = nullptr;
    if (!matched_writer_lookup(change->writerGUID, &writer_proxy)) {
        // 如果接受未知 Writer 的数据
        if (!m_acceptMessagesFromUnknownWriters) {
            return false;  // 拒绝数据
        }
    }
    
    // 2. 序列号检查（StatefulReader）
    if (writer_proxy != nullptr) {
        // 检查是否是重复数据
        if (writer_proxy->received_change_set(change->sequenceNumber)) {
            return false;  // 重复，丢弃
        }
        
        // 检查是否有丢包
        SequenceNumber_t expected_seq = writer_proxy->next_expected_sequence_number();
        if (change->sequenceNumber > expected_seq) {
            // 标记缺失的序列号
            for (auto seq = expected_seq; seq < change->sequenceNumber; ++seq) {
                writer_proxy->missing_changes_add(seq);
            }
        }
    }
    
    // 3. 存入 History
    if (!mp_history->received_change(change, change->serializedPayload.length)) {
        return false;
    }
    
    // 4. 触发回调
    if (mp_listener != nullptr) {
        mp_listener->onNewCacheChangeAdded(this, change);
    }
    
    return true;
}
```

---

## 三、可靠传输 vs 尽力传输对比

| 特性 | Reliable (可靠) | Best-Effort (尽力) |
|------|----------------|-------------------|
| **确认机制** | HEARTBEAT + ACKNACK | 无 |
| **重传** | 支持 | 不支持 |
| **顺序保证** | 严格按序 | 不保证 |
| **丢包处理** | 自动重传 | 丢弃 |
| **延迟** | 较高（等待确认） | 较低 |
| **带宽** | 较高（确认开销） | 较低 |
| **应用场景** | 关键数据（控制指令） | 高频数据（传感器） |

---

## 四、ACKNACK 与 HEARTBEAT 交互

```
场景：Reliable 传输，发生丢包
────────────────────────────────────────────────────────────────────────

Writer (StatefulWriter)              Reader (StatefulReader)
        │                                    │
        │── DATA(Seq#1) ────────────────────│ ✅ 收到
        │── DATA(Seq#2) ────────────────────│ ❌ 丢失！
        │── DATA(Seq#3) ────────────────────│ ✅ 收到
        │                                    │
        │                                    │ 检测到 Seq#2 缺失
        │                                    │ missing_changes = {#2}
        │                                    │
        │── HEARTBEAT(First=1, Last=3) ─────│ "我有1-3，请确认"
        │                                    │
        │◄────── ACKNACK(Base=2) ────────────│  "2收到，但3之前缺2"
        │      Bitmap: 101 (1=收到, 0=缺失)   │
        │                                    │
        │   ReaderProxy 检查：                │
        │   - #1: ACKED                      │
        │   - #2: NACKED (需要重传)           │
        │   - #3: 未确认                      │
        │                                    │
        │── DATA(Seq#2) 【重传】─────────────│ ✅ 收到
        │   [重传标记]                        │
        │                                    │ missing_changes 清空
        │                                    │
        │◄────── ACKNACK(Base=4) ────────────│  "4之前都收到了"
        │      (Final Flag = true)            │
        │                                    │
        └── 可以从 History 删除 #1,#2,#3      │
                                           │
```

---

## 五、完整数据流图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    完整数据流：应用 → 网络 → 应用                              │
└─────────────────────────────────────────────────────────────────────────────┘

【发送端】                                    【接收端】
┌──────────────┐                              ┌──────────────┐
│   应用数据    │                              │   应用数据    │
└──────┬───────┘                              └──────┬───────┘
       │                                             │
       ▼                                             ▼
┌──────────────┐                              ┌──────────────┐
│  DataWriter  │                              │  DataReader  │
│  - write()   │                              │  - take()    │
└──────┬───────┘                              └──────┬───────┘
       │                                             │
       ▼                                             ▼
┌──────────────┐                              ┌──────────────┐
│ RTPSWriter   │◄────── RTPS Message ─────────►│ RTPSReader   │
│ - new_change │      (UDP/TCP/SHM)            │ - processData│
│ - History    │                              │ - History    │
└──────┬───────┘                              └──────┬───────┘
       │                                             │
       ▼                                             ▼
┌──────────────┐                              ┌──────────────┐
│   Transport  │                              │   Transport  │
│  (Socket层)   │                              │  (Socket层)   │
└──────┬───────┘                              └──────┬───────┘
       │                                             │
       └──────────────────► 网络 ◄──────────────────┘

【Reliable 额外流程】
Writer ◄──────── ACKNACK ──────── Reader
  │                               │
  ├── HEARTBEAT ────────────────►│
  │  (定期发送，提醒确认)           │
  │                               │
  │◄──────── NACK (丢失报告) ─────┤
  │                               │
  ├── 重传丢失的数据 ─────────────►│
  │                               │
  │◄──────── ACK (最终确认) ──────┤
```

---

## 六、关键源码解析

### 6.1 发送端核心调用链

```cpp
// 完整调用链：应用层 → DDS层 → RTPS层 → 传输层

// 1. 应用层调用
DataWriter::write(void* data)
└── DataWriterImpl::write(data)
    └── 序列化数据
    └── RTPSWriter::new_change(size_calculator, kind, handle)
        └── 创建 CacheChange_t
        └── 分配序列号
        └── 填充元数据
    └── RTPSWriter::send(change)
        └── StatefulWriter::send(change)
            └── for each ReaderProxy:
                ├── ReaderProxy::add_change_for_reader(change)
                └── send_data_to_reader(change, reader)
                    └── RTPSMessageGroup::send()
                        └── 构建 RTPS 消息
                        └── Transport::send_to_locator()
                            └── UDP/TCP/SHM 发送
```

### 6.2 接收端核心调用链

```cpp
// 完整调用链：传输层 → RTPS层 → DDS层 → 应用层

// 1. 传输层接收
Transport::receive()
└── MessageReceiver::processCDRMsg()
    └── 解析 RTPS Header
    └── for each Submessage:
        └── processDataSubmessage()
            └── RTPSParticipantImpl::find_reader(entityId)
            └── RTPSReader::processDataMsg(change)
                └── StatefulReader::processDataMsg(change)
                    ├── WriterProxy::lookup(writer_guid)
                    ├── WriterProxy::received_change_set(seq) // 去重检查
                    ├── ReaderHistory::received_change(change)
                    └── ReaderListener::onNewCacheChangeAdded()
                        └── 触发应用回调
                        └── DataReader::take_next_sample()
                            └── 反序列化数据
                            └── 返回给应用
```

### 6.3 数据生命周期

```
【发送端数据生命周期】

应用数据
    │
    ▼ (write)
序列化 → CacheChange_t
    │
    ▼ (add_change)
WriterHistory [暂存]
    │
    ▼ (send)
网络传输
    │
    ▼ (收到 ACK)
从 History 删除

─────────────────────────────────────────

【接收端数据生命周期】

网络接收
    │
    ▼ (processDataMsg)
反序列化 → CacheChange_t
    │
    ▼ (received_change)
ReaderHistory [暂存]
    │
    ▼ (take)
应用处理
    │
    ▼ (return_loan)
从 History 删除
```

---

## 总结

| 阶段 | Writer 关键操作 | Reader 关键操作 |
|------|----------------|----------------|
| **准备** | 创建 CacheChange，分配序列号 | 接收网络数据，解析消息 |
| **存储** | 存入 WriterHistory | 存入 ReaderHistory |
| **传输** | 发送给所有匹配的 Readers | 接收并检查序列号 |
| **确认** | 等待 ACKNACK，必要时重传 | 发送 ACKNACK 反馈 |
| **清理** | 收到 ACK 后删除 | 应用读取后删除 |

---

_文档版本: 1.0  
最后更新: 2026-03-10  
作者: 旭旭助手_