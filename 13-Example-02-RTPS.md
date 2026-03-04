# Example 02: RTPS - 底层 API 实战

**示例路径**: `Fast-DDS/examples/cpp/rtps/`  
**学习目标**: 理解 RTPS 层 API，掌握比 DDS 层更细粒度的控制  
**难度**: ⭐⭐ 进阶  
**预计时长**: 45分钟

---

## 🎯 学习目标

1. 理解 RTPS 层与 DDS 层的区别
2. 掌握 RTPSWriter 和 RTPSReader 的直接使用
3. 理解 History、CacheChange 等底层概念
4. 学习自定义序列化/反序列化

---

## 📚 RTPS vs DDS 对比

| 特性 | DDS 层 | RTPS 层 |
|------|--------|---------|
| **抽象级别** | 高（面向 Topic） | 低（面向 Endpoint） |
| **易用性** | 简单，开箱即用 | 复杂，需要更多配置 |
| **灵活性** | 受限（标准 QoS） | 高（可定制协议参数） |
| **性能** | 好 | 更好（减少开销） |
| **适用场景** | 一般应用 | 性能敏感、协议研究 |

**关键区别**:
- DDS 层：DataWriter → 主题名 → DataReader
- RTPS 层：RTPSWriter → GUID → RTPSReader（无主题概念）

---

## 📁 源码结构

```
rtps/
├── CMakeLists.txt
├── README.md
├── Application.hpp/cpp       # 应用基类
├── WriterApp.hpp/cpp         # RTPS Writer 实现
├── ReaderApp.hpp/cpp         # RTPS Reader 实现
├── CLIParser.hpp             # 命令行解析
└── HelloWorld.hpp            # 数据类型（IDL生成）
```

---

## 🔍 核心源码分析

### 1. RTPS 实体创建流程

```cpp
// RTPS 层不需要 DomainParticipant、Publisher、Subscriber
// 直接使用 RTPSDomain 创建 RTPSParticipant

bool WriterApp::init()
{
    // Step 1: 创建 RTPSParticipant
    // RTPSParticipant 是 RTPS 层的入口
    RTPSParticipantAttributes participant_attr;
    participant_attr.setName("RTPSWriterParticipant");
    
    // 配置发现协议（可以禁用发现，使用静态配置）
    participant_attr.builtin.discovery_config.discoveryProtocol =
        DiscoveryProtocol::SIMPLE;
    
    rtps_participant_ = RTPSDomain::createParticipant(
        0,               // Domain ID
        participant_attr);
    
    // Step 2: 注册类型（同 DDS 层）
    HelloWorldTypeSupport type_support;
    type_support.register_type(rtps_participant_, type_support.get_type_name());
    
    // Step 3: 创建 RTPSWriter
    // 不需要 Topic，直接指定 TopicName 和 TypeName
    HistoryAttributes history_attr;
    history_attr.payloadMaxSize = 255;  // 最大 payload 大小
    writer_history_ = new WriterHistory(history_attr);
    
    WriterAttributes writer_attr;
    writer_attr.endpoint.topicKind = NO_KEY;  // 无 Key（非实例化）
    writer_attr.endpoint.reliabilityKind = RELIABLE;  // 可靠传输
    writer_attr.endpoint.topicName = "HelloWorldTopic";
    writer_attr.endpoint.typeName = type_support.get_type_name();
    
    // 创建 Writer，传入 History
    rtps_writer_ = RTPSDomain::createRTPSWriter(
        rtps_participant_,
        writer_attr,
        writer_history_,
        this);  // Listener
    
    return true;
}
```

**学习要点**:
- RTPS 层直接操作 History，而不是通过 DataWriter
- 需要手动管理 History 的生命周期
- TopicName 只是标识，不参与 Topic 对象创建

---

### 2. 自定义序列化

