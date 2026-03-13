# Fast-DDS 内存管理与分片传输详解

**创建时间**: 2026-03-13  
**源码版本**: Fast-DDS 3.5.0  
**作者**: 旭旭助手

---

## 目录

1. [为什么需要特殊内存管理？](#一为什么需要特殊内存管理)
2. [内存池机制](#二内存池机制)
3. [History 缓存机制](#三history-缓存机制)
4. [分片传输（Fragmentation）](#四分片传输fragmentation)
5. [零拷贝与共享内存](#五零拷贝与共享内存)
6. [实战代码示例](#六实战代码示例)
7. [性能调优建议](#七性能调优建议)

---

## 一、为什么需要特殊内存管理？

### 1.1 实时系统的内存挑战

| 问题 | 传统方案 | DDS 方案 |
|------|---------|---------|
| **分配延迟不确定** | `malloc/free` 可能触发系统调用 | 预分配内存池，O(1) 获取 |
| **内存碎片化** | 频繁分配/释放导致碎片 | 固定大小块管理 |
| **缓存不友好** | 随机内存访问 | 连续内存 + 预取 |
| **大消息处理** | 单包限制（UDP ~64KB） | 自动分片重组 |

### 1.2 Fast-DDS 内存架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                    Application Layer                             │
│              (用户数据，序列化后的字节流)                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     CacheChange (缓存单元)                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │  Sequence   │  │  Serialized │  │  FragmentInfo (分片信息) │  │
│  │  Number     │  │  Data       │  │  (如果是分片消息)        │  │
│  │  (64-bit)   │  │  (payload)  │  │                          │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    HistoryCache (历史缓存)                       │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │  内存池 / 预分配数组 / 动态链表 (取决于 QoS)                 │   │
│  │  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐         │   │
│  │  │Chg 1│→│Chg 2│→│Chg 3│→│Chg 4│→│Chg 5│→│Chg 6│  ...   │   │
│  │  └─────┘ └─────┘ └─────┘ └─────┘ └─────┘ └─────┘         │   │
│  └───────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Transport Layer                               │
│         (UDP/TCP/SHM，分片在此层处理)                            │
└─────────────────────────────────────────────────────────────────┘
```

---

## 二、内存池机制

### 2.1 CacheChangePool - 缓存单元池

**源码位置**: `src/cpp/rtps/history/CacheChangePool.cpp`

```cpp
class CacheChangePool {
public:
    // 初始化内存池
    CacheChangePool(
        size_t pool_size,           // 池大小（初始分配数量）
        size_t max_pool_size,       // 最大扩展数量
        size_t payload_size,        // 每个 payload 的最大大小
        bool allow_growing          // 是否允许动态增长
    );
    
    // 获取一个 CacheChange（O(1)）
    CacheChange_t* allocate();
    
    // 归还 CacheChange（O(1)）
    void release(CacheChange_t* change);
    
private:
    std::vector<CacheChange_t*> pool_;           // 可用单元列表
    std::vector<CacheChange_t*> all_changes_;    // 所有单元（用于清理）
    std::mutex mutex_;                            // 线程安全
    size_t current_pool_size_;                    // 当前池大小
    const size_t max_pool_size_;                  // 最大限制
    const bool allow_growing_;                    // 是否可增长
};
```

### 2.2 内存分配策略

| 策略 | 配置方式 | 适用场景 |
|------|---------|---------|
| **预分配固定池** | `pool_size = N`, `allow_growing = false` | 内存受限嵌入式系统 |
| **可增长池** | `pool_size = N`, `allow_growing = true`, `max_pool_size = M` | 通用场景（默认） |
| **动态分配** | `pool_size = 0` | 开发调试，不推荐生产 |

### 2.3 代码示例：配置内存池

```cpp
// 通过 QoS 配置 History 内存池
DataWriterQos writer_qos;

// 设置 History 深度（缓存多少个样本）
writer_qos.history().depth = 10;  // KeepLast(10)

// 或者使用 KeepAll（需要配合 ResourceLimits）
writer_qos.history().kind = KEEP_ALL_HISTORY_QOS;

// 配置 ResourceLimits（资源限制）
writer_qos.resource_limits().max_samples = 100;           // 最大样本数
writer_qos.resource_limits().max_instances = 10;          // 最大实例数
writer_qos.resource_limits().max_samples_per_instance = 10; // 每个实例最大样本

// 预分配 vs 动态分配
writer_qos.writer_resource_limits().matched_subscriber_allocation.
    initial_count = 5;   // 初始分配5个匹配的 Reader 槽位
writer_qos.writer_resource_limits().matched_subscriber_allocation.
    maximum_count = 20;  // 最多支持20个匹配的 Reader
```

---

## 三、History 缓存机制

### 3.1 WriterHistory vs ReaderHistory

```
┌──────────────────────────────────────────────────────────────┐
│                      WriterHistory                           │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  已发布但未确认的数据（可靠模式）                          │ │
│  │  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐                       │ │
│  │  │Seq=5│ │Seq=6│ │Seq=7│ │Seq=8│  <-- 等待 ACKNACK      │ │
│  │  │Acked│ │     │ │     │ │     │                       │ │
│  │  └─────┘ └─────┘ └─────┘ └─────┘                       │ │
│  │                                                         │ │
│  │  序列号管理：分配下一个可用的 SequenceNumber             │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                      ReaderHistory                           │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  已接收但未取走的数据                                      │ │
│  │  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐                       │ │
│  │  │Seq=5│ │Seq=6│ │GAP  │ │Seq=8│  <-- 缺 Seq=7          │ │
│  │  │Read │ │     │ │     │ │     │                       │ │
│  │  └─────┘ └─────┘ └─────┘ └─────┘                       │ │
│  │                                                         │ │
│  │  序列号管理：检测缺失、去重、排序                          │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 History 的两种模式

| 模式 | 说明 | 适用场景 |
|------|------|---------|
| **KeepLast(N)** | 只保留最新的 N 个样本，旧的丢弃 | 实时视频流、传感器数据 |
| **KeepAll** | 保留所有样本（直到 ResourceLimits 满） | 关键指令、交易数据 |

**注意**：KeepAll 需要配合 `ResourceLimits` 使用，否则内存会无限增长！

### 3.3 History 缓存的生命周期

```cpp
// WriterHistory 中的 CacheChange 状态流转
enum class ChangeState {
    ALIVE,           // 新写入，未发送
    SENT,            // 已发送，等待确认（可靠模式）
    ACKED,           // 已确认，可以回收
    REPLACED         // 被新样本替换（KeepLast模式下）
};

// ReaderHistory 中的处理流程
void on_received_data(CacheChange_t* change) {
    // 1. 序列号检查（去重、排序）
    if (change->sequenceNumber <= last_processed_seq_) {
        return;  // 重复数据，丢弃
    }
    
    // 2. 检查是否有缺失（GAP检测）
    if (change->sequenceNumber > last_processed_seq_ + 1) {
        mark_missing_changes(last_processed_seq_ + 1, 
                            change->sequenceNumber - 1);
    }
    
    // 3. 插入 HistoryCache
    insert_to_history(change);
    
    // 4. 触发回调
    listener_->on_data_available(this);
}
```

---

## 四、分片传输（Fragmentation）

### 4.1 为什么需要分片？

**UDP 报文大小限制**：
- 理论上限：65,507 字节（IPv4）
- 实际限制：通常 1,500 字节（以太网 MTU）
- 大数据样本（如 1MB 图像）必须分片

### 4.2 Fast-DDS 分片架构

```
┌─────────────────────────────────────────────────────────────────┐
│                     大数据样本 (1MB)                             │
│  ┌────────┬────────┬────────┬────────┬────────┬────────┐        │
│  │Frag 0  │Frag 1  │Frag 2  │Frag 3  │  ...   │Frag N  │        │
│  │(64KB)  │(64KB)  │(64KB)  │(64KB)  │        │(剩余)  │        │
│  └────────┴────────┴────────┴────────┴────────┴────────┘        │
│       │        │        │        │               │              │
│       ▼        ▼        ▼        ▼               ▼              │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  DATA Frag Submessage (RTPS 协议层)                        │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌───────────────────┐   │  │
│  │  │ fragmentStartingNum │  │ fragmentsInSubmessage │  │  │   │  │
│  │  │ (起始分片号)        │  │ (本消息包含的分片数)   │  │  │   │  │
│  │  └─────────────┘  └─────────────┘  └───────────────────┘   │  │
│  │  ┌─────────────────────────────────────────────────────┐   │  │
│  │  │ fragmentBytes (实际分片数据，最大约 64KB)              │   │  │
│  │  └─────────────────────────────────────────────────────┘   │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 4.3 分片关键参数

```cpp
// 在 TransportDescriptor 中配置
struct TransportDescriptor {
    // 最大传输单元（不包括 UDP/IP 头）
    uint32_t maxMessageSize = 65500;  // 默认约 64KB
    
    // 分片大小（实际 payload 大小）
    uint32_t maxInitialPeersRange = 4;  // 初始发现阶段最大分片数
    
    // 发送队列大小（控制并发分片数量）
    uint32_t sendBufferSize = 65500;
    uint32_t receiveBufferSize = 65500;
};
```

### 4.4 分片与重组流程

**发送端 (Writer)**：

```
┌──────────────────────────────────────────────────────────────┐
│ 1. 用户调用 write(data, size=1MB)                             │
│                         ↓                                    │
│ 2. RTPSWriter::write() 分配 SequenceNumber                   │
│                         ↓                                    │
│ 3. 检查 size > maxMessageSize?                               │
│                         ↓ Yes                                │
│ 4. 计算分片数: N = ceil(1MB / 64KB) = 16 片                  │
│                         ↓                                    │
│ 5. 创建 N 个 DATA_FRAG submessage                            │
│    每个包含:                                                 │
│    - fragmentStartingNum (0, 1, 2, ..., 15)                  │
│    - fragmentsInSubmessage (通常为 1)                        │
│    - fragmentSize (64KB, 64KB, ..., 剩余)                    │
│                         ↓                                    │
│ 6. 逐个发送分片（可靠模式下等待每个分片的确认）                 │
└──────────────────────────────────────────────────────────────┘
```

**接收端 (Reader)**：

```
┌──────────────────────────────────────────────────────────────┐
│ 1. 接收 DATA_FRAG(fragmentStartingNum=0)                     │
│                         ↓                                    │
│ 2. 检查: 这是某个大数据样本的第 0 个分片？                     │
│    → 创建 FragmentedSample 对象，开始重组                     │
│                         ↓                                    │
│ 3. 接收 DATA_FRAG(fragmentStartingNum=1)                     │
│                         ↓                                    │
│ 4. 插入到对应位置，检查是否连续                                │
│                         ↓                                    │
│ 5. 继续接收直到 fragmentStartingNum = N-1                    │
│                         ↓                                    │
│ 6. 所有分片到齐 → 重组为完整样本 → 存入 HistoryCache         │
│                         ↓                                    │
│ 7. 触发 on_data_available() 回调                             │
└──────────────────────────────────────────────────────────────┘
```

### 4.5 分片重组的数据结构

```cpp
// Fast-DDS 中的分片重组实现
class FragmentedChange {
public:
    // 分片位图（追踪哪些分片已收到）
    // 例如：16个分片 → 每个分片对应一个 bit
    std::vector<bool> fragment_bitmap_;
    
    // 存储分片数据（使用连续的缓冲区）
    std::vector<uint8_t> fragment_data_;
    
    // 分片信息
    uint32_t total_fragments_;      // 总分片数
    uint32_t received_fragments_;   // 已接收分片数
    uint32_t fragment_size_;        // 每个分片的大小
    
    // 超时管理
    std::chrono::steady_clock::time_point last_fragment_time_;
    static constexpr auto FRAGMENT_TIMEOUT = std::chrono::seconds(30);
    
    // 检查是否完整
    bool is_complete() const {
        return received_fragments_ == total_fragments_;
    }
    
    // 检查是否超时
    bool is_timeout() const {
        return std::chrono::steady_clock::now() - last_fragment_time_ > FRAGMENT_TIMEOUT;
    }
    
    // 添加分片
    bool add_fragment(uint32_t fragment_num, const uint8_t* data, uint32_t size);
};
```

### 4.6 分片丢失处理与重传

```
场景：16个分片中，第 3、7 分片丢失

Writer 发送:  [0] [1] [2] [3] [4] [5] [6] [7] [8] [9] [10] [11] [12] [13] [14] [15]
              OK  OK  OK  X   OK  OK  OK  X   OK  OK  OK   OK   OK   OK   OK   OK
              
Reader 收到:  [0] [1] [2]     [4] [5] [6]     [8] [9] [10] [11] [12] [13] [14] [15]
              (缺少 3 和 7)

Reader 的 ACKNACK 响应:
┌──────────────────────────────────────────────────────────────┐
│  ACKNACK Submessage                                          │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ readerSNState (Base = 16, 表示已确认到 Seq=15)          │  │
│  │ bitmap = [0, 0, 0, 1, 0, 0, 0, 1, 0, ...]              │  │
│  │          // bit 3 = 1 表示缺 Seq=3 的分片              │  │
│  │          // bit 7 = 1 表示缺 Seq=7 的分片              │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘

Writer 收到 ACKNACK:
→ 重传 DATA_FRAG(fragmentStartingNum=3)
→ 重传 DATA_FRAG(fragmentStartingNum=7)
```

---

## 五、零拷贝与共享内存

### 5.1 传统拷贝 vs 零拷贝

```
传统方式（4次拷贝）:
┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐
│ 应用数据 │ → │ 序列化  │ → │ Socket  │ → │ 内核    │ → │ 网卡    │
│ 缓冲区  │   │ 缓冲区  │   │ 缓冲区  │   │ 缓冲区  │   │ 发送    │
└─────────┘   └─────────┘   └─────────┘   └─────────┘   └─────────┘

零拷贝方式（共享内存，0次拷贝）:
┌──────────────────────────────────────────────────────────────────┐
│                    共享内存段 (SHM)                               │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  应用直接写入 ──────────────────────────────► Reader 直接读取 │  │
│  │  (通过内存映射)                    (通过内存映射)            │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### 5.2 Fast-DDS 共享内存传输配置

```cpp
#include <fastdds/rtps/transport/shared_mem/SharedMemTransportDescriptor.hpp>

// 配置共享内存传输
DomainParticipantQos qos;

// 添加共享内存传输
auto shm_transport = std::make_shared<SharedMemTransportDescriptor>();
shm_transport->segment_size(2 * 1024 * 1024);  // 2MB 共享内存段
shm_transport->port_queue_capacity(1024);       // 端口队列容量
shm_transport->healthy_check_timeout_ms(1000);  // 健康检查超时

qos.transport().user_transports.push_back(shm_transport);

// 共享内存传输优先级高于 UDP
qos.transport().use_builtin_transports = false;
qos.transport().user_transports.push_back(shm_transport);
```

### 5.3 共享内存 vs UDP/TCP 对比

| 特性 | UDPv4 | TCPv4 | 共享内存 (SHM) |
|------|-------|-------|----------------|
| **延迟** | ~10-50μs | ~100-500μs | ~0.5-2μs |
| **吞吐量** | 高 | 中 | 极高（内存速度） |
| **CPU 占用** | 中 | 高 | 极低 |
| **跨机器** | ✅ | ✅ | ❌（仅限单机） |
| **大数据** | 需分片 | 自动处理 | 无需分片（直接映射） |
| **可靠性** | 尽力而为 | 可靠 | 需应用层确认 |

### 5.4 共享内存的实现机制

```cpp
// 共享内存段管理
class SharedMemSegment {
public:
    // 创建/打开共享内存段
    SharedMemSegment(const std::string& name, size_t size);
    
    // 内存映射
    void* map();
    
    // 写入数据（零拷贝）
    void* allocate_buffer(size_t size);
    void publish_buffer(void* buffer, size_t size);
    
    // 读取数据（零拷贝）
    void* get_buffer(size_t offset, size_t size);
    void release_buffer(void* buffer);
    
private:
    std::string segment_name_;
    size_t segment_size_;
    void* mapped_memory_;
    
    // 环形缓冲区管理
    RingBuffer<SharedMemBuffer> buffer_queue_;
};

// 端口（用于同步）
class SharedMemPort {
public:
    // 通知对端有新数据
    void notify();
    
    // 等待新数据通知
    bool wait_for_notification(timeout);
    
private:
    sem_t notification_semaphore_;  // 进程间信号量
};
```

---

## 六、实战代码示例

### 6.1 配置大消息分片传输

```cpp
#include <fastdds/dds/domain/DomainParticipantFactory.hpp>
#include <fastdds/dds/domain/DomainParticipant.hpp>
#include <fastdds/dds/publisher/Publisher.hpp>
#include <fastdds/dds/publisher/DataWriter.hpp>

using namespace eprosima::fastdds::dds;

int main() {
    // 1. 配置 DomainParticipant，启用分片传输
    DomainParticipantQos participant_qos;
    
    // 配置 UDPv4 传输，设置分片大小
    auto udp_transport = std::make_shared<UDPv4TransportDescriptor>();
    udp_transport->maxMessageSize = 64000;  // 最大消息大小 64KB
    udp_transport->sendBufferSize = 128000; // 发送缓冲区 128KB
    udp_transport->receiveBufferSize = 128000;
    
    participant_qos.transport().user_transports.push_back(udp_transport);
    participant_qos.transport().use_builtin_transports = false;
    
    // 2. 创建 Participant
    DomainParticipant* participant = 
        DomainParticipantFactory::get_instance()->create_participant(
            0, participant_qos);
    
    // 3. 注册大消息类型
    TypeSupport type_support(new LargeImagePubSubType());
    type_support.register_type(participant);
    
    // 4. 创建 Topic
    Topic* topic = participant->create_topic(
        "LargeImageTopic", 
        type_support.get_type_name(), 
        TOPIC_QOS_DEFAULT);
    
    // 5. 创建 Publisher
    Publisher* publisher = participant->create_publisher(PUBLISHER_QOS_DEFAULT);
    
    // 6. 配置 DataWriter（关键：配置大消息支持）
    DataWriterQos writer_qos;
    
    // 可靠传输（必须，确保分片不丢失）
    writer_qos.reliability().kind = RELIABLE_RELIABILITY_QOS;
    
    // 历史策略
    writer_qos.history().kind = KEEP_LAST_HISTORY_QOS;
    writer_qos.history().depth = 5;  // 缓存最近5个大消息
    
    // 资源限制（防止内存无限增长）
    writer_qos.resource_limits().max_samples = 20;
    writer_qos.resource_limits().max_sample_size = 10 * 1024 * 1024;  // 10MB
    
    // 异步发布（大消息推荐）
    writer_qos.publish_mode().kind = ASYNCHRONOUS_PUBLISH_MODE;
    
    DataWriter* writer = publisher->create_datawriter(topic, writer_qos);
    
    // 7. 创建并发送大消息
    LargeImage image;
    image.width(1920);
    image.height(1080);
    image.data().resize(1920 * 1080 * 3);  // RGB 图像，约 6MB
    
    // 填充数据...
    
    writer->write(&image);
    
    return 0;
}
```

### 6.2 接收大消息配置

```cpp
// 接收端配置
DataReaderQos reader_qos;

// 可靠传输（匹配 Writer）
reader_qos.reliability().kind = RELIABLE_RELIABILITY_QOS;

// 历史策略
reader_qos.history().kind = KEEP_LAST_HISTORY_QOS;
reader_qos.history().depth = 5;

// 资源限制
reader_qos.resource_limits().max_samples = 20;
reader_qos.resource_limits().max_sample_size = 10 * 1024 * 1024;  // 10MB

// 分片重组超时
reader_qos.reader_resource_limits().
    fragmented_samples_allocation.total_count = 5;  // 最多5个并发分片重组

DataReader* reader = subscriber->create_datareader(topic, reader_qos);
```

### 6.3 内存池监控与调优

```cpp
#include <fastdds/rtps/history/WriterHistory.h>

// 自定义监控回调
class MemoryMonitorListener : public DataWriterListener {
public:
    void on_offered_deadline_missed(
        DataWriter* writer,
        const OfferedDeadlineMissedStatus& status) override {
        
        std::cout << "Deadline missed! " << status.total_count << std::endl;
    }
    
    void on_offered_incompatible_qos(
        DataWriter* writer,
        const OfferedIncompatibleQosStatus& status) override {
        
        std::cout << "Incompatible QoS! Last policy: " 
                  << status.last_policy_id << std::endl;
    }
};

// 运行时调整内存池（高级用法）
void adjust_memory_pool(DataWriter* writer) {
    // 获取当前统计
    fastdds::rtps::WriterHistory* history = 
        static_cast<fastdds::rtps::RTPSWriter*>(writer->get_rtps_writer())->history_;
    
    size_t current_pool_size = history->get_pool_size();
    size_t max_pool_size = history->get_max_pool_size();
    size_t used_changes = history->get_number_of_changes();
    
    std::cout << "Memory pool: " << used_changes << "/" 
              << current_pool_size << " (max: " << max_pool_size << ")" << std::endl;
    
    // 如果使用率超过80%，考虑扩展
    if (used_changes > current_pool_size * 0.8) {
        std::cout << "Warning: Memory pool near capacity!" << std::endl;
    }
}
```

---

## 七、性能调优建议

### 7.1 内存池调优 checklist

| 场景 | 配置建议 | 原因 |
|------|---------|------|
| **高频小消息** | `KeepLast(10)`, 预分配100个单元 | 减少分配延迟 |
| **低频大消息** | `KeepAll`, 动态增长池 | 避免数据丢失 |
| **可靠传输** | 增大池大小，启用异步发布 | 缓存未确认样本 |
| **尽力传输** | 较小池即可 | 不需要缓存确认 |
| **共享内存** | 设置足够的 segment_size | 避免频繁扩容 |

### 7.2 分片传输最佳实践

```cpp
// ✅ 推荐配置：大消息传输
DataWriterQos large_message_qos;

// 1. 必须使用可靠传输
large_message_qos.reliability().kind = RELIABLE_RELIABILITY_QOS;

// 2. 使用异步发布（避免阻塞）
large_message_qos.publish_mode().kind = ASYNCHRONOUS_PUBLISH_MODE;

// 3. 设置合适的分片大小（匹配网络 MTU）
// 在 TransportDescriptor 中配置：
// maxMessageSize = 1400  // 如果通过 VPN 或特殊网络
// maxMessageSize = 64000 // 局域网直接传输

// 4. 增加 History 深度（缓存更多样本）
large_message_qos.history().depth = 10;

// 5. 设置资源限制上限
large_message_qos.resource_limits().max_samples = 50;
large_message_qos.resource_limits().max_sample_size = 100 * 1024 * 1024;  // 100MB

// ❌ 避免：以下配置会导致问题
// 1. 大消息 + BEST_EFFORT（分片丢失无法恢复）
// 2. KeepAll 但不设置 ResourceLimits（内存泄漏）
// 3. 同步模式发送大消息（阻塞主线程）
```

### 7.3 监控与诊断

```cpp
// 启用统计模块监控内存使用
DomainParticipantQos qos;
qos.statistics().enable_statistics_datawriter(
    fastdds::statistics::PHYSICAL_DATA_TOPIC,  // 物理层统计
    fastdds::statistics::StatusKind::ENABLE);

// 监控指标：
// - HISTORY2HISTORY_LATENCY: History 缓存延迟
// - NETWORK_LATENCY: 网络传输延迟
// - PUBLICATION_THROUGHPUT: 发布吞吐量
// - RESENT_DATA: 重传数据量（分片丢失指标）
```

### 7.4 常见问题排查

| 问题现象 | 可能原因 | 解决方案 |
|---------|---------|---------|
| **内存持续增长** | KeepAll + 无 ResourceLimits | 设置 max_samples 上限 |
| **大消息发送失败** | 超过 max_sample_size | 增大 resource_limits 配置 |
| **分片重组超时** | 网络丢包率高 | 检查网络，或减小分片大小 |
| **延迟不稳定** | 内存池耗尽，触发动态分配 | 增大初始 pool_size |
| **共享内存创建失败** | segment_size 过大 | 减小 segment_size，使用多个段 |

---

## 八、总结

### 核心要点

1. **内存池**：预分配固定大小的 CacheChange，避免运行时 `malloc`，确保 O(1) 分配延迟

2. **History 缓存**：Writer 缓存未确认数据，Reader 缓存未取走数据，支持 KeepLast/KeepAll 两种模式

3. **分片传输**：大数据自动拆分为 ~64KB 的分片，通过 `DATA_FRAG` 子消息传输，支持可靠重传

4. **零拷贝**：共享内存传输（SHM）实现进程间零拷贝，延迟从 ~50μs 降至 ~1μs

5. **配置要点**：
   - 大消息必须使用 `RELIABLE` + `ASYNCHRONOUS`
   - 设置合理的 `ResourceLimits` 防止内存泄漏
   - 根据网络环境调整 `maxMessageSize`

---

*文档版本: 1.0*  
*最后更新: 2026-03-13*  
*关联笔记: 01-RTPS-Source-Analysis.md, 04-QoS-Implementation.md, 05-Transport-Layer.md*
