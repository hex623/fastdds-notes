# Fast-DDS 定时器系统详解

**创建时间**: 2026-03-13  
**源码版本**: Fast-DDS 3.5.0  
**作者**: 旭旭助手

---

## 目录

1. [定时器系统概述](#一定时器系统概述)
2. [核心组件架构](#二核心组件架构)
3. [定时器类型与应用场景](#三定时器类型与应用场景)
4. [源码分析](#四源码分析)
5. [线程模型](#五线程模型)
6. [实战配置](#六实战配置)
7. [性能优化与常见问题](#七性能优化与常见问题)

---

## 一、定时器系统概述

### 1.1 为什么 DDS 需要定时器？

DDS/RTPS 协议是**时间敏感**的分布式系统，需要精确的时间管理：

| 功能 | 定时器作用 | 超时后果 |
|------|-----------|---------|
| **心跳保活** | 检测远端节点是否存活 | 误判节点离线 |
| **发现协议** | 周期性宣告 Participant/Endpoint | 发现延迟或失败 |
| **可靠传输** | 重传超时检测 | 数据丢失 |
| **租约管理** | 检测资源过期 | 资源泄漏 |
| **QoS 监控** | Deadline/Liveliness 检测 | 服务质量下降 |

### 1.2 定时器架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                    Application Layer                             │
│         (用户通过 Listener/WaitSet 感知超时事件)                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     DDS Layer (超时检测)                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │   Deadline   │  │  Liveliness  │  │  Lifespan    │          │
│  │   Monitor    │  │   Monitor    │  │   Monitor    │          │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │
│         │                 │                 │                   │
└─────────┼─────────────────┼─────────────────┼───────────────────┘
          │                 │                 │
          ▼                 ▼                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                     RTPS Layer (协议定时器)                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │  SPDP Timer  │  │  SEDP Timer  │  │  Heartbeat   │          │
│  │ (发现宣告)    │  │ (端点发现)    │  │   Timer      │          │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │
│         │                 │                 │                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │   NACK       │  │  KeepAlive   │  │  Lease       │          │
│  │  Response    │  │   Timer      │  │  Duration    │          │
│  │  (重传响应)   │  │ (连接保活)    │  │   Timer      │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Timer Service (定时器服务层)                    │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │              TimedEventImpl (定时事件实现)                  │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │  │
│  │  │   Timer 1    │  │   Timer 2    │  │   Timer N    │    │  │
│  │  │ (截止时间)    │  │ (截止时间)    │  │ (截止时间)    │    │  │
│  │  │   ↓↓↓        │  │   ↓↓↓        │  │   ↓↓↓        │    │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘    │  │
│  │                                                           │  │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │  最小堆 / 优先队列 (按截止时间排序)                   │  │  │
│  │  │  根节点 = 最近到期的定时器                           │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                  │
│                              ▼                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │            EventLoop / TimerThread (定时器线程)             │  │
│  │  - 单线程按序执行回调                                       │  │
│  │  - 支持高精度定时 (us 级)                                  │  │
│  │  - 线程安全的事件队列                                      │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 二、核心组件架构

### 2.1 类层次结构

```
┌──────────────────────────────────────────────────────────────┐
│                    TimedEvent (抽象基类)                      │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  virtual void event(EventCode code, const char* msg)   │  │
│  │  // 定时器到期时调用的回调函数                          │  │
│  └────────────────────────────────────────────────────────┘  │
└───────────────────────────┬──────────────────────────────────┘
                            │ 继承
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐
│  SPDPEvent    │  │  SEDPEvent    │  │ HeartbeatEvent│
│ (发现宣告)     │  │ (端点发现)     │  │ (心跳检测)     │
└───────────────┘  └───────────────┘  └───────────────┘
        │                   │                   │
        │  ┌──────────────┐ │  ┌──────────────┐ │  ┌──────────────┐
        │  │   NACK       │ │  │ DeadlineMissed│ │  │ LivelinessLost│
        │  │  Response    │ │  │   Event      │ │  │   Event      │
        │  │  Event       │ │  └──────────────┘ │  └──────────────┘
        │  └──────────────┘ │                   │
        │                   │                   │
        └───────────────────┴───────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────┐
│                   TimedEventImpl (实现类)                     │
│  - 管理定时器状态 (PENDING, RUNNING, CANCELLED)              │
│  - 与 EventLoop 交互                                         │
│  - 支持一次性/周期性定时器                                    │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 核心类详解

#### 2.2.1 TimedEvent - 定时事件基类

**头文件**: `include/fastdds/rtps/resources/TimedEvent.h`

```cpp
class TimedEvent {
public:
    // 定时器状态枚举
    enum class State {
        INACTIVE,    // 未激活
        PENDING,     // 等待执行
        RUNNING,     // 正在执行回调
        CANCELLED    // 已取消
    };
    
    // 事件代码（传递给回调的原因）
    enum class EventCode {
        SUCCESS,     // 正常到期
        CANCELLED,   // 被取消
        ERROR        // 错误
    };
    
    // 构造函数
    TimedEvent(
        asio::io_service& io_service,           // ASIO IO 服务
        std::function<void()> callback,         // 回调函数
        std::chrono::milliseconds interval,     // 定时间隔
        bool auto_restart = false               // 是否周期性重复
    );
    
    // 启动定时器
    void restart_timer();
    
    // 取消定时器
    void cancel_timer();
    
    // 更新间隔
    void update_interval(std::chrono::milliseconds interval);
    
    // 获取状态
    State get_state() const;
    
protected:
    std::unique_ptr<TimedEventImpl> impl_;  // Pimpl 实现
};
```

#### 2.2.2 TimedEventImpl - 实现细节

```cpp
class TimedEventImpl {
public:
    // 核心属性
    std::chrono::steady_clock::time_point next_trigger_time_;  // 下次触发时间
    std::chrono::milliseconds interval_;                       // 定时间隔
    bool auto_restart_;                                         // 周期性标志
    std::atomic<State> state_;                                  // 当前状态
    
    // ASIO 定时器对象
    asio::steady_timer timer_;
    
    // 回调函数
    std::function<void()> callback_;
    
    // 互斥锁（保护状态变更）
    std::mutex mutex_;
    
    // 核心方法
    void trigger();              // 触发回调
    void reschedule();           // 重新调度（周期性）
    void cancel();               // 取消
};
```

#### 2.2.3 ResourceEvent - 资源事件管理器

**头文件**: `include/fastdds/rtps/resources/ResourceEvent.h`

```cpp
class ResourceEvent {
public:
    // 单例模式（每个 DomainParticipant 一个实例）
    static ResourceEvent& get_instance();
    
    // 初始化事件循环
    void init_thread();
    
    // 停止事件循环
    void stop_thread();
    
    // 注册定时事件
    void register_timer(TimedEventImpl* event);
    
    // 注销定时事件
    void unregister_timer(TimedEventImpl* event);
    
    // 通知有新事件（唤醒事件循环）
    void notify();
    
private:
    // ASIO IO 上下文
    asio::io_context io_context_;
    
    // 工作守卫（保持 io_context 运行）
    std::unique_ptr<asio::io_context::work> work_guard_;
    
    // 事件循环线程
    std::thread event_thread_;
    
    // 定时器集合（按截止时间排序）
    std::set<TimedEventImpl*, TimerComparator> timers_;
    
    // 互斥锁
    std::mutex mutex_;
    
    // 条件变量（用于唤醒）
    std::condition_variable cv_;
};
```

---

## 三、定时器类型与应用场景

### 3.1 DDS 层定时器

#### 3.1.1 Deadline Missed 检测

```cpp
// 场景：检测数据是否在约定时间内更新
DataReaderQos qos;
qos.deadline().period = Duration_t(1, 0);  // 1秒截止期限

// 内部定时器每 1 秒检查一次
// 如果 1 秒内未收到新数据 → 触发 on_requested_deadline_missed()
```

**定时器配置**：
- **周期**: `deadline.period`
- **回调**: `DeadlineMissedListener::on_requested_deadline_missed()`
- **精度**: 毫秒级

#### 3.1.2 Liveliness 检测

```cpp
// 场景：检测 Writer 是否存活
DataWriterQos qos;
qos.liveliness().kind = AUTOMATIC_LIVELINESS_QOS;
qos.liveliness().lease_duration = Duration_t(10, 0);  // 10秒租约

// 内部定时器：
// - Writer 端：每 10 秒发送自动心跳
// - Reader 端：每 10 秒检查是否收到心跳
```

**定时器配置**：
- **周期**: `liveliness.lease_duration`
- **回调**: `LivelinessChangedListener::on_liveliness_changed()`

#### 3.1.3 Lifespan 过期

```cpp
// 场景：数据有效期管理
DataWriterQos qos;
qos.lifespan().duration = Duration_t(5, 0);  // 数据5秒后过期

// 内部定时器：样本写入时启动，5秒后标记为过期
```

### 3.2 RTPS 层定时器

#### 3.2.1 SPDP 发现宣告定时器

```cpp
// 源码位置: src/cpp/rtps/builtin/discovery/participant/PDPSimple.cpp

// 配置参数
const Duration_t SPDP_RESEND_PERIOD = {3, 0};      // 每 3 秒重新宣告
const Duration_t SPDP_LEASE_DURATION = {20, 0};    // 20 秒租约

// 定时器行为
class SPDPResendEvent : public TimedEvent {
    void event(EventCode code, const char* msg) override {
        // 1. 发送 SPDP 宣告 (DATA(p) 消息)
        send_participant_discovery_data();
        
        // 2. 重新调度（周期性）
        if (auto_restart_) {
            reschedule();
        }
    }
};
```

**关键参数**：
| 参数 | 默认值 | 说明 |
|------|-------|------|
| `resend_period` | 3s | 宣告间隔 |
| `lease_duration` | 20s | 租约有效期 |

#### 3.2.2 SEDP 端点发现定时器

```cpp
// 与 SPDP 类似，但针对 DataWriter/DataReader
const Duration_t SEDP_RESEND_PERIOD = {3, 0};

class SEDPResendEvent : public TimedEvent {
    void event(EventCode code, const char* msg) override {
        // 1. 宣告本地 DataWriter/DataReader
        announce_local_endpoints();
        
        // 2. 检查匹配状态
        check_endpoint_matches();
    }
};
```

#### 3.2.3 Heartbeat 定时器

```cpp
// 源码位置: src/cpp/rtps/writer/StatefulWriter.cpp

// 配置参数
const Duration_t HEARTBEAT_PERIOD = {10, 0};  // 每 10 秒发送心跳
const Duration_t NACK_RESP_DELAY = {0, 100000000};  // 100ms NACK 响应延迟

// 两种 Heartbeat 定时器
class HeartbeatEvent : public TimedEvent {
public:
    enum class Mode {
        PERIODIC,     // 周期性心跳（保活+触发确认）
        ON_DEMAND     // 按需心跳（发送数据后立即发送）
    };
    
    void event(EventCode code, const char* msg) override {
        // 1. 构建 HEARTBEAT 子消息
        HeartbeatSubmessage hb;
        hb.first_sn = first_unacked_seq_;
        hb.last_sn = last_sent_seq_;
        
        // 2. 发送给所有匹配的 Reader
        for (auto& reader : matched_readers_) {
            send_heartbeat_to_reader(reader, hb);
        }
    }
};
```

#### 3.2.4 NACK 响应延迟定时器

```cpp
// 目的：批量处理 NACK，减少重传次数

class NackResponseDelay : public TimedEvent {
    void event(EventCode code, const char* msg) override {
        // 收集期间收到的所有 NACK
        std::vector<SequenceNumber_t> missing_seqs;
        collect_nack_requests(missing_seqs);
        
        // 批量重传
        for (auto seq : missing_seqs) {
            CacheChange_t* change = find_change_by_seq(seq);
            if (change) {
                resend_change(change);
            }
        }
    }
};

// 配置：100ms 延迟（FASTDDS 默认）
// 优势：多个 Reader 同时丢包时，合并重传
```

#### 3.2.5 可靠重传定时器

```cpp
// 目的：未收到 ACK 时自动重传

class ResendDataEvent : public TimedEvent {
    void event(EventCode code, const char* msg) override {
        for (auto& reader : matched_readers_) {
            // 检查每个 Reader 的未确认列表
            for (auto seq : reader.outstanding_changes_) {
                auto change = find_change(seq);
                
                // 检查是否超时（指数退避）
                if (now() - change->send_time > calculate_backoff(retry_count_)) {
                    resend_change(change);
                    change->retry_count_++;
                }
            }
        }
    }
};

// 指数退避算法
std::chrono::milliseconds calculate_backoff(int retry_count) {
    return std::chrono::milliseconds(100 * (1 << retry_count));  // 100ms, 200ms, 400ms...
}
```

---

## 四、源码分析

### 4.1 定时器调度流程

```
┌─────────────────────────────────────────────────────────────────┐
│                      定时器调度流程                              │
└─────────────────────────────────────────────────────────────────┘

1. 用户创建定时器
   ├─ TimedEvent event(io_service, callback, 1000ms, true);
   │
   ▼
2. 注册到 ResourceEvent
   ├─ ResourceEvent::register_timer(impl);
   │  ├─ 插入 timers_ 集合（按截止时间排序）
   │  └─ notify() 唤醒事件循环
   │
   ▼
3. 事件循环处理
   ├─ ResourceEvent::event_loop()
   │  ├─ 获取最近到期的定时器（timers_.begin()）
   │  ├─ 计算等待时间：wait_time = next_deadline - now()
   │  ├─ cv_.wait_for(wait_time) 或处理到期事件
   │  └─ 触发回调：impl->trigger()
   │
   ▼
4. 回调执行
   ├─ 用户回调函数执行
   │
   ▼
5. 重新调度（周期性）
   ├─ if (auto_restart_) {
   │      impl->next_trigger_time_ = now() + interval_;
   │      timers_.insert(impl);
   │   }
```

### 4.2 关键源码片段

#### 4.2.1 事件循环核心

```cpp
// src/cpp/rtps/resources/ResourceEvent.cpp

void ResourceEvent::event_loop() {
    while (running_) {
        std::unique_lock<std::mutex> lock(mutex_);
        
        if (timers_.empty()) {
            // 没有定时器，等待通知
            cv_.wait(lock);
        } else {
            // 获取最近到期的定时器
            auto* next_timer = *timers_.begin();
            auto now = std::chrono::steady_clock::now();
            
            if (next_timer->next_trigger_time_ <= now) {
                // 定时器到期，移除并触发
                timers_.erase(timers_.begin());
                lock.unlock();
                
                next_timer->state_ = TimedEvent::State::RUNNING;
                next_timer->trigger();
                
                // 如果是周期性，重新调度
                if (next_timer->auto_restart_) {
                    next_timer->next_trigger_time_ = now + next_timer->interval_;
                    lock.lock();
                    timers_.insert(next_timer);
                    lock.unlock();
                }
            } else {
                // 等待到下一个定时器到期
                cv_.wait_until(lock, next_timer->next_trigger_time_);
            }
        }
    }
}
```

#### 4.2.2 ASIO 定时器实现

```cpp
// 使用 ASIO 的 steady_timer 实现高精度定时

class TimedEventImpl {
public:
    void start_timer() {
        timer_.expires_after(interval_);
        timer_.async_wait([this](const asio::error_code& ec) {
            if (!ec && state_ == State::PENDING) {
                trigger();
                if (auto_restart_) {
                    reschedule();
                }
            }
        });
    }
    
    void cancel() {
        std::lock_guard<std::mutex> lock(mutex_);
        state_ = State::CANCELLED;
        timer_.cancel();
    }
    
private:
    asio::steady_timer timer_;
};
```

### 4.3 定时器精度分析

```
┌──────────────────────────────────────────────────────────────┐
│                      定时器精度因素                           │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  1. 系统时钟精度                                             │
│     - std::chrono::steady_clock: 纳秒级精度（现代系统）       │
│     - 实际精度取决于 OS 调度（Linux ~1ms, Windows ~15ms）     │
│                                                              │
│  2. 线程调度延迟                                             │
│     - 事件循环线程可能被其他线程抢占                          │
│     - 使用高优先级线程可减少延迟                              │
│                                                              │
│  3. 回调执行时间                                             │
│     - 如果回调执行时间长，会延迟后续定时器                    │
│     - 建议：回调中只做轻量级操作，重活另起线程                │
│                                                              │
│  4. ASIO 定时器开销                                          │
│     - epoll/kqueue/IOCP 系统调用开销                          │
│     - 通常 < 1ms                                              │
│                                                              │
│  典型精度：                                                   │
│  - Linux (实时内核): ~100μs                                  │
│  - Linux (普通内核): ~1-10ms                                 │
│  - Windows: ~15ms                                            │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## 五、线程模型

### 5.1 定时器线程配置

```cpp
// 默认配置：单线程事件循环
// 可通过以下方式优化：

DomainParticipantQos qos;

// 1. 启用异步发布（使用独立线程发送）
qos.publish_mode().kind = ASYNCHRONOUS_PUBLISH_MODE;

// 2. 配置接收线程数
qos.transport().listen_socket_buffer_size = 65536;

// 3. 设置线程优先级（平台相关）
// Linux: 使用 realtime 优先级
// Windows: 使用 THREAD_PRIORITY_TIME_CRITICAL
```

### 5.2 线程安全性

```cpp
// TimedEvent 是线程安全的

// 场景 1: 从回调中重启定时器（安全）
class MyEvent : public TimedEvent {
    void event(EventCode code, const char* msg) override {
        // 做一些工作...
        
        // 安全：重启自己
        restart_timer();
    }
};

// 场景 2: 从其他线程取消定时器（安全）
void other_thread_function(TimedEvent& event) {
    // 安全：从任意线程取消
    event.cancel_timer();
}

// 实现机制：内部使用 mutex_ 保护状态变更
```

### 5.3 避免回调阻塞

```cpp
// ❌ 错误：回调中执行耗时操作
class BadEvent : public TimedEvent {
    void event(EventCode code, const char* msg) override {
        // 阻塞事件循环！
        heavy_computation();  // 耗时 500ms
        write_to_disk();      // 耗时 200ms
    }
};

// ✅ 正确：异步处理
class GoodEvent : public TimedEvent {
    void event(EventCode code, const char* msg) override {
        // 提交到线程池异步执行
        thread_pool_.submit([]() {
            heavy_computation();
            write_to_disk();
        });
    }
};
```

---

## 六、实战配置

### 6.1 自定义定时器示例

```cpp
#include <fastdds/rtps/resources/TimedEvent.h>
#include <fastdds/rtps/resources/ResourceEvent.h>

using namespace eprosima::fastdds::rtps;

// 自定义定时器：定期监控网络质量
class NetworkMonitorEvent : public TimedEvent {
public:
    NetworkMonitorEvent(asio::io_service& io)
        : TimedEvent(io, 
                     [this]() { check_network_quality(); },
                     std::chrono::seconds(5),  // 每 5 秒检查
                     true)                     // 周期性
    {}
    
private:
    void check_network_quality() {
        // 1. 统计丢包率
        float loss_rate = calculate_packet_loss();
        
        // 2. 统计延迟
        float avg_latency = calculate_average_latency();
        
        // 3. 如果质量差，调整 QoS
        if (loss_rate > 0.05) {  // 丢包率 > 5%
            adjust_reliability_qos(HIGH_RELIABILITY);
        }
        
        std::cout << "Network: loss=" << loss_rate 
                  << ", latency=" << avg_latency << "ms" << std::endl;
    }
};

// 使用
int main() {
    asio::io_context io_context;
    
    NetworkMonitorEvent monitor(io_context);
    monitor.restart_timer();
    
    // 启动事件循环
    std::thread event_thread([&io_context]() {
        io_context.run();
    });
    
    event_thread.join();
    return 0;
}
```

### 6.2 动态调整定时器间隔

```cpp
class AdaptiveHeartbeatEvent : public TimedEvent {
public:
    void event(EventCode code, const char* msg) override {
        send_heartbeat();
        
        // 根据网络状况动态调整心跳间隔
        if (network_congested_) {
            // 网络拥塞：降低心跳频率，减少开销
            update_interval(std::chrono::seconds(30));
        } else {
            // 网络良好：提高心跳频率，更快检测故障
            update_interval(std::chrono::seconds(3));
        }
        
        // 重新启动（新间隔）
        restart_timer();
    }
};
```

### 6.3 定时器与 QoS 联动

```cpp
// 配置 Deadline 监控
DataReaderQos reader_qos;
reader_qos.deadline().period = Duration_t(1, 0);  // 1秒

class DeadlineListener : public DataReaderListener {
public:
    void on_requested_deadline_missed(
        DataReader* reader,
        const RequestedDeadlineMissedStatus& status) override {
        
        std::cout << "Deadline missed! Total: " << status.total_count << std::endl;
        
        // 启动故障恢复定时器
        recovery_timer_.restart_timer();
    }
    
private:
    TimedEvent recovery_timer_{io_service_, [this]() {
        attempt_recovery();
    }, std::chrono::seconds(5), false};  // 一次性
};
```

---

## 七、性能优化与常见问题

### 7.1 定时器性能优化

| 优化项 | 建议 | 效果 |
|--------|------|------|
| **批量定时器** | 合并多个短周期定时器 | 减少线程唤醒次数 |
| **适当周期** | 避免 < 10ms 的高频定时器 | 降低 CPU 占用 |
| **回调精简** | 只做轻量级操作，重活异步化 | 避免阻塞事件循环 |
| **线程优先级** | 使用实时优先级（如需要） | 降低调度延迟 |
| **定时器复用** | 避免频繁创建/销毁 | 减少内存分配 |

### 7.2 常见问题排查

| 问题现象 | 可能原因 | 解决方案 |
|---------|---------|---------|
| **定时器不触发** | 未调用 `restart_timer()` | 检查初始化代码 |
| **触发延迟大** | 回调阻塞事件循环 | 异步化耗时操作 |
| **CPU 占用高** | 定时器周期过短 | 增大间隔或使用批量处理 |
| **内存泄漏** | 未取消周期性定时器 | 析构前调用 `cancel_timer()` |
| **精度不足** | 系统负载高 | 使用实时内核或专用线程 |

### 7.3 调试技巧

```cpp
// 启用定时器调试日志
#define TIMED_EVENT_DEBUG 1

// 打印定时器状态
void print_timer_status(TimedEvent& event) {
    auto state = event.get_state();
    const char* state_str[] = {"INACTIVE", "PENDING", "RUNNING", "CANCELLED"};
    std::cout << "Timer state: " << state_str[static_cast<int>(state)] << std::endl;
}

// 监控事件循环
class InstrumentedResourceEvent : public ResourceEvent {
public:
    void event_loop() override {
        auto start = std::chrono::steady_clock::now();
        ResourceEvent::event_loop();
        auto end = std::chrono::steady_clock::now();
        
        auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(end - start);
        std::cout << "Event loop iteration: " << duration.count() << "ms" << std::endl;
    }
};
```

---

## 八、总结

### 核心要点

1. **分层定时器**：DDS 层（Deadline/Liveliness）+ RTPS 层（SPDP/SEDP/Heartbeat）

2. **实现机制**：基于 ASIO 的 `steady_timer` + 单线程事件循环 + 最小堆调度

3. **精度**：毫秒级（Linux ~1ms，Windows ~15ms），支持微秒级配置

4. **关键定时器**：
   - SPDP: 3s 宣告周期，20s 租约
   - Heartbeat: 10s 周期 + 100ms NACK 延迟
   - 可靠重传：指数退避（100ms → 200ms → 400ms...）

5. **最佳实践**：
   - 回调必须轻量，避免阻塞
   - 周期性定时器记得取消
   - 根据场景调整间隔（网络差时降低频率）

---

*文档版本: 1.0*  
*最后更新: 2026-03-13*  
*关联笔记: 03-Discovery-Mechanism.md, 09-Advanced-Topics.md*
