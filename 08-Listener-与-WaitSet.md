# 08 - Listener 与 WaitSet

**来源**: 2026-03-03 笔记  
**整理时间**: 2026-03-17

---

## Listener 回调机制

Listener 是 DDS 的**事件驱动**编程模型。

### 8种回调类型

| 回调 | 触发时机 | 用途 |
|------|----------|------|
| `on_data_available()` | 数据到达 | 接收数据 |
| `on_subscription_matched()` | Reader 匹配/断开 | 连接状态 |
| `on_publication_matched()` | Writer 匹配/断开 | 连接状态 |
| `on_liveliness_changed()` | 活性变化 | 故障检测 |
| `on_requested_deadline_missed()` | 错过截止期限 | 实时性监控 |
| `on_offered_incompatible_qos()` | QoS 不兼容 | 配置错误检测 |
| `on_sample_lost()` | 样本丢失 | 可靠性监控 |
| `on_sample_rejected()` | 样本被拒绝 | 资源限制处理 |

### 使用示例
```cpp
class MyReaderListener : public DataReaderListener {
public:
    void on_data_available(DataReader* reader) override {
        HelloWorld data;
        SampleInfo info;
        if (reader->take_next_sample(&data, &info) == ReturnCode_t::RETCODE_OK) {
            std::cout << "收到: " << data.message() << std::endl;
        }
    }
    
    void on_subscription_matched(DataReader* reader,
                                 const SubscriptionMatchedStatus& status) override {
        if (status.current_count_change > 0) {
            std::cout << "匹配新 Writer" << std::endl;
        }
    }
};

// 创建带 Listener 的 Reader
MyReaderListener listener;
DataReader* reader = subscriber->create_datareader(
    topic, 
    DATAREADER_QOS_DEFAULT,
    &listener
);
```

---

## WaitSet 条件等待

WaitSet 是 DDS 的**轮询**编程模型，适合多路复用场景。

### 4种 Condition

| Condition | 用途 |
|-----------|------|
| `ReadCondition` | 数据可读 |
| `QueryCondition` | 满足查询条件的数据 |
| `StatusCondition` | 状态变化 |
| `GuardCondition` | 用户触发 |

### 使用示例
```cpp
// 创建 WaitSet
WaitSet wait_set;

// 创建 ReadCondition
ReadCondition* read_cond = reader->create_readcondition(
    ANY_SAMPLE_STATE,
    ANY_VIEW_STATE,
    ANY_INSTANCE_STATE
);

// 附加到 WaitSet
wait_set.attach_condition(read_cond);

// 等待事件
ConditionSeq active_conditions;
Duration_t timeout {1, 0};  // 1秒超时

while (true) {
    ReturnCode_t ret = wait_set.wait(active_conditions, timeout);
    
    if (ret == ReturnCode_t::RETCODE_OK) {
        // 检查哪个条件触发
        for (auto cond : active_conditions) {
            if (cond == read_cond) {
                // 读取数据
                HelloWorldSeq data_seq;
                SampleInfoSeq info_seq;
                reader->take(data_seq, info_seq);
            }
        }
    }
}
```

---

## Listener vs WaitSet 对比

| 特性 | Listener | WaitSet |
|------|----------|---------|
| **编程模型** | 事件驱动（回调） | 轮询 |
| **线程** | DDS 内部线程 | 用户线程 |
| **复杂度** | 简单 | 较复杂 |
| **适用场景** | 单 Reader/Writer | 多 Reader 多路复用 |
| **实时性** | 立即响应 | 受轮询间隔影响 |
| **灵活性** | 固定回调 | 动态条件组合 |

---

## 多线程数据处理

### 线程安全原则
- **Reader/Writer 创建**: 线程安全
- **write()**: 线程安全
- **take()**: 线程安全
- **Listener 回调**: 在 DDS 线程中执行，尽快返回

### 推荐模式
```cpp
// Listener 只做通知，数据处理放到工作线程
class MyListener : public DataReaderListener {
    std::queue<CacheChange_t*>& queue_;
    std::mutex& mutex_;
    std::condition_variable& cv_;
    
public:
    void on_data_available(DataReader*) override {
        std::lock_guard<std::mutex> lock(mutex_);
        queue_.push(change);
        cv_.notify_one();  // 通知工作线程
    }
};

// 工作线程处理数据
void worker_thread() {
    while (running) {
        std::unique_lock<std::mutex> lock(mutex_);
        cv_.wait(lock, []{ return !queue_.empty(); });
        
        auto change = queue_.front();
        queue_.pop();
        lock.unlock();
        
        // 处理数据（耗时操作）
        process(change);
    }
}
```

---

_整理自 2026-03-03 Listener/WaitSet 笔记_