```cpp
// RTPS 层需要手动序列化数据
bool WriterApp::serialize_data(
    const HelloWorld& hello,
    SerializedPayload_t* payload)
{
    // 计算序列化后的大小
    size_t data_size = sizeof(uint32_t) +  // index
                       sizeof(uint32_t) + hello.message().size();  // message
    
    // 分配 payload 内存
    payload->reserve(data_size);
    payload->length = data_size;
    
    // 手动序列化（简单示例）
    uint8_t* ptr = payload->data;
    
    // 写入 index
    memcpy(ptr, &hello.index(), sizeof(uint32_t));
    ptr += sizeof(uint32_t);
    
    // 写入 message 长度
    uint32_t msg_len = hello.message().size();
    memcpy(ptr, &msg_len, sizeof(uint32_t));
    ptr += sizeof(uint32_t);
    
    // 写入 message 内容
    memcpy(ptr, hello.message().data(), msg_len);
    
    return true;
}

// 在 Writer 中创建 CacheChange 并写入
void WriterApp::run()
{
    uint32_t index = 0;
    
    while (!stop_signal_.load())
    {
        // 创建 CacheChange
        // CacheChange 是 RTPS 传输的基本单元
        CacheChange_t* change = writer_history_-&gt;create_change(
            ALIVE,                    // ChangeKind：数据有效
            type_support_.get_key()); // InstanceHandle（无 Key 时为无效值）
        
        if (change != nullptr)
        {
            // 序列化数据到 change->serializedPayload
            HelloWorld hello;
            hello.index(++index);
            hello.message("Hello World");
            
            serialize_data(hello, &change->serializedPayload);
            
            // 添加到 History，触发发送
            writer_history_-&gt;add_change(change);
            
            std::cout &lt;&lt; "Message Hello World with index " &lt;&lt; index &lt;&lt; " SENT" &lt;&lt; std::endl;
        }
        
        std::this_thread::sleep_for(std::chrono::seconds(1));
    }
}
```

**学习要点**:
- CacheChange_t 是 RTPS 层的核心数据结构
- 包含序列化后的 payload、序列号、时间戳等
- WriterHistory 管理 CacheChange 的存储和生命周期

---

### 3. RTPS Reader 实现

```cpp
// Reader 同样需要手动反序列化
void ReaderApp::onNewCacheChangeAdded(
    RTPSReader* reader,
    const CacheChange_t* const change)
{
    // 收到新的 CacheChange
    if (change->kind == ALIVE)  // 确认是有效数据（不是删除通知）
    {
        HelloWorld hello;
        
        // 反序列化
        if (deserialize_data(change->serializedPayload, &hello))
        {
            std::cout << "Message: " << hello.message()
                      << " with index " << hello.index()
                      << " RECEIVED" << std::endl;
        }
    }
    
    // 🔴 重要：Reader 必须释放 CacheChange
    // 与 DDS 层不同，RTPS 层不自动管理内存
    reader->getHistory()-&gt;remove_change(const_cast&lt;CacheChange_t*&gt;(change));
}

bool ReaderApp::deserialize_data(
    const SerializedPayload_t& payload,
    HelloWorld* hello)
{
    const uint8_t* ptr = payload.data;
    
    // 读取 index
    uint32_t index;
    memcpy(&index, ptr, sizeof(uint32_t));
    ptr += sizeof(uint32_t);
    hello->index(index);
    
    // 读取 message 长度
    uint32_t msg_len;
    memcpy(&msg_len, ptr, sizeof(uint32_t));
    ptr += sizeof(uint32_t);
    
    // 读取 message 内容
    hello->message(std::string((char*)ptr, msg_len));
    
    return true;
}
```

**学习要点**:
- Reader 需要手动释放 CacheChange，否则内存泄漏
- onNewCacheChangeAdded 是 RTPSReaderListener 的回调
- 需要处理 ChangeKind（ALIVE/NOT_ALIVE_DISPOSED 等）

---

## 🏗️ RTPS 架构图

