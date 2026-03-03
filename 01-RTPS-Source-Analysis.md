# Fast-DDS RTPS 源码分析

**分析时间**: 2026-03-01  
**源码版本**: Fast-DDS 3.5.0  
**分析人**: 旭旭助手

---

## 一、RTPS 架构总览

### 1.1 核心设计理念

RTPS (Real-Time Publish Subscribe) 是 DDS 的底层实现协议，遵循 OMG DDSI-RTPS 标准。Fast-DDS 的 RTPS 层提供了：

- **更细粒度的控制** - 相比 DDS 层，可直接操作协议细节
- **标准兼容性** - 与其他 DDS/RTPS 实现互通
- **灵活的资源管理** - 自定义 History、缓存池等

### 1.2 类层次结构

```
RTPSDomain (单例管理类)
├── 管理所有 RTPSParticipant
├── createParticipant() → RTPSParticipant
├── createRTPSWriter() → RTPSWriter  
└── createRTPSReader() → RTPSReader

RTPSParticipant (参与者)
├── 管理 Writers 和 Readers
├── 内置协议 (BuiltinProtocols)
├── 发现机制 (Discovery)
└── 与 DDS DomainParticipant 1:1 映射

Endpoint (端点基类)
├── RTPSWriter (发送端)
│   ├── WriterHistory (发送缓存)
│   ├── FlowController (流控)
│   └── 匹配多个 RTPSReader
│
└── RTPSReader (接收端)
    ├── ReaderHistory (接收缓存)
    ├── ReaderListener (回调监听)
    └── 匹配多个 RTPSWriter
```

---

## 二、核心类详解

### 2.1 RTPSDomain - 域管理器

**文件**: `include/fastdds/rtps/RTPSDomain.hpp`

**职责**:
- 单例模式管理所有 RTPS 实体
- 负责 Participant、Writer、Reader 的生命周期
- 提供静态工厂方法

**关键方法**:

```cpp
// 创建 RTPSParticipant
static RTPSParticipant* createParticipant(
    uint32_t domain_id,                    // Domain ID (默认80)
    const RTPSParticipantAttributes& attrs, // 配置属性
    RTPSParticipantListener* plisten = nullptr  // 监听器
);

// 创建 Writer
static RTPSWriter* createRTPSWriter(
    RTPSParticipant* p,           // 所属Participant
    WriterAttributes& watt,       // Writer配置
    WriterHistory* hist,          // 历史缓存
    WriterListener* listen = nullptr  // 监听器
);

// 创建 Reader
static RTPSReader* createRTPSReader(
    RTPSParticipant* p,           // 所属Participant
    ReaderAttributes& ratt,       // Reader配置
    ReaderHistory* hist,          // 历史缓存
    ReaderListener* listen = nullptr  // 监听器
);

// 关闭所有RTPS实体
static void stopAll();
```

**设计要点**:
- 纯静态方法，无需实例化
- 内部维护 Participant 列表
- 线程安全（使用 mutex 保护）

---

### 2.2 RTPSParticipant - 参与者

**文件**: `include/fastdds/rtps/participant/RTPSParticipant.hpp`

**职责**:
- RTPS 网络的入口点
- 管理 Writers 和 Readers
- 实现发现协议
- 与 DDS DomainParticipant 对应

**关键方法**:

```cpp
// 获取 GUID (全局唯一标识)
const GUID_t& getGuid() const;

// 强制宣告 Participant 状态
void announceRTPSParticipantState();

// 发现新的远程 Writer
bool newRemoteWriterDiscovered(
    const GUID_t& pguid,      // Writer 的 GUID
    int16_t userDefinedId     // 用户定义ID
);

// 发现新的远程 Reader
bool newRemoteReaderDiscovered(
    const GUID_t& pguid,      // Reader 的 GUID
    int16_t userDefinedId     // 用户定义ID
);

// 注册 Writer 到内置协议
bool register_writer(
    RTPSWriter* rtps_writer,
    const TopicDescription& topic,
    const fastdds::dds::WriterQos& qos
);

// 注册 Reader 到内置协议
bool register_reader(
    RTPSReader* rtps_reader,
    const TopicDescription& topic,
    const fastdds::dds::ReaderQos& qos,
    const ContentFilterProperty* content_filter = nullptr
);
```

**实现细节**:
- 使用 Pimpl (Pointer to Implementation) 模式
- `RTPSParticipantImpl` 包含实际实现
- 支持统计信息收集 (可选)

---

### 2.3 Endpoint - 端点基类

**文件**: `include/fastdds/rtps/Endpoint.hpp`

**职责**:
- 所有 RTPS 网络实体的基类
- 管理 GUID、属性、互斥锁
- 关联到所属 Participant

**核心属性**:

