# DDS 回调机制深度解析

**记录时间**: 2026-03-24  
**学习主题**: Listener/WaitSet 回调机制的底层原理与高级用法  
**前置知识**: 10-Listener-WaitSet.md

---

## 目录

1. [回调机制全景](#1-回调机制全景)
2. [底层实现原理](#2-底层实现原理)
3. [线程安全与性能优化](#3-线程安全与性能优化)
4. [高级回调技巧](#4-高级回调技巧)
5. [WaitSet 底层原理](#5-waitset-底层原理)
6. [回调 vs 轮询选型指南](#6-回调-vs-轮询选型指南)
7. [实战代码模式](#7-实战代码模式)

---

## 1. 回调机制全景

### 1.1 三种异步通知模式对比

```
┌─────────────────────────────────────────────────────────────────┐
│                    数据到达通知机制                              │
├─────────────┬─────────────────┬─────────────────────────────────┤
│   Listener  │    WaitSet      │         轮询 (Polling)          │
│   (回调)    │   (条件等待)    │                                 │
├─────────────┼─────────────────┼─────────────────────────────────┤
│  被动通知    │   主动等待      │        主动查询                  │
│  实时性最高  │   实时性高      │        实时性低                  │
│  简单直接    │   灵活组合      │        实现简单                  │
│  需防阻塞    │   需管理条件    │        CPU 占用高                │
└─────────────┴─────────────────┴─────────────────────────────────┘
```

### 1.2 回调类型一览

| 实体 | 回调类型 | 触发条件 |
|------|---------|---------|
| **DomainParticipant** | on_participant_matched | 发现新 Participant |
| | on_inconsistent_topic | Topic 类型不一致 |
| **Publisher** | on_offered_deadline_missed | Writer 错过 Deadline |
| | on_offered_incompatible_qos | QoS 不兼容 |
| | on_liveliness_lost | Liveliness 丢失 |
| **DataWriter** | on_publication_matched | 匹配到 Reader |
| **Subscriber** | on_requested_deadline_missed | 错过 Deadline |
| | on_requested_incompatible_qos | QoS 不兼容 |
| **DataReader** | on_data_available | **数据到达（最常用）** |
| | on_subscription_matched | 匹配到 Writer |
| | on_sample_rejected | 样本被拒绝 |
| | on_liveliness_changed | Liveliness 变化 |
| | on_sample_lost | 样本丢失 |

---

## 2. 底层实现原理

### 2.1 回调触发流程图

```
网络层接收数据
       ↓
RTPS Reader 处理 DATA 子消息
       ↓
ReaderHistory::add_change() 存入缓存
       ↼────────────────────────┐
       ↓                        │
检查 Listener 是否设置           │
       ↓                        │
StatusMask 允许 DATA_AVAILABLE?  │
       ↓                        │
调用 DataReaderListener::        │
on_data_available()             │
       ↓                        │
用户代码处理数据                  │
       ↓                        │
reader->take/read() 取走数据 ─────┘
```

### 2.2 关键代码路径

#### 接收线程到回调的调用链

```cpp
// 1. 接收线程入口 (UDP/TCP/SHM 传输层)
UDPChannel::receive()
    ↓
// 2. RTPS 消息处理
MessageReceiver::process_data_message()
    ↓
// 3. Reader 处理数据
RTPSReader::process_data()
    ↓
// 4. 存入 History 缓存
ReaderHistory::add_change()
    ↓
// 5. 触发回调
DataReaderImpl::on_data_available()
    ↓
// 6. 调用用户 Listener
listener_->on_data_available(this);
```

**关键理解**：
- 回调在**接收线程**中执行
- 如果回调耗时，会**阻塞后续数据接收**
- 这也是为什么回调中不能做耗时操作

### 2.3 StatusMask 机制

```cpp
// StatusMask 使用位掩码控制回调触发
enum class StatusMask : uint32_t {
    NONE                            = 0x0000,
    DATA_AVAILABLE                  = 0x0001,  // 1 << 0
    DATA_ON_READERS                 = 0x0002,  // 1 << 1
    INCONSISTENT_TOPIC              = 0x0004,  // 1 << 2
    LIVELINESS_CHANGED              = 0x0008,  // 1 << 3
    LIVELINESS_LOST                 = 0x0010,  // 1 << 4
    OFFERED_DEADLINE_MISSED         = 0x0020,  // 1 << 5
    REQUESTED_DEADLINE_MISSED       = 0x0040,  // 1 << 6
    PUBLICATION_MATCHED             = 0x0080,  // 1 << 7
    SUBSCRIPTION_MATCHED            = 0x0100,  // 1 << 8
    SAMPLE_LOST                     = 0x0200,  // 1 << 9
    SAMPLE_REJECTED                 = 0x0400,  // 1 << 10
    ALL                             = 0xFFFF
};
```

**使用示例**：
```cpp
// 只监听数据到达和匹配变化
StatusMask mask = StatusMask::data_available() | 
                  StatusMask::subscription_matched();

DataReader* reader = subscriber->create_datareader(
    topic, qos, &listener, mask);
```

### 2.4 回调与 RTPS 协议的交互

```
Writer 发送 DATA(SN=1)
       ↓
网络传输
       ↓
Reader 接收 DATA(SN=1)
       ↓
存入 ReaderHistory
       ↓
触发 on_data_available() 回调
       ↓
用户代码调用 take() 取走数据
       ↼────────────────────┐
       ↓                    │
Reader 发送 ACKNACK(SN=1) ──┘
       ↓
Writer 收到确认
```

**关键点**：
- 回调触发时，数据**已经在 History 中**
- 用户 take() 后，Reader 才会发送 ACKNACK
- 如果回调中不 take()，数据会一直占着 History 空间

---

## 3. 线程安全与性能优化

### 3.1 回调执行的线程模型

```
接收线程池 (Receive Thread Pool)
├─ Thread 1: UDP Port 7400 ──→ on_data_available()
├─ Thread 2: UDP Port 7401 ──→ on_data_available()
├─ Thread 3: TCP Connection ──→ on_data_available()
└─ Thread 4: SHM Segment ──→ on_data_available()

⚠️ 关键问题：
- 多个线程可能同时执行同一个 Listener 的回调
- 回调和用户业务线程并发执行
- 需要同步机制保护共享数据
```

### 3.2 线程安全方案对比

| 方案 | 优点 | 缺点 | 适用场景 |
|------|------|------|---------|
| **互斥锁** | 简单 | 可能阻塞接收线程 | 简单数据处理 |
| **无锁队列** | 不阻塞 | 实现复杂 | 高吞吐场景 |
| **RingBuffer** | 内存友好 | 固定容量 | 实时系统 |
| **线程池** | 解耦处理 | 延迟增加 | 复杂业务逻辑 |

### 3.3 高性能回调模式

#### 模式1：无锁队列 + 工作线程

```cpp
#include <boost/lockfree/spsc_queue.hpp>

class HighPerformanceListener : public DataReaderListener {
public:
    // 单生产者单消费者无锁队列
    boost::lockfree::spsc_queue<HelloWorld, boost::lockfree::capacity<1024>> queue_;
    std::atomic<bool> has_new_data_{false};
    std::thread worker_thread_;
    std::atomic<bool> running_{true};
    
    HighPerformanceListener() {
        worker_thread_ = std::thread(&HighPerformanceListener::process_loop, this);
    }
    
    ~HighPerformanceListener() {
        running_ = false;
        if (worker_thread_.joinable()) {
            worker_thread_.join();
        }
    }
    
    // 回调线程：只做入队，立即返回
    void on_data_available(DataReader* reader) override {
        HelloWorld msg;
        SampleInfo info;
        
        // 快速读取所有可用数据
        while (reader->take_next_sample(&msg, &info) == ReturnCode_t::RETCODE_OK) {
            if (info.valid_data) {
                // 无锁入队，不会阻塞
                while (!queue_.push(msg)) {
                    // 队列满，短暂自旋等待
                    std::this_thread::yield();
                }
            }
        }
        has_new_data_.store(true, std::memory_order_release);
    }
    
    // 工作线程：处理数据
    void process_loop() {
        while (running_) {
            if (has_new_data_.exchange(false, std::memory_order_acquire)) {
                HelloWorld msg;
                while (queue_.pop(msg)) {
                    // 耗时业务处理
                    process_heavy(msg);
                }
            }
            std::this_thread::sleep_for(std::chrono::microseconds(100));
        }
    }
    
    void process_heavy(const HelloWorld& msg) {
        // 复杂处理逻辑：数据库写入、网络请求、计算等
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
};
```

#### 模式2：线程池 + 任务队列

```cpp
#include <thread_pool.hpp>  // 第三方线程池

class ThreadPoolListener : public DataReaderListener {
public:
    ThreadPoolListener(size_t num_threads) : thread_pool_(num_threads) {}
    
    void on_data_available(DataReader* reader) override {
        // 读取数据
        std::vector<HelloWorld> batch;
        HelloWorld msg;
        SampleInfo info;
        
        while (reader->take_next_sample(&msg, &info) == ReturnCode_t::RETCODE_OK) {
            if (info.valid_data) {
                batch.push_back(msg);
            }
        }
        
        // 提交任务到线程池
        thread_pool_.enqueue([batch = std::move(batch)]() {
            for (const auto& msg : batch) {
                process_message(msg);
            }
        });
    }
    
private:
    ThreadPool thread_pool_;
    
    static void process_message(const HelloWorld& msg) {
        // 业务处理
    }
};
```

#### 模式3：RingBuffer + 忙等待（超低延迟）

```cpp
template<typename T, size_t Capacity>
class RingBuffer {
    static_assert((Capacity & (Capacity - 1)) == 0, "Capacity must be power of 2");
    
    std::array<T, Capacity> buffer_;
    std::atomic<size_t> write_idx_{0};
    std::atomic<size_t> read_idx_{0};
    
public:
    bool push(const T& item) {
        size_t write_idx = write_idx_.load(std::memory_order_relaxed);
        size_t next_write = (write_idx + 1) & (Capacity - 1);
        
        if (next_write == read_idx_.load(std::memory_order_acquire)) {
            return false; // 满
        }
        
        buffer_[write_idx] = item;
        write_idx_.store(next_write, std::memory_order_release);
        return true;
    }
    
    bool pop(T& item) {
        size_t read_idx = read_idx_.load(std::memory_order_relaxed);
        
        if (read_idx == write_idx_.load(std::memory_order_acquire)) {
            return false; // 空
        }
        
        item = buffer_[read_idx];
        read_idx_.store((read_idx + 1) & (Capacity - 1), std::memory_order_release);
        return true;
    }
};

class LowLatencyListener : public DataReaderListener {
    RingBuffer<HelloWorld, 1024> ring_buffer_;
    std::thread worker_;
    std::atomic<bool> running_{true};
    
public:
    LowLatencyListener() {
        // 绑定到独立 CPU 核心，避免上下文切换
        worker_ = std::thread([this]() {
            pin_thread_to_cpu(3); // 绑定到 CPU 核心 3
            process_loop();
        });
    }
    
    void on_data_available(DataReader* reader) override {
        HelloWorld msg;
        SampleInfo info;
        
        while (reader->take_next_sample(&msg, &info) == ReturnCode_t::RETCODE_OK) {
            if (info.valid_data) {
                // 忙等待直到入队成功
                while (!ring_buffer_.push(msg)) {
                    // 队列满，等待消费者
                }
            }
        }
    }
    
    void process_loop() {
        HelloWorld msg;
        while (running_) {
            // 忙等待读取
            while (ring_buffer_.pop(msg)) {
                process_with_minimal_latency(msg);
            }
            // 可选：PAUSE 指令降低功耗
            #if defined(__x86_64__)
            __builtin_ia32_pause();
            #endif
        }
    }
};
```

### 3.4 性能优化建议

| 优化点 | 建议 | 效果 |
|--------|------|------|
| **批量读取** | 一次 take 多个样本 | 减少系统调用 |
| **预分配内存** | 避免回调中动态分配 | 减少延迟抖动 |
| **避免锁** | 使用无锁队列 | 提高并发性能 |
| **CPU 绑定** | 接收线程和处理线程绑定不同核心 | 减少缓存失效 |
| **批处理提交** | 积累一定数量后批量处理 | 提高吞吐量 |

---

## 4. 高级回调技巧

### 4.1 多 Reader 共享同一个 Listener

```cpp
class SharedListener : public DataReaderListener {
public:
    void on_data_available(DataReader* reader) override {
        // 通过 reader 指针区分来源
        if (reader == temperature_reader_) {
            process_temperature(reader);
        } else if (reader == pressure_reader_) {
            process_pressure(reader);
        }
    }
    
    void set_readers(DataReader* temp, DataReader* press) {
        temperature_reader_ = temp;
        pressure_reader_ = press;
    }
    
private:
    DataReader* temperature_reader_ = nullptr;
    DataReader* pressure_reader_ = nullptr;
};

// 使用
SharedListener shared_listener;
DataReader* temp_reader = subscriber->create_datareader(
    temp_topic, qos, &shared_listener, StatusMask::data_available());
DataReader* press_reader = subscriber->create_datareader(
    press_topic, qos, &shared_listener, StatusMask::data_available());

shared_listener.set_readers(temp_reader, press_reader);
```

### 4.2 Lambda 表达式与闭包

```cpp
// 使用 Lambda 创建轻量级 Listener
class LambdaListener : public DataReaderListener {
public:
    using Callback = std::function<void(DataReader*)>;
    
    explicit LambdaListener(Callback cb) : callback_(std::move(cb)) {}
    
    void on_data_available(DataReader* reader) override {
        if (callback_) {
            callback_(reader);
        }
    }
    
private:
    Callback callback_;
};

// 使用 Lambda 快速定义处理逻辑
auto processor = std::make_shared<MsgProcessor>();
LambdaListener listener([processor](DataReader* reader) {
    HelloWorld msg;
    SampleInfo info;
    while (reader->take_next_sample(&msg, &info) == ReturnCode_t::RETCODE_OK) {
        processor->handle(msg);
    }
});
```

### 4.3 状态变化链式处理

```cpp
class LifecycleListener : public DataReaderListener {
public:
    // 匹配状态变化
    void on_subscription_matched(DataReader* reader,
                                  const SubscriptionMatchedStatus& status) override {
        if (status.current_count_change > 0) {
            std::cout << "New writer matched! Total: " << status.current_count << std::endl;
            on_writer_connected();
        } else {
            std::cout << "Writer disconnected! Remaining: " << status.current_count << std::endl;
            on_writer_disconnected();
        }
    }
    
    // 数据可用
    void on_data_available(DataReader* reader) override {
        if (!has_received_data_) {
            has_received_data_ = true;
            on_first_data();
        }
        process_data(reader);
    }
    
    // Liveliness 变化
    void on_liveliness_changed(DataReader* reader,
                                const LivelinessChangedStatus& status) override {
        if (status.alive_count_change > 0) {
            std::cout << "Writer became ALIVE" << std::endl;
        } else if (status.not_alive_count_change > 0) {
            std::cout << "Writer became NOT_ALIVE" << std::endl;
            // 触发故障恢复逻辑
            trigger_recovery();
        }
    }

private:
    bool has_received_data_ = false;
    
    void on_writer_connected() { /* 初始化逻辑 */ }
    void on_writer_disconnected() { /* 清理逻辑 */ }
    void on_first_data() { std::cout << "First data received!" << std::endl; }
    void process_data(DataReader* reader) { /* 常规处理 */ }
    void trigger_recovery() { /* 故障恢复 */ }
};
```

### 4.4 动态启用/禁用回调

```cpp
class ToggleableListener : public DataReaderListener {
public:
    std::atomic<bool> enabled_{true};
    std::atomic<size_t> processed_count_{0};
    
    void on_data_available(DataReader* reader) override {
        if (!enabled_.load(std::memory_order_acquire)) {
            // 禁用状态：只清空数据，不处理
            HelloWorld msg;
            SampleInfo info;
            while (reader->take_next_sample(&msg, &info) == ReturnCode_t::RETCODE_OK) {
                // 丢弃
            }
            return;
        }
        
        // 正常处理
        process(reader);
        processed_count_.fetch_add(1, std::memory_order_relaxed);
    }
    
    void enable() { enabled_.store(true, std::memory_order_release); }
    void disable() { enabled_.store(false, std::memory_order_release); }
    
private:
    void process(DataReader* reader) {
        // 处理逻辑
    }
};

// 使用场景：系统维护时临时禁用处理
ToggleableListener listener;
DataReader* reader = subscriber->create_datareader(topic, qos, &listener);

// 系统维护
listener.disable();  // 丢弃所有数据
std::this_thread::sleep_for(std::chrono::seconds(60));
listener.enable();   // 恢复处理
```

---

## 5. WaitSet 底层原理

### 5.1 WaitSet 架构图

```
┌────────────────────────────────────────────────────────────┐
│                        WaitSet                              │
├────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │ReadCondition│  │QueryCondition│  │GuardCondition│        │
│  │  (数据可用)  │  │ (查询过滤)   │  │  (手动触发)  │        │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘        │
│         │                │                │               │
│         └────────────────┼────────────────┘               │
│                          ↓                                │
│                   ┌──────────────┐                        │
│                   │  Condition   │                        │
│                   │   Variable   │                        │
│                   └──────────────┘                        │
│                          │                                │
│                          ↓                                │
│                   ┌──────────────┐                        │
│                   │   wait()     │ ← 阻塞等待             │
│                   │   wake()     │ ← 条件触发             │
│                   └──────────────┘                        │
└────────────────────────────────────────────────────────────┘
```

### 5.2 Condition 类型详解

#### ReadCondition

```cpp
// ReadCondition 监控 DataReader 的样本状态
// 可以指定 sample_states、view_states、instance_states

// 示例：只监听新数据（NOT_READ）
SampleStateMask sample_states = SampleStateMask::not_read();
ViewStateMask view_states = ViewStateMask::any();
InstanceStateMask instance_states = InstanceStateMask::any();

ReadCondition* read_condition = reader->create_readcondition(
    sample_states, view_states, instance_states);

waitset.attach_condition(read_condition);
```

**状态说明**：

| 状态类型 | 值 | 含义 |
|---------|-----|------|
| **SampleState** | READ | 已读取过的样本 |
| | NOT_READ | 未读取的新样本 |
| **ViewState** | NEW | 新实例（第一次出现） |
| | NOT_NEW | 已有实例的新样本 |
| **InstanceState** | ALIVE | 实例活跃 |
| | NOT_ALIVE_DISPOSED | 实例被显式删除 |
| | NOT_ALIVE_NO_WRITERS | 没有 Writer 写入该实例 |

#### QueryCondition

```cpp
// QueryCondition = ReadCondition + 内容过滤
// 使用 SQL-like 语法过滤数据

// 只接收 id > 100 且 status == "active" 的数据
std::string query = "id > 100 AND status = 'active'";

QueryCondition* query_condition = reader->create_querycondition(
    SampleStateMask::not_read(),
    ViewStateMask::any(),
    InstanceStateMask::any(),
    query,
    {}  // 参数（如果有）
);

waitset.attach_condition(query_condition);
```

#### GuardCondition

```cpp
// GuardCondition 用于外部事件触发
// 比如：用户输入、信号、其他线程通知

GuardCondition* guard_condition = participant->create_guardcondition();
waitset.attach_condition(guard_condition);

// 另一个线程触发
void signal_shutdown() {
    guard_condition->set_trigger_value(true);  // 触发 WaitSet
}
```

### 5.3 WaitSet 使用模式

#### 模式1：单条件等待

```cpp
// 简单场景：只等待数据
WaitSet waitset;
ReadCondition* condition = reader->create_readcondition(
    SampleStateMask::not_read(),
    ViewStateMask::any(),
    InstanceStateMask::any());

waitset.attach_condition(condition);

while (running) {
    ConditionSeq active_conditions;
    Duration_t timeout(1, 0);  // 1秒超时
    
    ReturnCode_t ret = waitset.wait(active_conditions, timeout);
    
    if (ret == ReturnCode_t::RETCODE_OK) {
        // 条件触发，处理数据
        HelloWorld msg;
        SampleInfo info;
        while (reader->take(msg, info) == ReturnCode_t::RETCODE_OK) {
            process(msg);
        }
    } else if (ret == ReturnCode_t::RETCODE_TIMEOUT) {
        // 超时，可以做心跳检查等
        do_heartbeat();
    }
}
```

#### 模式2：多条件组合等待

```cpp
// 同时监控多个 Reader 和退出信号
WaitSet waitset;

// 监控温度 Reader
ReadCondition* temp_condition = temp_reader->create_readcondition(
    SampleStateMask::not_read(), ViewStateMask::any(), InstanceStateMask::any());
waitset.attach_condition(temp_condition);

// 监控压力 Reader
ReadCondition* press_condition = press_reader->create_readcondition(
    SampleStateMask::not_read(), ViewStateMask::any(), InstanceStateMask::any());
waitset.attach_condition(press_condition);

// 退出信号
GuardCondition* shutdown_condition = participant->create_guardcondition();
waitset.attach_condition(shutdown_condition);

// 处理循环
while (true) {
    ConditionSeq active;
    waitset.wait(active, Duration_t::infinite());
    
    for (auto* cond : active) {
        if (cond == temp_condition) {
            process_temperature(temp_reader);
        } else if (cond == press_condition) {
            process_pressure(press_reader);
        } else if (cond == shutdown_condition) {
            std::cout << "Shutdown signal received" << std::endl;
            return;
        }
    }
}
```

#### 模式3：超时处理模式

```cpp
class TimeoutHandler {
    WaitSet waitset_;
    DataReader* reader_;
    std::chrono::steady_clock::time_point last_data_time_;
    const std::chrono::seconds timeout_threshold_{5};
    
public:
    void run() {
        ReadCondition* condition = reader_->create_readcondition(
            SampleStateMask::not_read(),
            ViewStateMask::any(),
            InstanceStateMask::alive());
        waitset_.attach_condition(condition);
        
        last_data_time_ = std::chrono::steady_clock::now();
        
        while (true) {
            ConditionSeq active;
            Duration_t timeout(1, 0);  // 1秒检查一次
            
            ReturnCode_t ret = waitset_.wait(active, timeout);
            
            if (ret == ReturnCode_t::RETCODE_OK) {
                // 收到数据
                process_data();
                last_data_time_ = std::chrono::steady_clock::now();
            } else {
                // 超时，检查是否太久没收到数据
                auto elapsed = std::chrono::steady_clock::now() - last_data_time_;
                if (elapsed > timeout_threshold_) {
                    handle_data_timeout();
                }
            }
        }
    }
    
    void handle_data_timeout() {
        std::cerr << "WARNING: No data received for 5 seconds!" << std::endl;
        // 触发告警、重新初始化等
    }
};
```

---

## 6. 回调 vs 轮询选型指南

### 6.1 决策树

```
是否需要实时响应？
├── 是 → 实时性要求高吗？
│       ├── 极高（<1ms）→ Listener + 无锁队列
│       ├── 高（<10ms）→ Listener + 线程池
│       └── 中等 → WaitSet
└── 否 → 数据频率高吗？
        ├── 高 → WaitSet 批量处理
        └── 低 → 简单轮询
```

### 6.2 场景对比表

| 场景 | 推荐方案 | 理由 |
|------|---------|------|
| **高频交易** | Listener + RingBuffer | 最低延迟，忙等待 |
| **工业控制** | Listener + 实时线程 | 确定性响应时间 |
| **视频流** | WaitSet + 批量 | 帧率可控，避免过载 |
| **传感器监控** | WaitSet + 超时 | 检测离线，容错性好 |
| **日志收集** | 简单轮询 | 实现简单，不要求实时 |
| **RPC 服务** | Listener + 线程池 | 并发处理多个请求 |
| **状态同步** | Listener | 及时反映远程变化 |
| **批量导入** | 轮询 + 批量 | 吞吐量优先 |

### 6.3 混合模式

```cpp
// 结合 Listener 和 WaitSet 的优点
// 主路径用 Listener，备用路径用 WaitSet 监控

class HybridReceiver {
    DataReader* reader_;
    std::atomic<bool> using_listener_{true};
    WaitSet backup_waitset_;
    
    // 主 Listener：正常数据处理
    class MainListener : public DataReaderListener {
        HybridReceiver* parent_;
    public:
        void on_data_available(DataReader* reader) override {
            if (!parent_->using_listener_.load()) {
                return;  // 降级模式，不处理
            }
            
            // 快速处理
            if (!parent_->process_batch(reader)) {
                // 处理不过来，切换到 WaitSet 模式
                parent_->degrade_to_waitset();
            }
        }
    };
    
public:
    void degrade_to_waitset() {
        using_listener_.store(false);
        
        // 启动 WaitSet 线程做兜底
        std::thread([this]() {
            backup_processing_loop();
        }).detach();
    }
    
    void backup_processing_loop() {
        ReadCondition* condition = reader_->create_readcondition(
            SampleStateMask::not_read(),
            ViewStateMask::any(),
            InstanceStateMask::any());
        backup_waitset_.attach_condition(condition);
        
        while (!using_listener_.load()) {
            ConditionSeq active;
            backup_waitset_.wait(active, Duration_t(1, 0));
            
            for (auto* cond : active) {
                process_batch(reader_);
            }
        }
    }
    
    bool process_batch(DataReader* reader) {
        // 批量处理，返回是否成功
        return true;
    }
};
```

---

## 7. 实战代码模式

### 7.1 完整的可靠接收模式

```cpp
#include <fastdds/dds/domain/DomainParticipantFactory.hpp>
#include <fastdds/dds/domain/DomainParticipant.hpp>
#include <fastdds/dds/subscriber/Subscriber.hpp>
#include <fastdds/dds/subscriber/DataReader.hpp>
#include <fastdds/dds/subscriber/DataReaderListener.hpp>
#include <fastdds/dds/subscriber/qos/DataReaderQos.hpp>

using namespace eprosima::fastdds::dds;

class ReliableDataReceiver : public DataReaderListener {
public:
    struct Config {
        size_t queue_capacity = 10000;
        size_t worker_threads = 4;
        std::chrono::milliseconds max_latency{100};
        bool enable_backpressure = true;
    };
    
    explicit ReliableDataReceiver(const Config& config);
    ~ReliableDataReceiver();
    
    // 初始化
    bool initialize(DomainId_t domain_id, const std::string& topic_name);
    
    // 启动/停止
    void start();
    void stop();
    
    // 统计信息
    struct Stats {
        std::atomic<uint64_t> received_count{0};
        std::atomic<uint64_t> dropped_count{0};
        std::atomic<uint64_t> error_count{0};
        std::atomic<double> avg_latency_ms{0.0};
    };
    const Stats& stats() const { return stats_; }

private:
    // DataReaderListener 回调
    void on_data_available(DataReader* reader) override;
    void on_subscription_matched(DataReader* reader,
                                  const SubscriptionMatchedStatus& status) override;
    void on_sample_rejected(DataReader* reader,
                            const SampleRejectedStatus& status) override;
    void on_liveliness_changed(DataReader* reader,
                               const LivelinessChangedStatus& status) override;
    
    // 内部处理
    void worker_loop();
    void process_message(const HelloWorld& msg);
    void handle_backpressure();
    
    Config config_;
    Stats stats_;
    
    // DDS 实体
    DomainParticipant* participant_ = nullptr;
    Subscriber* subscriber_ = nullptr;
    Topic* topic_ = nullptr;
    DataReader* reader_ = nullptr;
    TypeSupport type_support_;
    
    // 并发控制
    boost::lockfree::spsc_queue<HelloWorld> queue_;
    std::vector<std::thread> workers_;
    std::atomic<bool> running_{false};
    std::mutex cv_mutex_;
    std::condition_variable cv_;
};

// 实现...
```

### 7.2 快速启动模板

```cpp
// header: dds_receiver.hpp
#pragma once

#include <fastdds/dds/dds.hpp>
#include <functional>

namespace dds {

using MessageCallback = std::function<void(const HelloWorld&, const SampleInfo&)>;

class SimpleReceiver {
public:
    SimpleReceiver(DomainId_t domain, const std::string& topic, MessageCallback cb);
    ~SimpleReceiver();
    
    bool start();
    void stop();
    
private:
    class Listener : public DataReaderListener {
    public:
        MessageCallback callback;
        void on_data_available(DataReader* reader) override;
    };
    
    // ... DDS 实体
    Listener listener_;
};

} // namespace dds

// usage: main.cpp
#include "dds_receiver.hpp"

int main() {
    dds::SimpleReceiver receiver(0, "HelloWorldTopic", 
        [](const HelloWorld& msg, const SampleInfo& info) {
            std::cout << "Received: " << msg.message() 
                      << " at T=" << info.reception_timestamp.seconds << std::endl;
        });
    
    if (!receiver.start()) {
        std::cerr << "Failed to start receiver" << std::endl;
        return 1;
    }
    
    std::this_thread::sleep_for(std::chrono::seconds(60));
    return 0;
}
```

---

## 8. 学习检查清单

- [ ] 理解回调触发的完整流程
- [ ] 掌握 StatusMask 的使用
- [ ] 学会设计线程安全的回调处理
- [ ] 理解 WaitSet 的条件变量机制
- [ ] 能够根据场景选择合适的通知模式
- [ ] 掌握高性能回调的实现技巧

---

## 9. 下一步

完成回调机制学习后，可以继续：
- **性能测试**：对比 Listener/WaitSet/轮询的性能差异
- **实际项目**：将回调模式应用到具体业务场景
- **源码阅读**：深入 Fast-DDS 的回调实现源码

---

*记录时间: 2026-03-24*  
*模块: DDS 回调机制深度解析*  
*关联笔记: 10-Listener-WaitSet.md*