```
RTPS Layer Architecture
═══════════════════════════════════════════════════════

Writer Side:
┌─────────────────────────────────────────────────────┐
│  Application                                        │
│  └── serialize() → create CacheChange → add History │
└────────────────────┬────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────┐
│  RTPSWriter                                         │
│  ├── WriterHistory (CacheChange queue)              │
│  └── RTPSParticipant                                │
│      └── RTPSDomain (static factory)                │
└────────────────────┬────────────────────────────────┘
                     │ 网络发送
                     ▼

Reader Side:
┌─────────────────────────────────────────────────────┐
│  RTPSReader                                         │
│  └── onNewCacheChangeAdded()                        │
│      └── deserialize() → process → remove_change()  │
└────────────────────┬────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────┐
│  Application                                        │
└─────────────────────────────────────────────────────┘
```

---

## 🚀 运行示例

### 编译

```bash
cd ~/Documents/GitHub/Fast-DDS/examples/cpp/rtps
mkdir build && cd build
cmake ..
make -j$(nproc)
```

### 运行

```bash
# 终端 1：启动 Reader
./rtps reader

# 终端 2：启动 Writer
./rtps writer
```

### 预期输出

**Reader**:
```
Registering RTPS Reader
RTPS Reader running. Please press Ctrl+C to stop the RTPS Reader at any time.
Remote endpoint with GUID 01.0f.da.70.f5.ea.d7.9b.00.00.00.00|0.0.1.3 matched.
Message: Hello World with index 1 RECEIVED
Message: Hello World with index 2 RECEIVED
...
```

**注意**: 输出显示 GUID，这是 RTPS 层的端点标识（DDS 层隐藏了这些细节）

---

## 🧪 实验任务

### 实验 1：对比 DDS 和 RTPS 层性能

使用相同的硬件和测试场景：
1. 运行 hello_world 示例，记录延迟和吞吐量
2. 运行 rtps 示例，记录延迟和吞吐量
3. 对比结果

**预期**: RTPS 层略快（减少了 DDS 层的抽象开销）

### 实验 2：禁用发现机制

修改代码，使用静态端点配置：

```cpp
// 禁用自动发现
participant_attr.builtin.discovery_config.discoveryProtocol =
    DiscoveryProtocol::NONE;

// 手动添加远程 Reader 的 Locator
Locator_t remote_locator;
// ... 配置 remote_locator
writer_attr.endpoint.remoteLocatorList.push_back(remote_locator);
```

**观察**: Writer 是否能直接发送数据到 Reader？

---

## 📚 与笔记关联

| 本示例概念 | 对应笔记 |
|-----------|---------|
| RTPSDomain | [01 RTPS源码分析](./01-RTPS-Source-Analysis.md#rtpsdomain) |
| RTPSWriter/RTPSReader | [01 RTPS源码分析](./01-RTPS-Source-Analysis.md#rtpswriter--rtpsreader) |
| CacheChange | [09 进阶主题](./09-Advanced-Topics.md#dds--rtps-完整调用链) |
| WriterHistory | [09 进阶主题](./09-Advanced-Topics.md#发送流程) |
| 序列化 | [02 类型系统](./02-DDS-Layer-Architecture.md#cdr-序列化) |

---

## ✅ 学习检查清单

- [ ] 理解 RTPS 层与 DDS 层的区别
- [ ] 掌握 RTPSParticipant 创建流程
- [ ] 理解 CacheChange 的作用
- [ ] 掌握 WriterHistory 的使用
- [ ] 理解手动序列化的过程
- [ ] 成功运行示例并观察 GUID
- [ ] 理解为什么需要手动释放 CacheChange

---

## 🎓 进阶思考

1. **什么时候应该使用 RTPS 层而不是 DDS 层？**
   - 需要极致性能优化时
   - 需要自定义协议行为时
   - 研究 RTPS 协议实现时
   - 嵌入式系统资源受限时

2. **RTPS 层的缺点是什么？**
   - 代码复杂度更高
   - 需要手动管理内存
   - 缺少高级 QoS 支持
   - 可移植性较差

3. **CacheChange 的序列号是如何分配的？**
   - 由 RTPSWriter 自动分配（递增）
   - 用于可靠传输的重排序和去重
   - 在 ACKNACK 机制中起关键作用

---

_下一个示例：[Discovery Server 集中式发现](./13-Example-03-DiscoveryServer.md)_