```cpp
protected:
    // 指向所属 Participant 的实现
    RTPSParticipantImpl* mp_RTPSParticipant;
    
    // 全局唯一标识符
    const GUID_t m_guid;
    
    // 端点属性
    EndpointAttributes m_att;
    
    // 递归互斥锁（线程安全）
    mutable RecursiveTimedMutex mp_mutex;
```

**关键方法**:

```cpp
// 获取 GUID
inline const GUID_t& getGuid() const { return m_guid; }

// 获取互斥锁（线程同步）
inline RecursiveTimedMutex& getMutex() { return mp_mutex; }

// 获取属性
inline EndpointAttributes& getAttributes() { return m_att; }
```

**设计要点**:
- RTPSParticipant **不**继承自 Endpoint（与RTPS规范不同）
- 每个 Endpoint 通过指针关联到 Participant
- 线程安全设计（RecursiveTimedMutex）

---

### 2.4 RTPSWriter - 数据写入器

**文件**: `include/fastdds/rtps/writer/RTPSWriter.hpp`

**职责**:
- 发送数据到匹配的 Readers
- 管理发送历史（History）
- 实现流控（FlowControl）
- 处理 ACK/NACK 机制

**继承关系**:
```
Endpoint
└── RTPSWriter
    ├── StatefulWriter (有状态，追踪Reader状态)
    └── StatelessWriter (无状态，不追踪)
```

**关键方法**:

```cpp
// 添加匹配的 Reader
virtual bool matched_reader_add(
    const SubscriptionBuiltinTopicData& info
) = 0;

// 移除匹配的 Reader
virtual bool matched_reader_remove(
    const GUID_t& reader_guid
) = 0;

// 检查 Reader 是否匹配
virtual bool matched_reader_is_matched(
    const GUID_t& reader_guid
) = 0;

// 获取 WriterHistory
WriterHistory* getHistory();

// 创建新的 CacheChange
CacheChange_t* new_change(
    const std::function<uint32_t()>& data_max_serialized_size,
    ChangeKind_t change_kind = ALIVE,
    InstanceHandle_t handle = c_InstanceHandle_Unknown
);

// 发送数据
bool send(
    const std::vector<CacheChange_t*>& changes
);
```

**工作流程**:

1. **数据准备**:
   ```cpp
   CacheChange_t* change = writer->new_change(
       []() -> uint32_t { return sizeof(MyData); },
       ALIVE
   );
   serialize(data, change->serializedPayload);
   ```

2. **写入 History**:
   ```cpp
   writer->getHistory()->add_change(change);
   ```

3. **自动发送**:
   - Writer 自动将 CacheChange 发送给所有匹配的 Readers
   - 根据 QoS 策略（BEST_EFFORT 或 RELIABLE）

---

### 2.5 RTPSReader - 数据读取器

**文件**: `include/fastdds/rtps/reader/RTPSReader.hpp`

**职责**:
- 接收来自匹配 Writers 的数据
- 管理接收历史（History）
- 实现 Listener 回调机制
- 发送 ACK/NACK 反馈

**继承关系**:
```
Endpoint
└── RTPSReader
    ├── StatefulReader (有状态，追踪Writer状态)
    └── StatelessReader (无状态，不追踪)
```

**关键方法**:

```cpp
// 添加匹配的 Writer
virtual bool matched_writer_add(
    const PublicationBuiltinTopicData& info
) = 0;

// 移除匹配的 Writer
virtual bool matched_writer_remove(
    const GUID_t& writer_guid,
    bool removed_by_lease = false
) = 0;

// 检查 Writer 是否匹配
virtual bool matched_writer_is_matched(
    const GUID_t& writer_guid
) = 0;

// 断言 Writer 活跃状态
virtual void assert_writer_liveliness(
    const GUID_t& writer
) = 0;

// 获取 ReaderHistory
ReaderHistory* getHistory();

// 等待未读数据（阻塞）
bool wait_for_unread_cache(
    const fastdds::dds::Duration_t& timeout
);

// 获取未读数据数量
uint64_t get_unread_count() const;
```

**Listener 回调**:

```cpp
class ReaderListener {
public:
    // 新数据到达回调
    virtual void onNewCacheChangeAdded(
        RTPSReader* reader,
        const CacheChange_t* change
    ) {
        // 默认空实现
    }
    
    // 匹配 Writer 回调
    virtual void onWriterMatched(
        RTPSReader* reader,
        const PublicationBuiltinTopicData& info
    ) {}
    
    // ... 其他回调
};
```

**工作流程**:

1. **设置 Listener**:
   ```cpp
   class MyListener : public ReaderListener {
   public:
       void onNewCacheChangeAdded(
           RTPSReader* reader,
           const CacheChange_t* change
       ) override {
           // 处理数据
           MyData data;
           deserialize(change->serializedPayload, data);
           
           // 处理完成后从 History 移除
           reader->getHistory()->remove_change(change);
       }
   };
   ```

2. **接收数据**:
   - Reader 自动接收来自匹配 Writers 的数据
   - 存储到 ReaderHistory
   - 触发 Listener 回调

