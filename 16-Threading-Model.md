# Fast-DDS 线程模型详解

**创建时间**: 2026-03-13  
**源码版本**: Fast-DDS 3.5.0  
**作者**: 旭旭助手

---

## 目录

1. [线程模型概述](#一线程模型概述)
2. [核心线程池](#二核心线程池)
3. [线程职责详解](#三线程职责详解)
4. [线程间通信机制](#四线程间通信机制)
5. [线程安全设计](#五线程安全设计)
6. [性能调优](#六性能调优)
7. [源码分析](#七源码分析)
8. [常见问题与调试](#八常见问题与调试)

---

## 一、线程模型概述

### 1.1 为什么需要多线程？

DDS 是高性能分布式通信中间件，单线程无法满足以下需求：

| 需求 | 单线程问题 | 多线程解决方案 |
|------|-----------|---------------|
| **并发接收** | 阻塞等待影响发送 | 独立接收线程 |
| **异步发送** | 大数据阻塞应用 | 独立发送线程池 |
| **定时器** | 精度和响应性不足 | 专用定时器线程 |
| **发现协议** | 影响数据传输 | 独立发现线程 |
| **事件处理** | 回调阻塞主流程 | 异步事件线程 |

### 1.2 线程架构总览

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Fast-DDS 线程全景图                              │
└─────────────────────────────────────────────────────────────────────────┘

应用层线程 (用户代码)
┌─────────────────────────────────────────────────────────────────────────┐
│  User Thread 1    User Thread 2    ...    User Thread N                 │
│  (Publisher)      (Subscriber)                                          │
│       │                │                                                │
│       └────────────────┴────────────────┐                               │
│                                         ▼                               │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │              DDS API 层 (线程安全)                               │   │
│  │  DomainParticipant::write()  DataReader::take()                 │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
DDS/RTPS 层线程 (Fast-DDS 内部)
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐         │
│  │   Event Thread  │  │  Async Send     │  │  Transport      │         │
│  │   (定时器)      │  │  Thread Pool    │  │  Threads        │         │
│  │                 │  │  (异步发送)      │  │  (网络IO)       │         │
│  │  • SPDP Timer   │  │                 │  │                 │         │
│  │  • SEDP Timer   │  │  • 大数据发送    │  │  • UDP Receive  │         │
│  │  • Heartbeat    │  │  • 批量发送      │  │  • TCP Accept   │         │
│  │  • Deadline     │  │  • 流控处理      │  │  • SHM Notify   │         │
│  │                 │  │                 │  │                 │         │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘         │
│           │                    │                    │                  │
│           ▼                    ▼                    ▼                  │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                     线程间队列 (无锁/有锁)                        │   │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐            │   │
│  │  │  Event Queue │ │  Send Queue  │ │  Recv Queue  │            │   │
│  │  │  (优先级)     │ │  (批量)       │ │  (分发给Reader)│            │   │
│  │  └──────────────┘ └──────────────┘ └──────────────┘            │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                     共享数据结构 (需同步)                         │   │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐            │   │
│  │  │History Cache │ │ Matched      │ │  Discovery   │            │   │
│  │  │  (读写锁)     │ │  Readers     │ │   DB         │            │   │
│  │  └──────────────┘ └──────────────┘ └──────────────┘            │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
操作系统层
┌─────────────────────────────────────────────────────────────────────────┐
│  Kernel Threads  ←  由 Fast-DDS 线程映射到系统线程                        │
│  epoll/kqueue/IOCP  ←  系统级网络事件通知                                │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.3 线程数量公式

```
总线程数 = 1 (Event) + N (Async Send) + M (Transport) + 1 (Background)

其中:
- N = async_threads (默认: CPU核心数)
- M = transport_threads (UDP: 1, TCP: 1-2, SHM: 0)

示例 (8核CPU):
- 最小配置: 1 + 1 + 1 = 3 线程
- 默认配置: 1 + 8 + 1 = 10 线程
- 高性能配置: 1 + 16 + 2 = 19 线程
```

---

## 二、核心线程池

### 2.1 EventLoop 线程 (事件循环)

**职责**: 管理所有定时器事件

```cpp
// 源码位置: src/cpp/rtps/resources/ResourceEvent.cpp

class ResourceEvent {
public:
    void init_thread() {
        event_thread_ = std::thread(&ResourceEvent::event_loop, this);
        
        // 设置线程名称（便于调试）
        #ifdef __linux__
        pthread_setname_np(event_thread_.native_handle(), "FastEvent");
        #endif
    }
    
private:
    void event_loop() {
        while (running_) {
            // 1. 获取最近到期的定时器
            auto* next_timer = get_next_timer();
            
            // 2. 计算等待时间
            auto wait_time = next_timer ? 
                next_timer->deadline_ - now() : 
                std::chrono::hours(1);
            
            // 3. 等待或处理到期事件
            std::unique_lock<std::mutex> lock(mutex_);
            if (cv_.wait_for(lock, wait_time) == std::cv_status::timeout) {
                // 定时器到期
                lock.unlock();
                next_timer->trigger();
            }
        }
    }
    
    std::thread event_thread_;
    std::priority_queue<Timer*, std::vector<Timer*>, TimerCompare> timers_;
};
```

**关键特性**:
- 单线程顺序执行（避免回调并发问题）
- 高精度定时（毫秒级）
- 优先级队列管理

### 2.2 AsyncSendThreadPool (异步发送线程池)

**职责**: 处理异步发布的大消息

```cpp
// 源码位置: src/cpp/rtps/writer/AsyncWriterThread.cpp

class AsyncWriterThread {
public:
    void start(int thread_count = std::thread::hardware_concurrency()) {
        for (int i = 0; i < thread_count; ++i) {
            threads_.emplace_back([this]() {
                while (running_) {
                    AsyncWriteTask task;
                    
                    // 从任务队列获取
                    {
                        std::unique_lock<std::mutex> lock(queue_mutex_);
                        cv_.wait(lock, [this] { 
                            return !tasks_.empty() || !running_; 
                        });
                        
                        if (!running_) break;
                        
                        task = std::move(tasks_.front());
                        tasks_.pop();
                    }
                    
                    // 执行任务
                    execute_write_task(task);
                }
            });
        }
    }
    
    void enqueue_write(DataWriterImpl* writer, CacheChange_t* change) {
        std::lock_guard<std::mutex> lock(queue_mutex_);
        tasks_.push({writer, change});
        cv_.notify_one();
    }
    
private:
    std::vector<std::thread> threads_;
    std::queue<AsyncWriteTask> tasks_;
    std::mutex queue_mutex_;
    std::condition_variable cv_;
};
```

**任务类型**:
| 任务 | 说明 | 优先级 |
|------|------|--------|
| `WRITE_DATA` | 发送普通数据 | Normal |
| `WRITE_FRAG` | 发送分片数据 | Normal |
| `HEARTBEAT` | 发送心跳 | High |
| `GAP` | 发送间隙通知 | Low |

### 2.3 Transport Receive Thread (接收线程)

**职责**: 监听网络端口，接收数据

```cpp
// 源码位置: src/cpp/rtps/transport/UDPv4Transport.cpp

void UDPv4Transport::ReceiveThread() {
    // 设置接收缓冲区
    std::vector<uint8_t> receive_buffer(65536);
    
    while (running_) {
        // 阻塞接收
        auto result = socket_.receive_from(
            asio::buffer(receive_buffer),
            sender_endpoint
        );
        
        if (result > 0) {
            // 1. 解析 RTPS 消息头
            RTPSMessageHeader header;
            if (parse_header(receive_buffer.data(), header)) {
                // 2. 路由到对应的 Participant
                auto participant = find_participant(header.guid_prefix);
                
                if (participant) {
                    // 3. 提交到 Reader 处理队列
                    participant->enqueue_received_message(
                        receive_buffer.data(), 
                        result,
                        sender_endpoint
                    );
                }
            }
        }
    }
}
```

**多传输类型**:
| 传输 | 线程数 | 模型 |
|------|--------|------|
| UDPv4 | 1 | 单线程 epoll/kqueue |
| TCPv4 | 2 | Accept + IO 分离 |
| SHM | 0 | 无（通过信号量通知） |

---

## 三、线程职责详解

### 3.1 发现协议线程

```cpp
// SPDP 宣告线程职责

class SPDPAnnounceThread {
    void run() {
        while (participant_->is_active()) {
            // 1. 构建 Participant 发现数据
            ParticipantProxyData ppd;
            ppd.guid = participant_->guid();
            ppd.metatraffic_unicast_locators = participant_->metatraffic_locators();
            ppd.default_unicast_locators = participant_->default_locators();
            ppd.available_builtin_endpoints = DISC_BUILTIN_ENDPOINT_PARTICIPANT_ANNOUNCER;
            
            // 2. 发送 SPDP 宣告 (DATA(p) 消息)
            for (auto& locator : participant_->initial_peers()) {
                send_spdp_discovery_data(ppd, locator);
            }
            
            // 3. 等待下一次宣告 (3秒周期)
            std::this_thread::sleep_for(std::chrono::seconds(3));
        }
    }
};
```

### 3.2 可靠传输线程

```cpp
// StatefulWriter 可靠重传线程

class ReliableResendThread {
    void run() {
        while (writer_->is_active()) {
            auto now = std::chrono::steady_clock::now();
            
            // 1. 检查所有匹配的 Reader
            for (auto& reader : writer_->matched_readers()) {
                // 2. 检查未确认的序列号
                for (auto seq : reader.outstanding_changes()) {
                    auto change = writer_->find_change(seq);
                    
                    // 3. 检查是否超时（指数退避）
                    auto backoff = calculate_backoff(change->retry_count);
                    if (now - change->last_send_time > backoff) {
                        // 4. 重传
                        writer_->send_change_to_reader(change, reader);
                        change->retry_count++;
                        change->last_send_time = now;
                    }
                }
            }
            
            // 5. 等待 100ms 或收到 ACKNACK 信号
            cv_.wait_for(lock, std::chrono::milliseconds(100));
        }
    }
};
```

### 3.3 数据处理流水线

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         数据处理流水线                                   │
└─────────────────────────────────────────────────────────────────────────┘

接收流程 (Receive → Deserialize → Deliver)
┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐
│ Network │ → │ Receive │ → │ Parse   │ → │ Route   │ → │ Reader  │
│ Packet  │   │ Thread  │   │ RTPS    │   │ to      │   │ Queue   │
│         │   │ (内核)   │   │ Message │   │ Reader  │   │         │
└─────────┘   └─────────┘   └─────────┘   └─────────┘   └─────────┘
    │              │             │            │             │
    │ 1.网卡中断    │ 2.系统调用   │ 3.协议解析  │ 4.GUID匹配   │ 5.入队
    │    ↓         │    ↓        │    ↓       │    ↓        │    ↓
    └────────────────────────────┴────────────┴─────────────┴────┐
                                                               │
                                                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Reader Processing Thread (用户回调线程 或 Fast-DDS 内部线程)            │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  6. 反序列化 (CDR → 对象)                                        │   │
│  │  7. HistoryCache 插入 (排序/去重)                                 │   │
│  │  8. 触发 Listener::on_data_available()                           │   │
│  │  9. 发送 ACKNACK (如果是可靠传输)                                 │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘

发送流程 (Serialize → Fragment → Send)
┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐
│ User    │ → │ Serialize│ → │ Fragment│ → │ Enqueue │ → │ Transport│
│ Data    │   │ (CDR)   │   │ (if >MTU)│   │ to Send │   │ Thread   │
│         │   │         │   │         │   │ Queue   │   │          │
└─────────┘   └─────────┘   └─────────┘   └─────────┘   └─────────┘
    │              │             │            │             │
    │ 1.用户调用    │ 2.类型支持   │ 3.分片计算  │ 4.批量入队   │ 5.网络发送
    │    write()   │    ↓        │    ↓       │    ↓        │    ↓
    └────────────────────────────┴────────────┴─────────────┴────┘
```

---

## 四、线程间通信机制

### 4.1 无锁队列 (SPSC - 单生产者单消费者)

```cpp
// 用于: Receive Thread → Reader Thread

#include <boost/lockfree/spsc_queue.hpp>

template<typename T>
class LockFreeQueue {
public:
    LockFreeQueue(size_t capacity) : queue_(capacity) {}
    
    bool enqueue(const T& item) {
        return queue_.push(item);
    }
    
    bool dequeue(T& item) {
        return queue_.pop(item);
    }
    
private:
    boost::lockfree::spsc_queue<T, 
        boost::lockfree::capacity<1024>> queue_;
};

// 使用场景: 接收线程将消息分发给 Reader
LockFreeQueue<ReceivedMessage> receive_queue_;
```

### 4.2 有锁队列 (MPMC - 多生产者多消费者)

```cpp
// 用于: Async Send Thread Pool

#include <queue>
#include <mutex>
#include <condition_variable>

template<typename T>
class BlockingQueue {
public:
    void enqueue(T item) {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            queue_.push(std::move(item));
        }
        cv_.notify_one();
    }
    
    T dequeue() {
        std::unique_lock<std::mutex> lock(mutex_);
        cv_.wait(lock, [this] { return !queue_.empty() || shutdown_; });
        
        if (queue_.empty()) return T{};  // Shutdown
        
        T item = std::move(queue_.front());
        queue_.pop();
        return item;
    }
    
private:
    std::queue<T> queue_;
    std::mutex mutex_;
    std::condition_variable cv_;
    bool shutdown_ = false;
};
```

### 4.3 原子变量与内存序

```cpp
// 用于: 状态标志、计数器

class ThreadSafeCounter {
    std::atomic<uint64_t> count_{0};
    
public:
    void increment() {
        // 宽松内存序：仅用于计数，不需要同步
        count_.fetch_add(1, std::memory_order_relaxed);
    }
    
    uint64_t get() const {
        return count_.load(std::memory_order_relaxed);
    }
};

class ThreadSafeFlag {
    std::atomic<bool> flag_{false};
    
public:
    void set() {
        // 释放语义：确保之前的写入可见
        flag_.store(true, std::memory_order_release);
    }
    
    bool test_and_set() {
        // 获取-释放语义
        return flag_.exchange(true, std::memory_order_acq_rel);
    }
    
    bool wait_and_clear() {
        // 自旋等待（适用于短时间等待）
        while (!flag_.load(std::memory_order_acquire)) {
            std::this_thread::yield();
        }
        flag_.store(false, std::memory_order_release);
        return true;
    }
};
```

### 4.4 读写锁 (Reader-Writer Lock)

```cpp
// 用于: HistoryCache (多读少写)

#include <shared_mutex>

class ReaderHistoryCache {
public:
    void add_change(CacheChange_t* change) {
        // 写锁
        std::unique_lock<std::shared_mutex> lock(mutex_);
        changes_.insert(change);
    }
    
    CacheChange_t* find_change(SequenceNumber_t seq) {
        // 读锁
        std::shared_lock<std::shared_mutex> lock(mutex_);
        auto it = changes_.find(seq);
        return (it != changes_.end()) ? *it : nullptr;
    }
    
    std::vector<CacheChange_t*> get_all_changes() {
        // 读锁
        std::shared_lock<std::shared_mutex> lock(mutex_);
        return std::vector<CacheChange_t*>(changes_.begin(), changes_.end());
    }
    
private:
    std::set<CacheChange_t*> changes_;
    std::shared_mutex mutex_;
};
```

---

## 五、线程安全设计

### 5.1 DDS API 线程安全保证

```cpp
// Fast-DDS 保证以下操作是线程安全的:

// 1. 多线程同时写入不同 DataWriter (安全)
void thread1() { writer1->write(&data1); }
void thread2() { writer2->write(&data2); }

// 2. 多线程同时读取不同 DataReader (安全)
void thread3() { reader1->take_next_sample(&data1); }
void thread4() { reader2->take_next_sample(&data2); }

// 3. 同一 DataWriter 多线程写入 (安全，内部加锁)
void thread5() { writer->write(&data1); }
void thread6() { writer->write(&data2); }

// ❌ 不保证线程安全（需要用户同步）:
// - 同一 DataReader 多线程同时 take (可能导致竞争)
// - 多线程同时修改 QoS (需要外部锁)
```

### 5.2 内部数据结构保护

```cpp
// 示例: StatefulWriter 的线程安全设计

class StatefulWriter {
public:
    void write(CacheChange_t* change) {
        // 步骤1: 分配序列号 (原子操作)
        change->sequenceNumber = next_sequence_number_.fetch_add(1);
        
        // 步骤2: 添加到 HistoryCache (写锁)
        {
            std::unique_lock<std::shared_mutex> lock(history_mutex_);
            history_.add(change);
        }
        
        // 步骤3: 分发给所有 Reader (读锁保护 Reader 列表)
        std::vector<ReaderProxy*> readers_copy;
        {
            std::shared_lock<std::shared_mutex> lock(readers_mutex_);
            readers_copy = matched_readers_;
        }
        
        // 步骤4: 发送 (无锁，操作局部数据)
        for (auto reader : readers_copy) {
            send_to_reader(change, reader);
        }
    }
    
    void on_acknack_received(ReaderProxy* reader, AckNackSubmessage& acknack) {
        // 处理 ACKNACK (可能来自接收线程)
        std::lock_guard<std::mutex> lock(reader->mutex);
        reader->update_acknack(acknack);
        
        // 唤醒重传线程
        resend_cv_.notify_one();
    }
    
private:
    std::atomic<SequenceNumber_t> next_sequence_number_{1};
    WriterHistory history_;
    std::shared_mutex history_mutex_;
    std::vector<ReaderProxy*> matched_readers_;
    std::shared_mutex readers_mutex_;
    std::condition_variable resend_cv_;
};
```

### 5.3 死锁避免策略

```cpp
// 策略1: 锁顺序

class DeadlockPrevention {
    // 定义全局锁顺序: A → B → C
    
    void operation1() {
        lock(A);  // 先锁 A
        lock(B);  // 再锁 B
        // 操作...
    }
    
    void operation2() {
        lock(A);  // 先锁 A
        lock(C);  // 再锁 C
        // 操作...
    }
    
    void operation3() {
        lock(B);  // 先锁 B
        lock(C);  // 再锁 C
        // 操作...
    }
    // 永远不会出现: 线程1持有A等B，线程2持有B等A
};

// 策略2: 超时锁

bool try_operation_with_timeout() {
    std::unique_lock<std::mutex> lock(mutex_, std::chrono::milliseconds(100));
    if (!lock) {
        // 超时，记录日志，返回错误
        return false;
    }
    // 正常操作
    return true;
}

// 策略3: 无锁设计

class LockFreeHistory {
    std::atomic<CacheChange_t*> head_{nullptr};
    
public:
    void push(CacheChange_t* change) {
        // CAS 循环
        do {
            change->next = head_.load(std::memory_order_relaxed);
        } while (!head_.compare_exchange_weak(
            change->next, change,
            std::memory_order_release,
            std::memory_order_relaxed));
    }
};
```

---

## 六、性能调优

### 6.1 线程数配置

```cpp
DomainParticipantQos qos;

// 1. 异步发送线程数 (默认: CPU核心数)
qos.publish_mode().kind = ASYNCHRONOUS_PUBLISH_MODE;
qos.publish_mode().async_thread_count = 8;  // 明确指定

// 2. 接收缓冲区大小 (影响接收线程)
qos.transport().listen_socket_buffer_size = 1048576;  // 1MB
qos.transport().listen_socket_receive_buffer_size = 1048576;

// 3. 发送缓冲区大小
qos.transport().output_udp_socket_buffer_size = 1048576;

// 4. 禁用内置传输 (如果只用 SHM)
qos.transport().use_builtin_transports = false;
auto shm_transport = std::make_shared<SharedMemTransportDescriptor>();
qos.transport().user_transports.push_back(shm_transport);
```

### 6.2 CPU 亲和性绑定

```cpp
// Linux: 将线程绑定到特定 CPU 核心

#include <pthread.h>

void set_thread_affinity(std::thread& t, int cpu_id) {
    cpu_set_t cpuset;
    CPU_ZERO(&cpuset);
    CPU_SET(cpu_id, &cpuset);
    
    pthread_setaffinity_np(
        t.native_handle(),
        sizeof(cpu_set_t),
        &cpuset
    );
}

// 使用: 将接收线程绑定到 CPU 0
set_thread_affinity(receive_thread, 0);

// 将发送线程绑定到 CPU 1
set_thread_affinity(send_thread, 1);
```

### 6.3 线程优先级设置

```cpp
// Linux 实时优先级

#include <pthread.h>
#include <sched.h>

void set_realtime_priority(std::thread& t, int priority) {
    sched_param param;
    param.sched_priority = priority;
    
    pthread_setschedparam(
        t.native_handle(),
        SCHED_FIFO,  // 实时调度策略
        &param
    );
}

// 优先级建议:
// - 接收线程: 高优先级 (实时)
// - 发送线程: 中优先级
// - 定时器线程: 高优先级
// - 后台任务: 低优先级
```

### 6.4 减少线程竞争

```cpp
// 策略1: 线程本地存储 (TLS)

thread_local std::vector<uint8_t> tls_send_buffer;

void send_data(const void* data, size_t size) {
    if (tls_send_buffer.size() < size) {
        tls_send_buffer.resize(size);
    }
    memcpy(tls_send_buffer.data(), data, size);
    // 使用 tls_send_buffer 发送，无需锁
}

// 策略2: 分区设计

class PartitionedWriter {
    static constexpr int NUM_PARTITIONS = 8;
    
    struct Partition {
        std::queue<CacheChange_t*> queue;
        std::mutex mutex;
    };
    
    Partition partitions_[NUM_PARTITIONS];
    
public:
    void write(CacheChange_t* change) {
        // 根据序列号选择分区
        int partition_id = change->sequenceNumber % NUM_PARTITIONS;
        
        auto& part = partitions_[partition_id];
        std::lock_guard<std::mutex> lock(part.mutex);
        part.queue.push(change);
    }
    // 竞争降低为原来的 1/NUM_PARTITIONS
};
```

---

## 七、源码分析

### 7.1 线程创建流程

```cpp
// DomainParticipant 初始化时创建线程

DomainParticipantImpl::DomainParticipantImpl() {
    // 1. 创建资源事件线程 (定时器)
    resource_event_.init_thread();
    
    // 2. 创建异步发送线程池 (如果启用异步模式)
    if (qos_.publish_mode().kind == ASYNCHRONOUS_PUBLISH_MODE) {
        async_writer_thread_.start(qos_.publish_mode().async_thread_count);
    }
    
    // 3. 创建传输层接收线程
    for (auto& transport : qos_.transport().user_transports) {
        transport->init();
        transport->start_receive_thread();
    }
    
    // 4. 创建发现协议线程
    builtin_protocols_.init();
}
```

### 7.2 线程销毁流程

```cpp
DomainParticipantImpl::~DomainParticipantImpl() {
    // 1. 停止发现协议
    builtin_protocols_.stop();
    
    // 2. 停止传输层接收线程
    for (auto& transport : qos_.transport().user_transports) {
        transport->stop_receive_thread();
    }
    
    // 3. 停止异步发送线程池
    if (async_writer_thread_.running()) {
        async_writer_thread_.stop();
    }
    
    // 4. 停止资源事件线程
    resource_event_.stop_thread();
}
```

### 7.3 关键路径分析

```
数据发送关键路径 (延迟优化点):
┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
│ User Call│ → │ Serialize│ → │ Enqueue  │ → │ Network  │
│  ~1μs    │   │  ~1-10μs │   │  ~1μs    │   │  ~10-50μs│
└──────────┘   └──────────┘   └──────────┘   └──────────┘
     │              │              │              │
     └──────────────┴──────────────┴──────────────┘
                    总延迟: ~15-60μs

优化手段:
- 预分配序列化缓冲区 (减少 Serialize 时间)
- 批量入队 (减少 Enqueue 竞争)
- 共享内存 (消除 Network 延迟)

数据接收关键路径:
┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
│ Network  │ → │ Receive  │ → │ Deserialize│ → │ Deliver  │
│  ~10-50μs│   │  ~1μs    │   │  ~1-10μs │   │  ~1μs    │
└──────────┘   └──────────┘   └──────────┘   └──────────┘
     │              │              │              │
     └──────────────┴──────────────┴──────────────┘
                    总延迟: ~15-60μs
```

---

## 八、常见问题与调试

### 8.1 线程相关故障排查

| 问题现象 | 可能原因 | 排查方法 |
|---------|---------|---------|
| **CPU 占用 100%** | 忙等待循环 | 检查自旋锁、while(!flag) |
| **消息延迟大** | 线程竞争 | 查看锁等待时间、线程状态 |
| **消息丢失** | 接收线程阻塞 | 检查接收缓冲区溢出 |
| **死锁** | 锁顺序错误 | 使用锁检测工具 (如 helgrind) |
| **内存泄漏** | 线程未正确退出 | 检查线程 join/detach |

### 8.2 调试工具

```bash
# 1. 查看线程状态
ps -T -p <fastdds_pid>

# 2. 查看 CPU 亲和性
taskset -pc <fastdds_pid>

# 3. 查看实时优先级
chrt -p <fastdds_pid>

# 4. 线程性能分析
perf top -p <fastdds_pid>

# 5. 锁竞争分析
valgrind --tool=helgrind ./fastdds_app
```

### 8.3 线程命名规范

```cpp
// Fast-DDS 内部线程命名 (便于调试)

void set_thread_name(const char* name) {
    #ifdef __linux__
    pthread_setname_np(pthread_self(), name);
    #elif defined(__APPLE__)
    pthread_setname_np(name);
    #endif
}

// 使用
set_thread_name("FastEvent");      // 事件线程
set_thread_name("FastSend");       // 发送线程
set_thread_name("FastRecv");       // 接收线程
set_thread_name("FastDisc");       // 发现线程

// 查看: top -H -p <pid> 或 ps -T
```

### 8.4 性能监控

```cpp
// 线程级性能统计

class ThreadMonitor {
public:
    struct Stats {
        uint64_t task_count = 0;
        uint64_t total_latency_us = 0;
        uint64_t max_latency_us = 0;
        uint64_t queue_depth = 0;
    };
    
    void record_task(std::chrono::microseconds latency) {
        stats_.task_count++;
        stats_.total_latency_us += latency.count();
        stats_.max_latency_us = std::max(
            stats_.max_latency_us, 
            (uint64_t)latency.count()
        );
    }
    
    double get_avg_latency() const {
        if (stats_.task_count == 0) return 0.0;
        return (double)stats_.total_latency_us / stats_.task_count;
    }
    
private:
    Stats stats_;
    std::atomic<uint64_t> queue_depth_{0};
};
```

---

## 九、总结

### 核心要点

1. **线程架构**: 事件线程 + 异步发送线程池 + 接收线程 + 发现线程

2. **线程安全**: 原子变量 + 读写锁 + 无锁队列 + 明确的锁顺序

3. **通信机制**: SPSC 无锁队列 (高吞吐) + MPMC 阻塞队列 (灵活)

4. **性能优化**: CPU 亲和性绑定 + 实时优先级 + 分区设计 + TLS

5. **最佳实践**:
   - 回调必须轻量，避免阻塞
   - 明确锁顺序，避免死锁
   - 监控线程状态，及时调优
   - 使用线程命名，便于调试

---

*文档版本: 1.0*  
*最后更新: 2026-03-13*  
*关联笔记: 15-Timer-System.md, 14-Memory-Fragmentation.md*
