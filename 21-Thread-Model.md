# Fast-DDS 线程模型深度分析

> 📌 **代码来源说明**：本文中的代码示例分为两类：
> 1. **实际源码**：来自 [Fast-DDS 官方仓库](https://github.com/eProsima/Fast-DDS)，链接已标注
> 2. **简化示例**：为教学目的简化，省略了锁、异常处理等细节
>
> **重要更正**：文中使用的 `AsyncWriterThread` 是**概念性命名**，实际源码中的对应实现为 `FlowControllerAsyncPublishMode`，位于 `src/cpp/rtps/flowcontrol/FlowControllerImpl.hpp`

---


## 目录
1. [线程模型概览](#1-线程模型概览)
2. [核心线程详解](#2-核心线程详解)
3. [线程间通信机制](#3-线程间通信机制)
4. [线程安全设计](#4-线程安全设计)
5. [线程配置与调优](#5-线程配置与调优)
6. [线程问题排查](#6-线程问题排查)
7. [实战：线程Dump分析](#7-实战线程dump分析)

---

## 1. 线程模型概览

### 1.1 线程架构全景图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Fast-DDS 线程模型全景                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  【主线程】应用层                                                            │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  用户代码                                                           │   │
│  │  ├── DomainParticipantFactory::create_participant()                │   │
│  │  ├── publisher->create_datawriter()                                │   │
│  │  ├── writer->write()                                               │   │
│  │  └── subscriber->take()                                            │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                         │
│  ┌─────────────────────────────────┼─────────────────────────────────────┐ │
│  │                    【Fast-DDS 内部线程池】                          │ │
│  │                                                                   │ │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐    │ │
│  │  │   Event Thread  │  │  Async Writer   │  │   Transport     │    │ │
│  │  │                 │  │     Thread      │  │    Threads      │    │ │
│  │  │ • 定时器处理    │  │                 │  │                 │    │ │
│  │  │ • 状态机驱动    │  │ • 异步数据发送  │  │ • UDP接收       │    │ │
│  │  │ • 租约检查      │  │ • 流量控制      │  │ • TCP连接管理   │    │ │
│  │  │ • 心跳/重传     │  │ • 批量发送      │  │ • SHM事件       │    │ │
│  │  │                 │  │                 │  │                 │    │ │
│  │  │   ResourceEvent │  │ FlowControllerAsyncPublishMode│  │  TransportLayer │    │ │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘    │ │
│  │                                                                   │ │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐    │ │
│  │  │ Discovery Thread│  │ Security Thread │  │  DB Thread      │    │ │
│  │  │                 │  │  (可选)         │  │ (Server模式)    │    │ │
│  │  │ • PDP周期性发送 │  │                 │  │                 │    │ │
│  │  │ • EDP匹配处理   │  │ • 加密/解密     │  │ • 持久化存储    │    │ │
│  │  │ • 租约过期检测  │  │ • 认证握手      │  │ • 数据查询      │    │ │
│  │  │                 │  │                 │  │                 │    │ │
│  │  │ PDPEndpointImpl │  │ SecurityManager │  │ DiscoveryDB     │    │ │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘    │ │
│  │                                                                   │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                    │                                     │
│  【系统层】网络/IO                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  • UDP Socket (端口 7400+)                                          │   │
│  │  • TCP Socket (可选)                                                │   │
│  │  • 共享内存 (可选)                                                  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 线程创建时机

```cpp
// 线程创建时间线

【Participant 创建时】
├── ResourceEvent (事件线程)
│   └── 用于定时器：心跳、重传、租约检查
│
├── Transport 接收线程
│   └── UDP/TCP 接收线程 (每个 Transport 一个)
│
├── PDP 定时器线程
│   └── 周期性广播参与者发现信息
│
└── Security 线程 (如果启用 DDS-Security)
    └── 认证握手、加密解密

【DataWriter 创建时 (ASYNC 模式)】
└── FlowControllerAsyncPublishMode (全局单例)
    └── 异步发送数据

【Discovery Server 模式】
└── DiscoveryServer 线程
    └── 处理客户端请求、数据库维护
```

---

## 2. 核心线程详解

### 2.1 ResourceEvent (事件/定时器线程)

```cpp
// include/fastdds/rtps/resources/ResourceEvent.h

class ResourceEvent
{
public:
    // 启动事件循环线程
    void init_thread();
    
    // 注册定时事件
    void register_timer(TimedEventImpl* event);
    void unregister_timer(TimedEventImpl* event);
    
    // 唤醒线程 (新事件加入时)
    void notify();

private:
    void run_io_service();  // 线程主循环
    
    std::thread thread_;                    // 事件处理线程
    asio::io_service io_service_;           // ASIO IO服务
    asio::io_service::work work_;           // 防止io_service退出
    std::mutex mutex_;                      // 保护定时器集合
    std::condition_variable cv_;            // 唤醒条件变量
    std::atomic<bool> stop_;                // 停止标志
};
```

**工作流程**:

```
┌─────────────────────────────────────────────────────────────────┐
│                    ResourceEvent 线程循环                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  初始化                                                          │
│     │                                                            │
│     ▼                                                            │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  while (!stop_) {                                        │    │
│  │                                                           │    │
│  │      // 1. 计算下一个定时器到期时间                       │    │
│  │      next_timeout = get_earliest_timer();                │    │
│  │                                                           │    │
│  │      // 2. 等待直到到期或被唤醒                           │    │
│  │      cv_.wait_until(next_timeout);                       │    │
│  │                                                           │    │
│  │      // 3. 执行所有到期的定时器回调                       │    │
│  │      for (timer in expired_timers) {                     │    │
│  │          timer->callback();                              │    │
│  │      }                                                   │    │
│  │  }                                                       │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  定时器类型:                                                     │
│  ├── HEARTBEAT 定时器 (StatefulWriter)                         │
│  ├── NACK 响应定时器                                             │
│  ├── 租约检查定时器 (PDP/Reader/Writer)                         │
│  └── 重传定时器                                                  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**典型定时器**:

```cpp
// StatefulWriter 的心跳定时器
TimedEvent heartbeat_event_(
    [this]() { send_heartbeat_to_all_readers(); },
    heartbeat_period_  // 默认 3s
);

// Reader 的租约检查定时器
TimedEvent liveliness_check_event_(
    [this]() { check_reader_liveliness(); },
    lease_duration_    // 默认 10s
);

// 可靠传输的重传定时器
TimedEvent nack_response_event_(
    [this]() { perform_nack_responses(); },
    nack_response_delay_  // 默认 100ms
);
```

### 2.2 FlowControllerAsyncPublishMode (异步写入线程)

```cpp
// src/cpp/rtps/writer/FlowControllerAsyncPublishMode.cpp

class FlowControllerAsyncPublishMode
{
public:
    // 全局单例
    static FlowControllerAsyncPublishMode& get_instance();
    
    // 启动/停止
    static bool start();
    static bool stop();
    
    // 注册/注销 Writer
    static bool add_writer(RTPSWriter* writer);
    static bool remove_writer(RTPSWriter* writer);
    
    // 唤醒线程
    static void wake_up();

private:
    void run();  // 线程主循环
    
    std::thread thread_;
    std::mutex mutex_;
    std::condition_variable cv_;
    std::unordered_set<RTPSWriter*> writers_;
    std::atomic<bool> running_;
};
```

**工作流程**:

```
┌─────────────────────────────────────────────────────────────────┐
│                   FlowControllerAsyncPublishMode 线程循环                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  启动                                                            │
│     │                                                            │
│     ▼                                                            │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  while (running_) {                                      │    │
│  │      std::unique_lock<std::mutex> lock(mutex_);         │    │
│  │                                                           │    │
│  │      // 1. 遍历所有异步 Writer                           │    │
│  │      for (RTPSWriter* writer : writers_) {              │    │
│  │                                                           │    │
│  │          // 2. 检查 FlowController 是否允许发送          │    │
│  │          if (writer->flow_controller_->schedule(...)) {  │    │
│  │                                                           │    │
│  │              // 3. 发送未发送的数据                       │    │
│  │              writer->send_any_unsent_changes();          │    │
│  │          }                                               │    │
│  │      }                                                   │    │
│  │                                                           │    │
│  │      // 4. 计算下次唤醒时间 (流控或新数据)                │    │
│  │      auto next_wakeup = calculate_next_wakeup();        │    │
│  │                                                           │    │
│  │      // 5. 等待直到唤醒                                   │    │
│  │      cv_.wait_until(lock, next_wakeup);                 │    │
│  │  }                                                       │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  唤醒场景:                                                       │
│  • 新数据写入 (write() 调用)                                    │
│  • FlowController 令牌可用                                      │
│  • 网络发送完成回调                                             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.3 Transport 接收线程

```cpp
// src/cpp/transport/UDPTransportInterface.cpp

class UDPTransportInterface
{
    // 每个 UDP 端口一个接收线程
    void open_output_channel(Locator_t locator);
    
    // 接收线程主函数
    void perform_listen_operation(UDPChannelResource* channel);
};

// 线程创建
void UDPTransportInterface::perform_listen_operation(UDPChannelResource* channel)
{
    while (channel->alive()) {
        // 1. 阻塞接收 UDP 数据
        ssize_t bytes = recvfrom(socket, buffer, ...);
        
        if (bytes > 0) {
            // 2. 解析 RTPS 消息
            MessageReceiver receiver;
            receiver.process_data(buffer, bytes, locator);
            
            // 3. 分发到对应的 Participant/Reader/Writer
            dispatch_message(receiver);
        }
    }
}
```

**线程模型**:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Transport 接收线程模型                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  UDP 端口分配:                                                   │
│  ├── 端口 7410: 参与者 1 的接收端口                              │
│  ├── 端口 7411: 参与者 1 的内置发现端口                          │
│  ├── 端口 7420: 参与者 2 的接收端口                              │
│  └── ...                                                        │
│                                                                  │
│  线程创建:                                                       │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ for each opened channel:                                │    │
│  │     std::thread t(perform_listen_operation, channel);   │    │
│  │     t.detach();  // 分离线程，独立运行                   │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  数据处理流程:                                                   │
│  UDP 接收线程                                                    │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ 1. 接收原始字节流                                         │    │
│  │       │                                                  │    │
│  │       ▼                                                  │    │
│  │ 2. 解析 RTPS Header + SubMessages                         │    │
│  │       │                                                  │    │
│  │       ▼                                                  │    │
│  │ 3. 根据 GUID Prefix 找到目标 Participant                  │    │
│  │       │                                                  │    │
│  │       ▼                                                  │    │
│  │ 4. 分发给对应的 Endpoint (Reader/Writer)                  │    │
│  │       │                                                  │    │
│  │       ▼                                                  │    │
│  │ 5. 回调用户 Listener (on_data_available)                  │    │
│  │       ↑                                                  │    │
│  │       └── 可能触发新的事件 (如发送 ACKNACK)               │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  注意: 回调在用户线程还是 Transport 线程？                        │
│  - 默认: Transport 线程直接回调 (快速但阻塞接收)                  │
│  - 可选: 通过线程池回调 (避免阻塞)                                │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.4 Discovery 线程

```cpp
// src/cpp/rtps/builtin/discovery/participant/PDP.cpp

class PDP
{
    // 发现相关定时器由 ResourceEvent 线程执行
    // 但复杂的发现逻辑可能创建独立线程
    
    TimedEvent resend_participant_info_event_;  // 重发 PDP 信息
    TimedEvent remove_remote_participants_event_;  // 清理过期参与者
};

// Discovery Server 模式下的独立线程
class DiscoveryServerManager
{
    void start_processing_thread();
    void stop_processing_thread();
    
    void process_discovery_requests();  // 线程主循环
    
    std::thread processing_thread_;
    BlockingQueue<DiscoveryRequest> request_queue_;
};
```

**发现流程**:

```
┌─────────────────────────────────────────────────────────────────┐
│                     Discovery 线程模型                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Simple Discovery (默认):                                        │
│  └── 使用 ResourceEvent 线程的定时器                            │
│      ├── 每 3s 发送 PDP (Participant Discovery)                 │
│      └── 每 10s 检查参与者租约                                  │
│                                                                  │
│  Discovery Server 模式:                                          │
│  ├── ResourceEvent 线程 (定时器)                                │
│  │   └── 客户端: 定期同步服务器                                │
│  │                                                                │
│  └── DiscoveryServerManager 线程 (独立)                         │
│      ├── 处理客户端注册请求                                     │
│      ├── 维护发现数据库                                         │
│      └── 响应查询请求                                           │
│                                                                  │
│  线程交互:                                                       │
│  ┌──────────────────┐      ┌──────────────────┐                │
│  │ Transport 接收    │      │ DiscoveryServer   │                │
│  │ 线程              │─────→│ 线程              │                │
│  │ (收到PDP请求)    │      │ (处理请求)        │                │
│  └──────────────────┘      └──────────────────┘                │
│           │                           │                        │
│           │                           ▼                        │
│           │                  ┌──────────────────┐              │
│           │                  │ 更新数据库       │              │
│           │                  └──────────────────┘              │
│           │                           │                        │
│           ▼                           ▼                        │
│  ┌──────────────────┐      ┌──────────────────┐              │
│  │ 发送 PDP 响应    │      │ 广播更新         │              │
│  │ (异步发送)       │      │ (给所有客户端)   │              │
│  └──────────────────┘      └──────────────────┘              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. 线程间通信机制

### 3.1 通信方式总览

```
┌─────────────────────────────────────────────────────────────────┐
│                    线程间通信机制                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. 条件变量 + 互斥锁 (最常见)                                   │
│     ├── FlowControllerAsyncPublishMode 唤醒                                  │
│     └── ResourceEvent 新定时器                                  │
│                                                                  │
│  2. 无锁队列 (Lock-free Queue)                                  │
│     ├── Transport 接收数据缓冲                                  │
│     └── Discovery Server 请求队列                               │
│                                                                  │
│  3. 回调机制 (Callback)                                         │
│     ├── Listener 回调 (on_data_available)                       │
│     └── 定时器回调                                              │
│                                                                  │
│  4. 原子变量 + 内存序 (Atomic)                                  │
│     ├── 状态标志位                                              │
│     └── 计数器                                                  │
│                                                                  │
│  5. ASIO IO Service (异步IO)                                    │
│     └── ResourceEvent 的底层机制                                │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 关键通信场景

```cpp
// 场景 1: write() 唤醒 FlowControllerAsyncPublishMode

// 用户线程 (调用 write)
void DataWriterImpl::write(void* data) {
    // ... 序列化 ...
    history_->add_change(change);
    
    // 唤醒 FlowControllerAsyncPublishMode
    FlowControllerAsyncPublishMode::wake_up();
}

// FlowControllerAsyncPublishMode
void FlowControllerAsyncPublishMode::wake_up() {
    std::lock_guard<std::mutex> lock(mutex_);
    cv_.notify_one();  // 唤醒等待的线程
}

// ====================

// 场景 2: Transport 接收回调到 Reader

// Transport 接收线程
void UDPTransportInterface::perform_listen_operation(...) {
    recvfrom(socket, buffer, ...);
    
    // 解析后回调
    MessageReceiver receiver;
    receiver.process_data(buffer, ...);
    
    // 分发到 StatefulReader
    reader->process_data_msg(change);
    
    // Reader 内部可能需要发送 ACKNACK
    reader->send_acknack_to_writer(writer);
}

// ====================

// 场景 3: 定时器触发心跳发送

// ResourceEvent 线程
void ResourceEvent::run_io_service() {
    while (!stop_) {
        // ASIO 等待定时器到期
        io_service_.run_one();
        
        // 执行到期回调
        // → StatefulWriter::send_heartbeat()
    }
}
```

---

## 4. 线程安全设计

### 4.1 线程安全级别

```cpp
// Fast-DDS 的线程安全保证

【线程安全 (Thread-Safe)】
├── DomainParticipantFactory::get_instance()  // 单例，线程安全
├── DomainParticipant::create_xxx()           // 工厂方法
└── DataWriter::write()                       // 可并发调用

【需要外部同步 (Not Thread-Safe)】
├── DataWriterListener 回调                   // 由接收线程调用
│   └── 如果回调中访问共享数据，需要加锁
└── 用户自定义 TypeSupport                    // 用户保证线程安全

【内部同步机制】
├── Mutex (std::mutex, std::recursive_mutex)
├── Spinlock (自旋锁，用于短时临界区)
└── RWLock (读写锁，用于读多写少场景)
```

### 4.2 关键锁分析

```cpp
// StatefulWriter 的锁策略

class StatefulWriter : public RTPSWriter
{
    // 保护 matched_readers_ 集合
    std::mutex mutex_;
    
    // 保护 HistoryCache
    std::mutex cache_mutex_;
    
    // ReaderProxy 内部有自己的锁
    // 减少锁粒度，避免全局锁竞争
};

// 锁粒度设计
void StatefulWriter::send_any_unsent_changes() {
    // 1. 获取读锁，遍历 Reader 列表
    std::shared_lock<std::shared_mutex> read_lock(mutex_);
    
    for (ReaderProxy* reader : matched_readers_) {
        // 2. 每个 Reader 独立加锁
        std::lock_guard<std::mutex> reader_lock(reader->mutex_);
        
        // 3. 处理该 Reader 的数据
        send_changes_to_reader(reader);
    }
}
```

### 4.3 死锁避免

```cpp
// Fast-DDS 的锁顺序约定

【锁层级】
Level 1: Participant 级别锁
    ↓
Level 2: Endpoint (Writer/Reader) 级别锁
    ↓
Level 3: ReaderProxy/WriterProxy 锁
    ↓
Level 4: HistoryCache 锁

【规则】
1. 必须按层级顺序获取锁
2. 禁止反向获取 (会导致死锁)
3. 同一层级内按地址排序获取

// 示例: 正确的锁顺序
void correct_lock_order() {
    std::lock_guard<std::mutex> lock1(participant->mutex_);
    std::lock_guard<std::mutex> lock2(writer->mutex_);
    std::lock_guard<std::mutex> lock3(reader_proxy->mutex_);
}

// 示例: 错误的锁顺序 (可能导致死锁)
void wrong_lock_order() {
    std::lock_guard<std::mutex> lock1(reader_proxy->mutex_);  // Level 3
    std::lock_guard<std::mutex> lock2(writer->mutex_);         // Level 2  ← 错误！
}
```

---

## 5. 线程配置与调优

### 5.1 线程优先级配置

```cpp
#include <fastdds/rtps/attributes/ThreadSettings.hpp>

// 配置各种线程的优先级
void configure_thread_priorities()
{
    DomainParticipantQos qos;
    
    // Transport 接收线程 - 高优先级 (实时数据)
    qos.transport().user_transports[0]->
        set_thread_config({
            SCHED_FIFO,     // 实时调度策略
            80,             // 优先级 80 (1-99)
            0xFFFFFFFF,     // CPU 亲和性掩码
            ""              // 线程名称
        });
    
    // FlowControllerAsyncPublishMode - 中等优先级
    qos.publish_mode().thread_settings = {
        SCHED_OTHER,    // 普通调度
        0,              // 忽略
        0xFFFFFFFF,
        "AsyncWriter"
    };
    
    // Event 线程 - 低优先级
    qos.event().thread_settings = {
        SCHED_OTHER,
        -10,            // nice 值
        0xFFFFFFFF,
        "EventThread"
    };
}
```

### 5.2 CPU 亲和性配置

```cpp
// 将线程绑定到特定 CPU 核心

void configure_cpu_affinity()
{
    DomainParticipantQos qos;
    
    // 将接收线程绑定到 CPU 0-1
    qos.transport().user_transports[0]->
        set_thread_config({
            SCHED_FIFO,
            80,
            0b00000011,  // CPU 0 和 1
            "RecvThread"
        });
    
    // 将 AsyncWriter 绑定到 CPU 2-3
    qos.publish_mode().thread_settings = {
        SCHED_FIFO,
        70,
        0b00001100,  // CPU 2 和 3
        "AsyncWriter"
    };
    
    // 其他线程使用剩余核心
}
```

### 5.3 线程数量调优

```cpp
// 根据 CPU 核心数调整线程池大小

void tune_thread_pool_size()
{
    unsigned int num_cores = std::thread::hardware_concurrency();
    
    DomainParticipantQos qos;
    
    // Transport 接收线程: 通常与网络接口数相关
    // 不需要太多，避免线程切换开销
    qos.transport().max_num_threads = std::min(4u, num_cores / 2);
    
    // FlowControllerAsyncPublishMode: 全局只有一个，不需要调整
    
    // Event 线程: 每个 Participant 一个
    // 通常不需要调整
    
    // Security 线程: 如果启用，可配置线程池
    qos.security().thread_pool_size = std::min(8u, num_cores);
}
```

---

## 6. 线程问题排查

### 6.1 常见问题

| 问题 | 现象 | 可能原因 | 解决方案 |
|------|------|---------|---------|
| **CPU 100%** | 系统卡顿 | 死循环、忙等待 | 检查定时器间隔、使用条件变量 |
| **内存泄漏** | 内存持续增长 | 线程未清理、队列积压 | 检查线程生命周期、限制队列大小 |
| **数据延迟** | 高延迟 | 线程阻塞、锁竞争 | 减少锁粒度、使用异步模式 |
| **丢包** | 数据丢失 | 接收线程阻塞 | 增加接收缓冲区、使用独立线程池 |
| **连接失败** | 无法发现 | Discovery 线程阻塞 | 检查网络防火墙、Discovery 配置 |

### 6.2 诊断工具

```bash
# 1. 查看 Fast-DDS 线程
ps -T -p $(pgrep your_app) -o pid,tid,comm,pcpu,pmem

# 2. 线程堆栈分析
gdb -p $(pgrep your_app) -ex "thread apply all bt" -ex "quit"

# 3. 实时性能监控
htop -p $(pgrep your_app)

# 4. 锁竞争分析
valgrind --tool=drd ./your_app

# 5. 系统调用跟踪
strace -f -e futex,write,read -p $(pgrep your_app)
```

### 6.3 日志诊断

```cpp
// 启用线程相关日志
void enable_thread_logging()
{
    Log::SetVerbosity(Log::Kind::Info);
    
    // 过滤线程相关日志
    Log::SetCategoryFilter("THREAD");
}

// 典型日志输出
[THREAD] Creating FlowControllerAsyncPublishMode
[THREAD] Starting ResourceEvent thread
[THREAD] Transport receive thread started on CPU 0
[THREAD] Thread priority set to 80 (SCHED_FIFO)
```

---

## 7. 实战：线程Dump分析

### 7.1 获取线程Dump

```cpp
// 在程序中打印线程状态
void print_thread_dump()
{
    std::cout << "=== Fast-DDS Thread Dump ===" << std::endl;
    
    // 1. ResourceEvent 线程
    std::cout << "ResourceEvent Thread:" << std::endl;
    std::cout << "  - Active timers: " << resource_event_.get_timer_count() << std::endl;
    std::cout << "  - Next timeout: " << resource_event_.get_next_timeout() << std::endl;
    
    // 2. FlowControllerAsyncPublishMode
    std::cout << "FlowControllerAsyncPublishMode:" << std::endl;
    std::cout << "  - Registered writers: " << async_writer_thread_.get_writer_count() << std::endl;
    std::cout << "  - Running: " << async_writer_thread_.is_running() << std::endl;
    
    // 3. Transport 线程
    std::cout << "Transport Threads:" << std::endl;
    for (auto& transport : transports_) {
        std::cout << "  - " << transport->get_name() 
                  << ": " << transport->get_thread_count() << " threads" << std::endl;
    }
    
    // 4. 锁状态
    std::cout << "Lock Statistics:" << std::endl;
    std::cout << "  - Mutex contention: " << get_mutex_contention_rate() << std::endl;
}
```

### 7.2 典型问题分析

```
场景: CPU 使用率 100%

线程Dump:
Thread 1 (ResourceEvent): 
  - State: Running
  - Call stack: process_timers → send_heartbeat → ...
  - CPU Time: 95%

分析:
- ResourceEvent 线程占用过高
- 可能是定时器间隔设置过短
- 或者回调函数执行时间过长

解决方案:
1. 增加心跳间隔
2. 将耗时操作移到独立线程
3. 使用多个 ResourceEvent 实例分担负载
```

---

## 总结

```
┌─────────────────────────────────────────────────────────────────┐
│                    Fast-DDS 线程模型总结                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  核心线程                                                        │
│  ├── ResourceEvent: 定时器、心跳、重传 (1个/Participant)        │
│  ├── FlowControllerAsyncPublishMode: 异步数据发送 (全局1个)                  │
│  ├── Transport 线程: 网络接收 (每个通道1个)                     │
│  └── Discovery 线程: 发现协议 (Simple用定时器, Server独立线程)  │
│                                                                  │
│  线程通信                                                        │
│  ├── 条件变量: 线程唤醒 (AsyncWriter, Event)                    │
│  ├── 无锁队列: 数据缓冲 (Transport)                             │
│  └── 回调机制: 事件通知 (Listener)                              │
│                                                                  │
│  线程安全                                                        │
│  ├── 层级锁设计: Participant → Endpoint → Proxy → Cache         │
│  ├── 避免死锁: 按固定顺序获取锁                                 │
│  └── 减少竞争: 细粒度锁、无锁数据结构                           │
│                                                                  │
│  调优建议                                                        │
│  ├── 实时场景: SCHED_FIFO + CPU 亲和性                          │
│  ├── 高吞吐: 增加 Transport 线程、调整缓冲区                     │
│  └── 低延迟: 减少线程切换、避免锁竞争                           │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

*文档版本: 1.0*  
*基于 Fast-DDS 2.14.x 源码分析*