---

## 三、核心数据结构

### 3.1 GUID (Globally Unique Identifier)

```cpp
// 12字节唯一标识
struct GUID_t {
    GuidPrefix_t guidPrefix;  // 前11字节：标识Participant
    EntityId_t entityId;      // 最后1字节：标识Entity类型和实例
};
```

**组成**:
- **GuidPrefix**: 同一 Participant 内的所有 Entity 共享相同的 prefix
- **EntityId**: 标识 Writer、Reader、Participant 本身

### 3.2 CacheChange - 数据变更单元

```cpp
struct CacheChange_t {
    ChangeKind_t kind;           // ALIVE, NOT_ALIVE_DISPOSED, etc.
    InstanceHandle_t handle;     // 实例句柄（用于keyed topics）
    SequenceNumber_t sequenceNumber;  // 序列号（可靠传输）
    SerializedPayload_t serializedPayload;  // 序列化数据
    GUID_t writerGUID;           // 写入者的GUID
    Time_t sourceTimestamp;      // 时间戳
    // ... 其他元数据
};
```

### 3.3 History 缓存机制

**WriterHistory**:
- 存储待发送的数据
- 支持 KEEP_LAST（保留最近N个）或 KEEP_ALL（保留所有）
- 可靠传输时保留直到被所有 Reader 确认

**ReaderHistory**:
- 存储接收到的数据
- 应用消费后移除
- 防止内存无限增长

---

## 四、关键设计模式

### 4.1 Pimpl (Pointer to Implementation)

**用途**: 隐藏实现细节，减少编译依赖

```cpp
// 公共头文件
class RTPSParticipant {
private:
    RTPSParticipantImpl* pimpl_;  // 指向实现的指针
public:
    // 公共接口...
};

// 实现文件
class RTPSParticipantImpl {
    // 实际实现...
};
```

### 4.2 Listener 回调模式

**用途**: 异步通知应用层事件

```cpp
// 应用层实现 Listener
class MyReaderListener : public ReaderListener {
public:
    void onNewCacheChangeAdded(...) override {
        // 处理事件
    }
};

// 创建时注册
RTPSReader* reader = RTPSDomain::createRTPSReader(
    participant, attrs, history, &myListener
);
```

### 4.3 引用计数与智能指针

现代 C++ 特性确保资源安全释放。

---

## 五、与 DDS 层的对应关系

| DDS 层 | RTPS 层 | 关系 |
|--------|---------|------|
| Domain | RTPSDomain | 1:1 映射 |
| DomainParticipant | RTPSParticipant | 1:1 映射 |
| DataWriter | RTPSWriter | 1:1 映射 |
| DataReader | RTPSReader | 1:1 映射 |
| Topic | - | RTPS 层不直接暴露 Topic |
| QoS Policies | Attributes | DDS QoS 转换为 RTPS 属性 |

---

## 六、源码阅读建议

### 6.1 入门路径

1. **先读头文件** - 理解接口设计
   - `RTPSDomain.hpp`
   - `RTPSParticipant.hpp`
   - `Endpoint.hpp`

2. **再看实现** - 理解具体逻辑
   - `src/cpp/rtps/participant/RTPSParticipantImpl.cpp`
   - `src/cpp/rtps/writer/RTPSWriter.cpp`
   - `src/cpp/rtps/reader/RTPSReader.cpp`

3. **最后深入** - 理解协议细节
   - `src/cpp/rtps/messages/` - 消息序列化
   - `src/cpp/rtps/transport/` - 网络传输
   - `src/cpp/rtps/builtin/` - 发现协议

### 6.2 关键代码示例

位置: `examples/cpp/rtps/AsSocket`

演示如何使用 RTPS 层 API：
- 创建 Participant
- 创建 Writer/Reader
- 发送/接收数据

---

## 七、总结

### 7.1 核心要点

1. **分层架构** - RTPS 层在 DDS 层之下，提供更底层控制
2. **工厂模式** - RTPSDomain 负责创建所有实体
3. **Pimpl 模式** - 隐藏实现细节，减少耦合
4. **History 机制** - 管理数据缓存，支持可靠传输
5. **Listener 回调** - 异步事件通知机制

### 7.2 适用场景

- **需要细粒度控制** - 直接操作 RTPS 协议
- **性能优化** - 自定义缓存池、流控策略
- **资源受限环境** - 精确控制内存使用
- **与其他 RTPS 实现互通** - 标准协议兼容性

### 7.3 下一步学习

1. **发现机制** - 如何自动匹配 Writer/Reader
2. **传输层** - UDP/TCP/SHM 的实现
3. **安全模块** - DDS-Security 的 RTPS 实现
4. **性能优化** - 零拷贝、共享内存等

---

*分析完成时间: 2026-03-01*  
*Fast-DDS 版本: 3.5.0*  
*文档状态: 初版完成*
