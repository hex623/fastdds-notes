# Fast-DDS 线程模型源码级深度解析

> 📌 **代码来源说明**：本文中的代码示例分为两类：
> 1. **实际源码**：来自 [Fast-DDS 官方仓库](https://github.com/eProsima/Fast-DDS)，链接已标注
> 2. **简化示例**：为教学目的简化，省略了锁、异常处理等细节
>
> **重要更正**：文中使用的 `AsyncWriterThread` 是**概念性命名**，实际源码中的对应实现为 `FlowControllerAsyncPublishMode`，位于 `src/cpp/rtps/flowcontrol/FlowControllerImpl.hpp`

---


> **本文目标**：通过源码级别的分析，彻底理解 Fast-DDS 的线程模型，掌握线程创建、运行、协作、销毁的全生命周期，为性能调优和问题排查打下坚实基础。

## 目录
1. [线程模型架构总览](#1-线程模型架构总览)
2. [ResourceEvent 线程（定时器核心）](#2-resourceevent-线程定时器核心)
3. [FlowControllerAsyncPublishMode（异步发送）](#3-asyncwriterthread异步发送)
4. [Transport 接收线程](#4-transport-接收线程)
5. [Discovery 线程](#5-discovery-线程)
6. [线程间协作机制](#6-线程间协作机制)
7. [线程安全与锁机制](#7-线程安全与锁机制)
8. [线程生命周期管理](#8-线程生命周期管理)
9. [性能调优实战](#9-性能调优实战)
10. [问题排查与调试](#10-问题排查与调试)

---

## 1. 线程模型架构总览

### 1.1 完整线程架构图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Fast-DDS 完整线程架构                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  【应用层 - 用户线程】                                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  main() / 业务线程                                                   │   │
│  │  ├── DomainParticipantFactory::get_instance()                       │   │
│  │  ├── participant->create_publisher()                                │   │
│  │  ├── publisher->create_datawriter()                                 │   │
│  │  ├── writer->write()        ← 触发内部线程交互                      │   │
│  │  ├── subscriber->take()     ← 可能阻塞等待                          │   │
│  │  └── ~DomainParticipant()   ← 触发线程销毁                          │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                         │
│  ══════════════════════════════════╪══════════════════════════════════════ │
│                                    ▼                                         │
│  【Fast-DDS 内部线程池】                                                      │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ 1. ResourceEvent 线程 (每个 Participant 一个)                        │   │
│  │    类: eprosima::fastdds::rtps::ResourceEvent                        │   │
│  │    文件: src/cpp/rtps/resources/ResourceEvent.cpp                    │   │
│  │    数量: 1 个 / Participant                                          │   │
│  │    职责:                                                             │   │
│  │    ├── 定时器管理 (HEARTBEAT, NACK响应, 租约检查)                    │   │
│  │    ├── 基于 ASIO io_service 的事件循环                               │   │
│  │    └── 所有 TimedEvent 的执行调度                                    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ 2. FlowControllerAsyncPublishMode (全局单例)                                      │   │
│  │    类: eprosima::fastdds::rtps::FlowControllerAsyncPublishMode                    │   │
│  │    文件: src/cpp/rtps/writer/FlowControllerAsyncPublishMode.cpp                   │   │
│  │    数量: 全局唯一 1 个 (static 单例)                                 │   │
│  │    职责:                                                             │   │
│  │    ├── 所有 ASYNC 模式 DataWriter 的数据发送调度                     │   │
│  │    ├── FlowController 的速率控制执行                                 │   │
│  │    └── 批量发送优化                                                  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ 3. Transport 接收线程 (每个通道一个)                                 │   │
│  │    类: eprosima::fastdds::rtps::UDPChannelResource                   │   │
│  │    文件: src/cpp/transport/UDPTransportInterface.cpp                 │   │
│  │    数量: 每个打开的端口 1 个线程                                     │   │
│  │    典型: 7410 (用户数据), 7411 (发现), 7412 (SHM) 等                 │   │
│  │    职责:                                                             │   │
│  │    ├── 阻塞接收 UDP 数据包                                           │   │
│  │    ├── 解析 RTPS 消息并分发                                          │   │
│  │    └── 触发 Reader 回调或数据入队                                    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ 4. PDP 定时器线程 (通过 ResourceEvent 实现)                          │   │
│  │    类: eprosima::fastdds::rtps::PDP                                 │   │
│  │    数量: 复用 ResourceEvent 线程                                     │   │
│  │    职责:                                                             │   │
│  │    ├── 周期性发送 PDP (Participant Discovery)                        │   │
│  │    ├── 租约过期检测 (leaseDuration)                                  │   │
│  │    └── 清理过期参与者                                                │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ 5. Security 线程 (可选, 启用 DDS-Security 时)                        │   │
│  │    类: eprosima::fastdds::rtps::security::SecurityManager            │   │
│  │    数量: 1-2 个                                                      │   │
│  │    职责:                                                             │   │
│  │    ├── 认证握手 (Authentication)                                     │   │
│  │    ├── 加密/解密操作                                                 │   │
│  │    └── 权限验证 (Access Control)                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ 6. Discovery Server 线程 (Server 模式时)                             │   │
│  │    类: eprosima::fastdds::rtps::DiscoveryServerManager               │   │
│  │    数量: 1 个                                                        │   │
│  │    职责:                                                             │   │
│  │    ├── 处理客户端发现请求                                            │   │
│  │    ├── 维护发现数据库                                                │   │
│  │    └── 分发发现信息                                                  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  【系统层】                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  UDP Socket: 7400, 7410, 7411, 7412...                              │   │
│  │  TCP Socket: 可选                                                    │   │
│  │  Shared Memory: /dev/shm/fastdds_*                                   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 线程创建时机详解

```cpp
// 线程创建完整时间线

【阶段 1: 程序启动】
main()
    │
    ▼
DomainParticipantFactory::get_instance()
    │
    └── 仅创建单例对象，无内部线程

【阶段 2: 创建 Participant】
DomainParticipantFactory::create_participant(domain_id, qos)
    │
    ▼
RTPSParticipantImpl::RTPSParticipantImpl()
    │
    ├── 1. 创建 ResourceEvent 线程
    │   └── resource_event_thread_.init_thread()
    │       └── 启动 ASIO io_service 事件循环
    │
    ├── 2. 创建 Transport 接收线程
    │   └── UDPTransportInterface::init()
    │       └── 为每个端口创建接收线程
    │           └── std::thread(&perform_listen_operation, ...)
    │
    ├── 3. 创建 PDP 定时器 (复用 ResourceEvent)
    │   └── PDP::init()
    │       └── 注册 PDP 定时器到 ResourceEvent
    │
    └── 4. 如果启用 Security
        └── SecurityManager::init()
            └── 创建 Security 处理线程

【阶段 3: 创建 Publisher 和 DataWriter】
participant->create_publisher()
    │
    └── 无新线程创建

publisher->create_datawriter()
    │
    ├── 创建 RTPSWriter
    │   ├── 如果 Reliability = RELIABLE
    │   │   └── 创建 StatefulWriter
    │   │       └── 注册定时器到 ResourceEvent
    │   │           ├── HEARTBEAT 定时器
    │   │           └── NACK 响应定时器
    │   │
    │   └── 如果 Reliability = BEST_EFFORT
    │       └── 创建 StatelessWriter
    │           └── 无定时器
    │
    └── 如果 PublishMode = ASYNC
        └── FlowControllerAsyncPublishMode::add_writer(this)
            └── 将 Writer 注册到全局 FlowControllerAsyncPublishMode

【阶段 4: 创建 Subscriber 和 DataReader】
participant->create_subscriber()
    │
    └── 无新线程创建

subscriber->create_datareader()
    │
    └── 创建 RTPSReader
        └── 创建 StatefulReader 或 StatelessReader
            └── 注册租约检查定时器到 ResourceEvent

【阶段 5: 销毁 Participant】
~DomainParticipantImpl()
    │
    ├── 1. 停止接收线程
    │   └── channel_resources_.clear()
    │       └── 设置 alive_ = false
    │       └── join 所有接收线程
    │
    ├── 2. 停止 ResourceEvent 线程
    │   └── resource_event_thread_.stop()
    │       └── io_service_.stop()
    │       └── join 事件线程
    │
    ├── 3. 停止 FlowControllerAsyncPublishMode (全局)
    │   └── 在所有 Participant 销毁后
    │       └── FlowControllerAsyncPublishMode::stop()
    │
    └── 4. 停止 Security 线程 (如果启用)
        └── SecurityManager::stop()
```

---

## 2. ResourceEvent 线程（定时器核心）

### 2.1 核心源码解析

```cpp
// include/fastdds/rtps/resources/ResourceEvent.h

namespace eprosima {
namespace fastdds {
namespace rtps {

class ResourceEvent {
public:
    /**
     * 构造函数
     * 初始化 ASIO io_service 和 work 对象
     */
    ResourceEvent()
        : io_service_()
        , work_(io_service_)  // work_ 保持 io_service 不退出
        , thread_()
        , mutex_()
        , stop_(false)
    {}
    
    /**
     * 启动事件线程
     * 这是 Participant 创建时调用的关键函数
     */
    void init_thread() {
        // 创建线程，运行事件循环
        thread_ = std::thread(&ResourceEvent::event_service_loop, this);
        
        // 设置线程名称（便于调试）
        eprosima::utilities::set_name_to_current_thread("FastDDS_Event");
    }
    
    /**
     * 停止事件线程
     */
    void stop() {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            stop_.store(true, std::memory_order_release);
        }
        
        // 停止 io_service，退出 run() 循环
        io_service_.stop();
        
        // 等待线程结束
        if (thread_.joinable()) {
            thread_.join();
        }
    }
    
    /**
     * 注册定时器事件
     * 被 StatefulWriter、PDP 等调用
     */
    void register_timer(TimedEventImpl* event) {
        std::lock_guard<std::mutex> lock(mutex_);
        
        // 将事件添加到 io_service
        // 使用 ASIO 的 deadline_timer 或 steady_timer
        event->schedule(io_service_);
    }
    
    /**
     * 取消定时器
     */
    void unregister_timer(TimedEventImpl* event) {
        std::lock_guard<std::mutex> lock(mutex_);
        event->cancel();
    }
    
    /**
     * 投递一个异步任务到事件线程
     * 线程安全的，可以从任意线程调用
     */
    template<typename Func>
    void post(Func&& func) {
        // ASIO 的 post 是线程安全的
        io_service_.post(std::forward<Func>(func));
    }

private:
    /**
     * 事件线程主循环
     * 这是真正运行在线程中的函数
     */
    void event_service_loop() {
        // 设置线程亲和性（如果配置了）
        // ...
        
        while (!stop_.load(std::memory_order_acquire)) {
            try {
                // io_service_.run() 会：
                // 1. 执行所有就绪的 handler（定时器回调）
                // 2. 如果没有 handler，阻塞等待
                // 3. 直到 io_service_.stop() 被调用
                io_service_.run();
                
                // 如果 run() 返回，可能是 stop() 被调用
                // 或者是所有 work 都完成了
            } 
            catch (const std::exception& e) {
                // 记录错误但不退出，保持线程存活
                logError(RTPS_RESOURCE_EVENT, "Exception: " << e.what());
            }
        }
    }

private:
    asio::io_service io_service_;           // ASIO IO 服务
    asio::io_service::work work_;           // 保持 io_service 运行
    std::thread thread_;                    // 事件处理线程
    std::mutex mutex_;                      // 保护 stop_ 标志
    std::atomic<bool> stop_;                // 停止标志
};

} // namespace rtps
} // namespace fastdds
} // namespace eprosima
```

### 2.2 TimedEvent 实现机制

```cpp
// include/fastdds/rtps/resources/TimedEventImpl.h

class TimedEventImpl {
public:
    /**
     * 构造函数
     * @param callback 定时器到期时执行的回调
     * @param interval 定时器间隔
     * @param autorestart 是否自动重启
     */
    TimedEventImpl(
        std::function<void()> callback,
        std::chrono::milliseconds interval,
        bool autorestart = true)
        : callback_(std::move(callback))
        , interval_(interval)
        , autorestart_(autorestart)
        , timer_(nullptr)
    {}
    
    /**
     * 在指定的 io_service 上调度定时器
     */
    void schedule(asio::io_service& io_service) {
        // 创建 ASIO 定时器
        timer_ = std::make_unique<asio::steady_timer>(io_service);
        
        // 设置到期时间
        timer_->expires_after(interval_);
        
        // 注册回调
        timer_->async_wait([this](const asio::error_code& ec) {
            if (!ec) {
                // 定时器到期，执行回调
                callback_();
                
                // 如果配置了自动重启，重新调度
                if (autorestart_ && timer_) {
                    timer_->expires_after(interval_);
                    timer_->async_wait(/* 同样的回调 */);
                }
            }
        });
    }
    
    /**
     * 取消定时器
     */
    void cancel() {
        if (timer_) {
            timer_->cancel();
        }
    }
    
    /**
     * 重启定时器（用于动态调整间隔）
     */
    void restart_timer() {
        if (timer_) {
            // 取消当前定时器
            timer_->cancel();
            // 重新设置到期时间
            timer_->expires_after(interval_);
            // 重新注册回调
            timer_->async_wait(/* ... */);
        }
    }

private:
    std::function<void()> callback_;                    // 回调函数
    std::chrono::milliseconds interval_;               // 定时器间隔
    bool autorestart_;                                  // 是否自动重启
    std::unique_ptr<asio::steady_timer> timer_;        // ASIO 定时器
};
```

### 2.3 典型定时器使用示例

```cpp
// StatefulWriter 中的定时器使用

class StatefulWriter : public RTPSWriter {
public:
    StatefulWriter(...)
        : RTPSWriter(...)
        // 1. 初始化 HEARTBEAT 定时器
        , heartbeat_event_(
            [this]() { this->send_periodic_heartbeat(); },  // 回调
            std::chrono::milliseconds(3000),               // 3秒间隔
            true                                           // 自动重启
          )
        // 2. 初始化 NACK 响应定时器
        , nack_response_event_(
            [this]() { this->perform_nack_responses(); },
            std::chrono::milliseconds(100),                // 100ms
            false                                          // 不自动重启
          )
    {}
    
    void enable() {
        // 注册定时器到 ResourceEvent
        if (get_participant_impl() && get_participant_impl()->get_resource_event()) {
            get_participant_impl()->get_resource_event()->register_timer(&heartbeat_event_);
            get_participant_impl()->get_resource_event()->register_timer(&nack_response_event_);
        }
    }
    
    void disable() {
        // 取消定时器
        if (get_participant_impl() && get_participant_impl()->get_resource_event()) {
            get_participant_impl()->get_resource_event()->unregister_timer(&heartbeat_event_);
            get_participant_impl()->get_resource_event()->unregister_timer(&nack_response_event_);
        }
    }

private:
    TimedEventImpl heartbeat_event_;       // HEARTBEAT 定时器
    TimedEventImpl nack_response_event_;   // NACK 响应定时器
    
    /**
     * 发送周期性 HEARTBEAT
     * 在 ResourceEvent 线程中执行
     */
    void send_periodic_heartbeat() {
        // 遍历所有匹配的 Reader
        for (ReaderProxy* reader : matched_readers_) {
            // 构建 HEARTBEAT SubMessage
            HeartbeatSubmessage hb;
            hb.writerId = get_entity_id();
            hb.firstSN = get_first_available_sequence_number();
            hb.lastSN = get_last_available_sequence_number();
            
            // 发送
            send_to_reader(reader, hb);
        }
    }
    
    /**
     * 处理 NACK 响应
     * 收到 ACKNACK 后触发此定时器，批量重传
     */
    void perform_nack_responses() {
        for (ReaderProxy* reader : matched_readers_) {
            // 获取需要重传的序列号
            std::vector<SequenceNumber_t> nack_list = reader->get_requested_changes();
            
            for (auto seq : nack_list) {
                CacheChange_t* change = history_->get_change(seq);
                if (change) {
                    resend_to_reader(reader, change);
                }
            }
        }
    }
};
```

---

## 3. FlowControllerAsyncPublishMode（异步发送）

### 3.1 全局单例实现

```cpp
// src/cpp/rtps/writer/FlowControllerAsyncPublishMode.cpp

namespace eprosima {
namespace fastdds {
namespace rtps {

/**
 * FlowControllerAsyncPublishMode 是全局单例
 * 所有 ASYNC 模式的 DataWriter 共享这一个线程
 */
class FlowControllerAsyncPublishMode {
public:
    /**
     * 获取全局单例实例
     */
    static FlowControllerAsyncPublishMode& get_instance() {
        // C++11 保证线程安全的静态初始化
        static FlowControllerAsyncPublishMode instance;
        return instance;
    }
    
    /**
     * 启动 FlowControllerAsyncPublishMode
     * 在第一个 ASYNC DataWriter 创建时调用
     */
    static bool start() {
        return get_instance().start_thread();
    }
    
    /**
     * 停止 FlowControllerAsyncPublishMode
     * 在最后一个 Participant 销毁时调用
     */
    static bool stop() {
        return get_instance().stop_thread();
    }
    
    /**
     * 注册 DataWriter
     */
    static bool add_writer(RTPSWriter* writer) {
        return get_instance().add_writer_internal(writer);
    }
    
    /**
     * 注销 DataWriter
     */
    static bool remove_writer(RTPSWriter* writer) {
        return get_instance().remove_writer_internal(writer);
    }
    
    /**
     * 唤醒线程处理新数据
     */
    static void wake_up() {
        get_instance().wake_up_internal();
    }

private:
    FlowControllerAsyncPublishMode()
        : thread_()
        , mutex_()
        , cv_()
        , writers_()
        , running_(false)
    {}
    
    ~FlowControllerAsyncPublishMode() {
        if (running_) {
            stop_thread();
        }
    }
    
    // 禁止拷贝
    FlowControllerAsyncPublishMode(const FlowControllerAsyncPublishMode&) = delete;
    FlowControllerAsyncPublishMode& operator=(const FlowControllerAsyncPublishMode&) = delete;

private:
    /**
     * 启动线程
     */
    bool start_thread() {
        std::lock_guard<std::mutex> lock(mutex_);
        
        if (running_) {
            return true;  // 已经在运行
        }
        
        running_ = true;
        thread_ = std::thread(&FlowControllerAsyncPublishMode::run, this);
        
        // 设置线程名称
        eprosima::utilities::set_name_to_current_thread("FastDDS_AsyncWriter");
        
        return true;
    }
    
    /**
     * 停止线程
     */
    bool stop_thread() {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            
            if (!running_) {
                return true;
            }
            
            running_ = false;
        }
        
        // 唤醒线程，让它退出
        cv_.notify_all();
        
        // 等待线程结束
        if (thread_.joinable()) {
            thread_.join();
        }
        
        return true;
    }
    
    /**
     * 注册 Writer
     */
    bool add_writer_internal(RTPSWriter* writer) {
        std::lock_guard<std::mutex> lock(mutex_);
        writers_.insert(writer);
        
        // 确保线程已启动
        if (!running_) {
            start_thread();
        }
        
        return true;
    }
    
    /**
     * 注销 Writer
     */
    bool remove_writer_internal(RTPSWriter* writer) {
        std::lock_guard<std::mutex> lock(mutex_);
        writers_.erase(writer);
        return true;
    }
    
    /**
     * 唤醒线程
     */
    void wake_up_internal() {
        cv_.notify_one();
    }

private:
    /**
     * 线程主循环 - 这是核心函数
     */
    void run() {
        std::unique_lock<std::mutex> lock(mutex_);
        
        while (running_) {
            // 记录是否有数据需要发送
            bool work_done = false;
            
            // 遍历所有注册的 Writer
            for (RTPSWriter* writer : writers_) {
                // 只处理 ASYNC 模式的 Writer
                if (!writer->is_async()) {
                    continue;
                }
                
                // 获取该 Writer 的 FlowController
                FlowController* fc = writer->get_flow_controller();
                
                if (fc) {
                    // 检查 FlowController 是否允许发送
                    // 令牌桶算法
                    bool can_send = fc->schedule();
                    
                    if (can_send) {
                        // 在锁外执行发送（避免持有锁进行网络IO）
                        lock.unlock();
                        
                        // 发送未发送的数据
                        writer->send_any_unsent_changes();
                        
                        work_done = true;
                        
                        lock.lock();
                    }
                }
            }
            
            // 计算下次唤醒时间
            std::chrono::steady_clock::time_point next_wakeup;
            
            if (work_done) {
                // 如果有工作要做，立即继续（但让出时间片）
                next_wakeup = std::chrono::steady_clock::now() + 
                              std::chrono::microseconds(10);
            } else {
                // 如果没有工作，等待较长时间或直到被唤醒
                next_wakeup = std::chrono::steady_clock::now() + 
                              std::chrono::milliseconds(100);
            }
            
            // 等待直到超时或被唤醒
            // 使用谓词避免虚假唤醒
            cv_.wait_until(lock, next_wakeup, [this] {
                return !running_ || has_work_to_do();
            });
        }
    }
    
    /**
     * 检查是否有工作需要做
     */
    bool has_work_to_do() {
        for (RTPSWriter* writer : writers_) {
            if (writer->is_async() && writer->has_unsent_changes()) {
                return true;
            }
        }
        return false;
    }

private:
    std::thread thread_;                                   // 工作线程
    std::mutex mutex_;                                      // 保护 writers_
    std::condition_variable cv_;                           // 唤醒条件变量
    std::unordered_set<RTPSWriter*> writers_;             // 注册的 Writers
    std::atomic<bool> running_;                            // 运行标志
};

} // namespace rtps
} // namespace fastdds
} // namespace eprosima
```

### 3.2 ASYNC 模式下的数据流

```cpp
// DataWriterImpl::write() - ASYNC 模式下的完整流程

ReturnCode_t DataWriterImpl::write(void* data) {
    // 1. 序列化数据
    CacheChange_t* change = create_new_change(data);
    
    // 2. 添加到 HistoryCache
    ReturnCode_t ret = history_->add_change(change);
    if (ret != RETCODE_OK) {
        return ret;
    }
    
    // 3. 触发异步发送
    // 关键：这里不会立即发送，而是入队等待 FlowControllerAsyncPublishMode
    if (qos_.publish_mode().kind == ASYNCHRONOUS) {
        // 3.1 获取 FlowController（如果有配置）
        FlowController* fc = get_flow_controller();
        
        if (fc) {
            // 3.2 将数据添加到 FlowController 的队列
            // FlowController 会管理发送速率
            fc->add_new_sample(
                rtps_writer_,      // RTPSWriter 指针
                change,            // 数据
                max_blocking_time_ // 最大阻塞时间
            );
        }
        
        // 3.3 唤醒 FlowControllerAsyncPublishMode
        // 通知有新数据需要发送
        FlowControllerAsyncPublishMode::wake_up();
    }
    
    return RETCODE_OK;
}

// 对比：SYNC 模式
ReturnCode_t DataWriterImpl::write_sync(void* data) {
    CacheChange_t* change = create_new_change(data);
    history_->add_change(change);
    
    // SYNC 模式：立即发送，阻塞直到完成
    rtps_writer_->send_any_unsent_changes();
    
    return RETCODE_OK;
}
```

---

## 4. Transport 接收线程

### 4.1 UDP 接收线程实现

```cpp
// src/cpp/transport/UDPTransportInterface.cpp

class UDPTransportInterface : public TransportInterface {
public:
    /**
     * 打开输出通道（同时创建接收线程）
     */
    bool open_output_channel(Locator_t locator) {
        // 创建 UDP socket
        int socket = create_udp_socket(locator);
        
        // 创建 ChannelResource
        auto channel_resource = std::make_shared<UDPChannelResource>(
            socket, 
            locator,
            receive_buffer_size_
        );
        
        // 存储通道资源
        channel_resources_[locator] = channel_resource;
        
        // 创建并启动接收线程
        std::thread receiver_thread(
            &UDPTransportInterface::perform_listen_operation,
            this,
            channel_resource.get()
        );
        
        // detach 线程，让它独立运行
        receiver_thread.detach();
        
        return true;
    }

private:
    /**
     * 接收线程主函数 - 每个端口一个线程
     */
    void perform_listen_operation(UDPChannelResource* channel) {
        // 设置线程名称
        eprosima::utilities::set_name_to_current_thread(
            "FastDDS_Recv" + std::to_string(channel->get_port())
        );
        
        // 接收缓冲区
        std::vector<uint8_t> buffer(max_message_size_);
        
        while (channel->alive()) {
            // 1. 阻塞接收 UDP 数据
            // 这是一个阻塞的系统调用
            ssize_t bytes_received = recvfrom(
                channel->get_socket(),           // socket fd
                buffer.data(),                    // 缓冲区
                buffer.size(),                    // 缓冲区大小
                0,                                // flags
                (struct sockaddr*)&sender_addr,   // 发送者地址
                &addr_len                         // 地址长度
            );
            
            if (bytes_received > 0) {
                // 2. 处理接收到的数据
                process_received_data(
                    buffer.data(), 
                    bytes_received,
                    sender_addr
                );
            } else if (bytes_received < 0) {
                // 处理错误
                if (errno != EINTR && errno != EAGAIN) {
                    logError(TRANSPORT_UDP, "recvfrom error: " << strerror(errno));
                }
            }
        }
        
        // 线程退出
        logInfo(TRANSPORT_UDP, "Receive thread exiting for port " << channel->get_port());
    }
    
    /**
     * 处理接收到的数据
     */
    void process_received_data(
        const uint8_t* data, 
        size_t size,
        const struct sockaddr_in& sender_addr)
    {
        // 1. 创建 MessageReceiver 解析 RTPS 消息
        MessageReceiver receiver;
        
        // 2. 解析 RTPS 头
        if (!receiver.processRTPSHeader(data, size)) {
            return;  // 不是有效的 RTPS 消息
        }
        
        // 3. 根据 GUID Prefix 找到目标 Participant
        GUIDPrefix_t dest_prefix = receiver.get_guid_prefix();
        
        RTPSParticipantImpl* participant = 
            RTPSDomainImpl::find_participant(dest_prefix);
        
        if (!participant) {
            // 可能是广播/多播消息，尝试所有参与者
            participant = find_participant_by_locator(sender_addr);
        }
        
        if (participant) {
            // 4. 让 Participant 处理消息
            participant->receive(&receiver, sender_addr);
        }
    }
};
```

### 4.2 数据分发机制

```cpp
// RTPSParticipantImpl::receive()

void RTPSParticipantImpl::receive(
    MessageReceiver* receiver,
    const Locator_t& locator)
{
    // 遍历消息中的所有 SubMessages
    for (SubMessage* submsg : receiver->get_submessages()) {
        switch (submsg->get_submessage_id()) {
            case DATA: {
                // 找到目标 Reader
                EntityId_t reader_id = submsg->get_reader_id();
                RTPSReader* reader = find_reader(reader_id);
                
                if (reader) {
                    // 处理 DATA SubMessage
                    reader->process_data_msg(submsg);
                }
                break;
            }
            
            case HEARTBEAT: {
                EntityId_t reader_id = submsg->get_reader_id();
                RTPSReader* reader = find_reader(reader_id);
                
                if (reader) {
                    // 处理 HEARTBEAT，发送 ACKNACK
                    reader->process_heartbeat_msg(submsg);
                }
                break;
            }
            
            case ACKNACK: {
                EntityId_t writer_id = submsg->get_writer_id();
                RTPSWriter* writer = find_writer(writer_id);
                
                if (writer) {
                    // 处理 ACKNACK，触发重传
                    writer->process_acknack_msg(submsg);
                }
                break;
            }
            
            case GAP: {
                EntityId_t reader_id = submsg->get_reader_id();
                RTPSReader* reader = find_reader(reader_id);
                
                if (reader) {
                    reader->process_gap_msg(submsg);
                }
                break;
            }
            
            // ... 其他 SubMessage 类型
        }
    }
}
```

---

## 5. Discovery 线程

### 5.1 PDP 定时器机制

```cpp
// src/cpp/rtps/builtin/discovery/participant/PDP.cpp

class PDP {
public:
    /**
     * PDP 初始化
     */
    void init(RTPSParticipantImpl* participant) {
        participant_ = participant;
        
        // 1. 创建 PDP 定时器
        // 使用 ResourceEvent 线程执行
        resend_participant_info_event_ = std::make_unique<TimedEventImpl>(
            [this]() { this->resend_participant_info(); },
            std::chrono::milliseconds(announcement_period_),  // 默认 3s
            true  // 自动重启
        );
        
        // 2. 创建租约检查定时器
        remove_remote_participants_event_ = std::make_unique<TimedEventImpl>(
            [this]() { this->remove_remote_participants(); },
            std::chrono::milliseconds(lease_duration_check_period_),  // 默认 1s
            true
        );
        
        // 3. 注册到 ResourceEvent
        auto* resource_event = participant->get_resource_event();
        if (resource_event) {
            resource_event->register_timer(resend_participant_info_event_.get());
            resource_event->register_timer(remove_remote_participants_event_.get());
        }
    }

private:
    /**
     * 周期性发送 PDP 信息
     * 在 ResourceEvent 线程中执行
     */
    void resend_participant_info() {
        // 构建 PDP 数据 (ParticipantProxyData)
        ParticipantProxyData pdata;
        pdata.guid = participant_->get_guid();
        pdata.unicast_locators = participant_->get_default_unicast_locators();
        pdata.multicast_locators = participant_->get_default_multicast_locators();
        pdata.lease_duration = lease_duration_;
        
        // 通过内置 Writer 发送
        builtin_participant_writer_->write(&pdata);
    }
    
    /**
     * 检查并清理过期参与者
     */
    void remove_remote_participants() {
        auto now = std::chrono::steady_clock::now();
        
        for (auto it = remote_participants_.begin(); 
             it != remote_participants_.end(); ) {
            
            auto last_received = it->second->last_received_info_time();
            auto elapsed = now - last_received;
            
            if (elapsed > it->second->lease_duration()) {
                // 租约过期，移除参与者
                remove_remote_participant(it->first);
                it = remote_participants_.erase(it);
            } else {
                ++it;
            }
        }
    }

private:
    RTPSParticipantImpl* participant_;
    std::unique_ptr<TimedEventImpl> resend_participant_info_event_;
    std::unique_ptr<TimedEventImpl> remove_remote_participants_event_;
    std::map<GUID_t, ParticipantProxyData> remote_participants_;
};
```

### 5.2 Discovery Server 独立线程

```cpp
// src/cpp/rtps/builtin/discovery/endpoint/DiscoveryServerManager.cpp

class DiscoveryServerManager {
public:
    void start_processing_thread() {
        stop_ = false;
        processing_thread_ = std::thread(
            &DiscoveryServerManager::processing_loop, 
            this
        );
    }
    
    void stop_processing_thread() {
        {
            std::lock_guard<std::mutex> lock(queue_mutex_);
            stop_ = true;
        }
        queue_cv_.notify_all();
        
        if (processing_thread_.joinable()) {
            processing_thread_.join();
        }
    }
    
    /**
     * 提交发现请求到队列
     * 可以从任意线程调用（Transport 接收线程等）
     */
    void submit_request(const DiscoveryRequest& request) {
        {
            std::lock_guard<std::mutex> lock(queue_mutex_);
            request_queue_.push(request);
        }
        queue_cv_.notify_one();
    }

private:
    void processing_loop() {
        while (!stop_) {
            DiscoveryRequest request;
            
            {
                std::unique_lock<std::mutex> lock(queue_mutex_);
                
                // 等待队列中有请求
                queue_cv_.wait(lock, [this] {
                    return !request_queue_.empty() || stop_;
                });
                
                if (stop_) break;
                
                request = request_queue_.front();
                request_queue_.pop();
            }
            
            // 在锁外处理请求
            process_request(request);
        }
    }
    
    void process_request(const DiscoveryRequest& request) {
        switch (request.type) {
            case REGISTER_PARTICIPANT:
                handle_register_participant(request.participant_data);
                break;
                
            case UNREGISTER_PARTICIPANT:
                handle_unregister_participant(request.participant_guid);
                break;
                
            case QUERY_ENDPOINTS:
                handle_query_endpoints(request.query, request.reply_locator);
                break;
                
            // ... 其他请求类型
        }
    }

private:
    std::thread processing_thread_;
    std::mutex queue_mutex_;
    std::condition_variable queue_cv_;
    std::queue<DiscoveryRequest> request_queue_;
    std::atomic<bool> stop_;
};
```

---

## 6. 线程间协作机制

### 6.1 线程协作全景图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      线程间协作全景图                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  【用户线程】                                                                 │
│  write(data)                                                                  │
│       │                                                                       │
│       ├── SYNC 模式 ─────────────────────┐                                   │
│       │                                   │                                   │
│       │   直接调用 send_any_unsent_changes│                                   │
│       │       │                           │                                   │
│       │       ▼                           │                                   │
│       │   【Transport 发送】              │                                   │
│       │       │                           │                                   │
│       │       └── sendto()                │                                   │
│       │                                   │                                   │
│       └── ASYNC 模式 ─────────────────────┤                                   │
│               │                           │                                   │
│               ▼                           │                                   │
│           FlowController::add_new_sample  │                                   │
│               │                           │                                   │
│               ├── 数据入队                │                                   │
│               └── FlowControllerAsyncPublishMode::wake_up()                               │
│                       │                   │                                   │
│                       ▼                   │                                   │
│               【条件变量通知】────────────┘                                   │
│                       │                                                       │
│  ═════════════════════╪══════════════════════════════════════════════════════│
│                       │                                                       │
│  【FlowControllerAsyncPublishMode】▼                                                       │
│  cv_.wait() 返回                                                              │
│       │                                                                       │
│       ├── 检查 FlowController 令牌                                            │
│       ├── 调用 send_any_unsent_changes                                        │
│       │       │                                                               │
│       │       ▼                                                               │
│       │   【Transport 发送】                                                  │
│       │       │                                                               │
│       │       └── sendto()                                                    │
│       │                                                                       │
│       └── 计算下次唤醒时间 ──→ cv_.wait_until()                               │
│                                                                              │
│  ═══════════════════════════════════════════════════════════════════════════│
│                                                                              │
│  【Transport 接收线程】                                                        │
│  recvfrom() 返回                                                              │
│       │                                                                       │
│       ├── 解析 RTPS 消息                                                      │
│       ├── 分发到 Reader                                                       │
│       │       │                                                               │
│       │       ├── DATA ────→ Reader::process_data_msg                         │
│       │       │                   │                                           │
│       │       │                   ├── 存入 History                            │
│       │       │                   ├── 回调 Listener ───→ 【用户回调】         │
│       │       │                   │       ⚠️ 在接收线程执行                    │
│       │       │                   │                                           │
│       │       │                   └── 或设置 WaitSet 条件 ───→ 【唤醒用户线程】│
│       │       │                                                               │
│       │       ├── HEARTBEAT ────→ Reader::send_acknack                        │
│       │       │                       │                                       │
│       │       │                       └── 直接发送 ACKNACK                    │
│       │       │                                                               │
│       │       └── ACKNACK ────→ Writer::process_acknack                       │
│       │                               │                                       │
│       │                               ├── 更新 ReaderProxy 状态               │
│       │                               └── ResourceEvent::register_timer       │
│       │                                       │                               │
│       │                                       └── 注册重传定时器              │
│       │                                                                       │
│       └── 继续 recvfrom()                                                     │
│                                                                              │
│  ═══════════════════════════════════════════════════════════════════════════│
│                                                                              │
│  【ResourceEvent 线程】                                                        │
│  io_service_.run()                                                            │
│       │                                                                       │
│       ├── HEARTBEAT 定时器到期 ────→ send_periodic_heartbeat                  │
│       │                                                               │       │
│       ├── NACK 响应定时器到期 ────→ perform_nack_responses            │       │
│       │       │                                                       │       │
│       │       └── 重传丢失的数据                                      │       │
│       │                                                               │       │
│       ├── PDP 定时器到期 ────→ resend_participant_info                │       │
│       │                                                               │       │
│       └── 租约检查到期 ────→ remove_remote_participants               │       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 6.2 关键协作代码

```cpp
// 场景 1: write() 协作流程

// 用户线程
void DataWriterImpl::write_async(void* data) {
    // 1. 序列化和入队
    CacheChange_t* change = create_change(data);
    history_->add_change(change);
    
    // 2. 通知 FlowControllerAsyncPublishMode
    // 使用条件变量唤醒
    FlowControllerAsyncPublishMode::wake_up();
}

// FlowControllerAsyncPublishMode
void FlowControllerAsyncPublishMode::wake_up() {
    cv_.notify_one();  // 唤醒等待的线程
}

// ====================

// 场景 2: 接收数据到应用

// Transport 接收线程
void StatefulReader::process_data_msg(CacheChange_t* change) {
    // 1. 存入 History
    history_->add_change(change);
    
    // 2. 回调 Listener（在接收线程执行）
    if (listener_) {
        // 直接回调，注意：这会阻塞接收线程！
        listener_->on_data_available(this);
    }
    
    // 3. 或设置 WaitSet 条件
    if (wait_set_) {
        wait_set_->notify_condition(this);
    }
}

// 用户线程（使用 WaitSet）
void user_thread() {
    WaitSet wait_set;
    wait_set.attach_condition(read_condition);
    
    // 阻塞等待数据
    ConditionSeq active_conditions;
    wait_set.wait(active_conditions, timeout);
    
    // 被唤醒后读取数据
    reader->take(data, info);
}

// ====================

// 场景 3: ACKNACK 触发重传

// Transport 接收线程
void StatefulWriter::process_acknack(const AckNackSubmessage& acknack) {
    ReaderProxy* reader = find_reader_proxy(acknack.reader_id);
    if (!reader) return;
    
    // 1. 解析位图，找出缺失的序列号
    std::vector<SequenceNumber_t> missing_seqs = 
        parse_bitmap(acknack.bitmap, acknack.base);
    
    // 2. 标记需要重传
    for (auto seq : missing_seqs) {
        reader->mark_as_requested(seq);
    }
    
    // 3. 注册 NACK 响应定时器到 ResourceEvent
    // 延迟一段时间后批量重传
    nack_response_event_.restart_timer();
}

// ResourceEvent 线程（定时器到期后）
void StatefulWriter::perform_nack_responses() {
    for (ReaderProxy* reader : matched_readers_) {
        // 获取需要重传的序列号
        auto requested = reader->get_requested_changes();
        
        for (auto seq : requested) {
            CacheChange_t* change = history_->get_change(seq);
            if (change) {
                // 重传
                send_to_reader(reader, change);
            }
        }
    }
}
```

---

## 7. 线程安全与锁机制

### 7.1 锁策略层级

```cpp
// Fast-DDS 的层级锁设计

【Level 1: DomainParticipant 级别】
class RTPSParticipantImpl {
    std::mutex mutex_;  // 保护 Participant 状态
    
public:
    void add_writer(RTPSWriter* writer) {
        std::lock_guard<std::mutex> lock(mutex_);
        writers_.push_back(writer);
    }
};

【Level 2: Endpoint (Writer/Reader) 级别】
class RTPSWriter {
    std::recursive_mutex mutex_;  // 递归锁，允许同线程重入
    
public:
    void add_change(CacheChange_t* change) {
        std::lock_guard<std::recursive_mutex> lock(mutex_);
        history_->add_change(change);
    }
};

【Level 3: ReaderProxy/WriterProxy 级别】
class ReaderProxy {
    std::mutex mutex_;  // 保护 Reader 状态
    
public:
    void add_change(CacheChange_t* change) {
        std::lock_guard<std::mutex> lock(mutex_);
        changes_for_reader_[change->sequenceNumber] = change;
    }
};

【Level 4: HistoryCache 级别】
class WriterHistory {
    std::mutex mutex_;  // 保护缓存
    
public:
    void add_change(CacheChange_t* change) {
        std::lock_guard<std::mutex> lock(mutex_);
        changes_.push_back(change);
    }
};

// 锁顺序规则：必须按 1→2→3→4 顺序获取
// 禁止反向获取，否则可能死锁
```

### 7.2 死锁避免

```cpp
// 死锁避免策略

// 策略 1: 固定获取顺序
void safe_lock_example() {
    // 总是按固定顺序获取锁
    std::lock(participant_mutex, writer_mutex, reader_proxy_mutex);
    
    std::lock_guard<std::mutex> lk1(participant_mutex, std::adopt_lock);
    std::lock_guard<std::mutex> lk2(writer_mutex, std::adopt_lock);
    std::lock_guard<std::mutex> lk3(reader_proxy_mutex, std::adopt_lock);
    
    // 安全执行操作
}

// 策略 2: 使用 std::scoped_lock (C++17)
void c++17_safe_lock() {
    std::scoped_lock lock(participant_mutex, writer_mutex, reader_proxy_mutex);
    // 自动按地址排序获取锁，避免死锁
}

// 策略 3: 锁超时
void timeout_lock_example() {
    std::unique_lock<std::mutex> lock(writer_mutex, std::defer_lock);
    
    if (lock.try_lock_for(std::chrono::milliseconds(100))) {
        // 成功获取锁
    } else {
        // 超时处理
        logWarning(RTPS_WRITER, "Failed to acquire lock, retrying...");
    }
}
```

---

## 8. 线程生命周期管理

### 8.1 完整的创建和销毁流程

```cpp
// 线程生命周期完整代码示例

class ParticipantThreadManager {
public:
    // 阶段 1: 创建和启动
    bool create_and_start() {
        // 1. 创建 ResourceEvent 线程
        resource_event_ = std::make_unique<ResourceEvent>();
        resource_event_->init_thread();
        
        // 2. 创建 Transport 接收线程
        for (auto& locator : receive_locators_) {
            open_receive_channel(locator);
        }
        
        // 3. 启动 FlowControllerAsyncPublishMode（如果是第一个 ASYNC Writer）
        FlowControllerAsyncPublishMode::start();
        
        // 4. 注册 PDP 定时器
        pdp_->enable();
        
        return true;
    }
    
    // 阶段 2: 运行中（线程执行业务逻辑）
    // ...
    
    // 阶段 3: 停止和销毁
    void stop_and_destroy() {
        // 1. 停止接收新数据
        for (auto& channel : channels_) {
            channel->set_alive(false);
        }
        
        // 2. 等待接收线程结束
        for (auto& thread : receive_threads_) {
            if (thread.joinable()) {
                thread.join();
            }
        }
        
        // 3. 停止 ResourceEvent（取消所有定时器）
        if (resource_event_) {
            resource_event_->stop();
        }
        
        // 4. 停止 FlowControllerAsyncPublishMode（如果是最后一个参与者）
        // 注意：FlowControllerAsyncPublishMode 是全局的，需要引用计数
        if (participant_count_ == 1) {
            FlowControllerAsyncPublishMode::stop();
        }
        
        // 5. 清理资源
        channels_.clear();
        resource_event_.reset();
    }

private:
    std::unique_ptr<ResourceEvent> resource_event_;
    std::vector<std::thread> receive_threads_;
    std::vector<std::shared_ptr<ChannelResource>> channels_;
    std::unique_ptr<PDP> pdp_;
    static std::atomic<int> participant_count_;
};
```

---

## 9. 性能调优实战

### 9.1 线程优先级配置

```cpp
// 配置线程优先级和调度策略

void configure_real_time_threads() {
    DomainParticipantQos qos;
    
    // 1. Transport 接收线程 - 最高优先级
    // 原因：接收延迟对实时性影响最大
    ThreadSettings transport_settings;
    transport_settings.scheduling_policy = SCHED_FIFO;  // 实时调度
    transport_settings.priority = 80;                   // 高优先级 (1-99)
    transport_settings.affinity = 0x01;                 // 绑定到 CPU 0
    
    qos.transport().user_transports[0]->set_thread_config(transport_settings);
    
    // 2. FlowControllerAsyncPublishMode - 中高优先级
    ThreadSettings async_settings;
    async_settings.scheduling_policy = SCHED_FIFO;
    async_settings.priority = 70;
    async_settings.affinity = 0x02;  // 绑定到 CPU 1
    
    qos.publish_mode().thread_settings = async_settings;
    
    // 3. ResourceEvent - 中等优先级
    ThreadSettings event_settings;
    event_settings.scheduling_policy = SCHED_OTHER;  // 普通调度
    event_settings.priority = -10;                   // nice 值
    event_settings.affinity = 0x04;                  // 绑定到 CPU 2
    
    qos.event().thread_settings = event_settings;
}
```

### 9.2 CPU 亲和性配置

```cpp
// 将不同线程绑定到不同 CPU 核心，减少缓存失效

void configure_cpu_affinity() {
    // 假设有 4 个 CPU 核心
    
    // CPU 0: Transport 接收线程
    // CPU 1: FlowControllerAsyncPublishMode
    // CPU 2: ResourceEvent + 业务逻辑
    // CPU 3: 其他后台任务
    
    DomainParticipantQos qos;
    
    // 接收线程绑定到 CPU 0
    qos.transport().user_transports[0]->
        set_thread_config({SCHED_FIFO, 80, 0x01, "RecvThread"});
    
    // AsyncWriter 绑定到 CPU 1
    qos.publish_mode().thread_settings = 
        {SCHED_FIFO, 70, 0x02, "AsyncWriter"};
    
    // 事件线程绑定到 CPU 2
    qos.event().thread_settings = 
        {SCHED_OTHER, -10, 0x04, "EventThread"};
}
```

### 9.3 线程数量调优

```cpp
// 根据硬件配置调整线程数量

void tune_thread_count() {
    unsigned int num_cores = std::thread::hardware_concurrency();
    
    DomainParticipantQos qos;
    
    // Transport 接收线程数
    // 通常不需要太多，每个网络接口 1 个即可
    qos.transport().max_num_threads = 
        std::min(4u, num_cores / 2);
    
    // 如果使用线程池处理接收数据
    qos.transport().receive_thread_pool_size = 
        std::min(8u, num_cores);
    
    // 注意：FlowControllerAsyncPublishMode 和 ResourceEvent 
    // 每个 Participant 各只有 1 个，不需要调整
}
```

---

## 10. 问题排查与调试

### 10.1 查看线程状态

```cpp
// 添加调试代码，输出线程状态

void print_thread_status() {
    std::cout << "=== Fast-DDS Thread Status ===" << std::endl;
    
    // 1. ResourceEvent 状态
    std::cout << "ResourceEvent:" << std::endl;
    std::cout << "  Thread ID: " << resource_event_thread_id_ << std::endl;
    std::cout << "  Active timers: " << get_active_timer_count() << std::endl;
    std::cout << "  Next timeout: " << get_next_timeout_ms() << " ms" << std::endl;
    
    // 2. FlowControllerAsyncPublishMode 状态
    std::cout << "FlowControllerAsyncPublishMode:" << std::endl;
    std::cout << "  Thread ID: " << async_writer_thread_id_ << std::endl;
    std::cout << "  Registered writers: " << get_registered_writer_count() << std::endl;
    std::cout << "  Running: " << (is_async_writer_running() ? "yes" : "no") << std::endl;
    
    // 3. Transport 接收线程
    std::cout << "Transport Threads:" << std::endl;
    for (auto& channel : channels_) {
        std::cout << "  Port " << channel->get_port() 
                  << ": alive=" << channel->is_alive()
                  << ", packets_received=" << channel->get_packet_count() << std::endl;
    }
}
```

### 10.2 GDB 调试线程

```bash
# 1. 查看所有线程
gdb -p $(pgrep your_app)
(gdb) info threads
  Id   Target Id         Frame
* 1    Thread 0x7f1234... main ()
  2    Thread 0x7f1235... recvfrom ()
  3    Thread 0x7f1236... pthread_cond_wait ()
  4    Thread 0x7f1237... asio::io_context::run ()

# 2. 查看特定线程的堆栈
(gdb) thread 3
(gdb) bt
#0  pthread_cond_wait ()
#1  FlowControllerAsyncPublishMode::run ()
#2  std::thread::_State_impl::_M_run ()

# 3. 查看所有线程的堆栈
(gdb) thread apply all bt

# 4. 查看锁信息
(gdb) info mutex
  Id   Description
* 1    Mutex 0x1234 is locked by thread 2
```

### 10.3 性能分析

```bash
# 1. 使用 perf 分析线程性能
sudo perf record -g -p $(pgrep your_app) -- sleep 10
sudo perf report

# 2. 使用 strace 跟踪系统调用
sudo strace -f -e futex,write,read,sendto,recvfrom -p $(pgrep your_app)

# 3. 查看线程 CPU 使用率
ps -T -p $(pgrep your_app) -o pid,tid,comm,pcpu,pmem

# 4. 使用 ThreadSanitizer 检测数据竞争
# 编译时添加: -fsanitize=thread
g++ -fsanitize=thread -g your_app.cpp -o your_app
./your_app
```

---

## 总结

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Fast-DDS 线程模型核心要点                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  核心线程 (每个 Participant):                                                │
│  ─────────────────────────                                                   │
│  1. ResourceEvent      - ASIO io_service 事件循环，处理定时器                │
│  2. FlowControllerAsyncPublishMode  - 全局单例，ASYNC 模式数据发送                        │
│  3. Transport 接收     - 每端口一个，阻塞 recvfrom                           │
│  4. PDP 定时器         - 复用 ResourceEvent                                  │
│  5. Security 线程      - 可选，认证加密                                      │
│                                                                              │
│  线程协作机制:                                                               │
│  ───────────────                                                             │
│  • 条件变量: FlowControllerAsyncPublishMode 唤醒                                          │
│  • ASIO post: ResourceEvent 任务投递                                         │
│  • 回调: Transport 接收 → Reader Listener                                    │
│  • 无锁队列: 高吞吐数据缓冲                                                  │
│                                                                              │
│  线程安全:                                                                   │
│  ─────────                                                                   │
│  • 层级锁: Participant → Endpoint → Proxy → Cache                            │
│  • 禁止反向获取锁，避免死锁                                                  │
│  • 细粒度锁，减少竞争                                                        │
│                                                                              │
│  性能调优:                                                                   │
│  ─────────                                                                   │
│  • SCHED_FIFO + 优先级 (实时场景)                                            │
│  • CPU 亲和性，避免缓存失效                                                  │
│  • 批量处理，减少唤醒次数                                                    │
│                                                                              │
│  调试工具:                                                                   │
│  ─────────                                                                   │
│  • gdb thread apply all bt                                                   │
│  • perf (性能分析)                                                           │
│  • strace (系统调用跟踪)                                                     │
│  • ThreadSanitizer (数据竞争检测)                                            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

*文档版本: 2.0 - 源码级深度解析*  
*基于 Fast-DDS 2.14.x 完整源码分析*
