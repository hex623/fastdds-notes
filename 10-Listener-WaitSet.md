# 10 监听与回调机制（Listener/WaitSet）

**记录时间**: 2026-03-03  
**学习时长**: 约 1.5 小时  
**前置知识**: 01-09 基础笔记

---

## 1. 异步通知机制全景

### 三种核心模式

| 模式 | 机制 | 实时性 | 复杂度 | 适用场景 |
|------|------|--------|--------|----------|
| **Listener** | 回调函数 | 最高 | 低 | 简单实时响应 |
| **WaitSet** | 条件变量等待 | 高 | 中 | 多条件组合等待 |
| **Read/Take** | 主动轮询 | 低 | 最低 | 简单场景 |

---

## 2. Listener - 回调机制

### DataReader Listener 接口

```cpp
class DataReaderListener
{
public:
    // 有数据到达（最常用）
    virtual void on_data_available(DataReader* reader) {}
    
    // 匹配的 Writer 发生变化
    virtual void on_subscription_matched(DataReader* reader, 
                                         const SubscriptionMatchedStatus& status) {}
    
    // 数据被拒绝（History 满）
    virtual void on_sample_rejected(DataReader* reader, 
                                    const SampleRejectedStatus& status) {}
    
    // Liveliness 变化
    virtual void on_liveliness_changed(DataReader* reader,
                                       const LivelinessChangedStatus& status) {}
    
    // Deadline 错过
    virtual void on_requested_deadline_missed(DataReader* reader,
                                              const RequestedDeadlineMissedStatus& status) {}
};
```

### 使用示例

```cpp
class MyDataReaderListener : public DataReaderListener
{
public:
    void on_data_available(DataReader* reader) override
    {
        HelloWorldMsg msg;
        SampleInfo info;
        
        while (reader->take_next_sample(&msg, &info) == ReturnCode_t::RETCODE_OK)
        {
            if (info.valid_data)
            {
                std::cout << "Received: " << msg.message() << std::endl;
            }
        }
    }
};

// 创建时传入 Listener
MyDataReaderListener listener;
DataReader* reader = subscriber->create_datareader(
    topic, DATAREADER_QOS_DEFAULT, &listener, StatusMask::all());
```

### ⚠️ 关键限制

```cpp
// ❌ 错误：在 Listener 中做耗时操作
void on_data_available(DataReader* reader) override
{
    process_data_heavy();      // 耗时 100ms - 会阻塞接收线程！
}

// ✅ 正确：快速转移到工作队列
void on_data_available(DataReader* reader) override
{
    // 快速读取所有数据入队
    while (reader->take_next_sample(&msg, &info) == ReturnCode_t::RETCODE_OK)
    {
        queue_.push(msg);  // 无锁队列，立即返回
    }
    worker_pool_.notify();  // 通知工作线程
}
```

---

## 3. WaitSet - 条件等待机制

### 核心概念

WaitSet = 一组 Condition 的集合，可以等待多个事件同时发生。

```cpp
WaitSet waitset;
waitset.attach_condition(condition1);
waitset.attach_condition(condition2);

ConditionSeq triggered_conditions;
Duration_t timeout(10, 0);

ReturnCode_t ret = waitset.wait(triggered_conditions, timeout);
```

### Condition 类型

| Condition 类型 | 触发条件 | 适用场景 |
|----------------|---------|----------|
| **StatusCondition** | Entity 状态变化 | 数据到达、匹配变化 |
| **ReadCondition** | 特定样本状态 | 只读取特定状态的数据 |
| **QueryCondition** | 查询条件匹配 | 带过滤的数据读取 |
| **GuardCondition** | 手动触发 | 外部事件通知 |

### StatusCondition 示例

```cpp
StatusCondition* condition = reader->get_statuscondition();

StatusMask mask;
mask.set(StatusMask::data_available());
mask.set(StatusMask::subscription_matched());
condition->set_enabled_statuses(mask);

WaitSet waitset;
waitset.attach_condition(condition);

while (running_)
{
    ConditionSeq triggered;
    waitset.wait(triggered, Duration_t(1, 0));
    
    for (auto* cond : triggered)
    {
        if (cond == condition)
        {
            StatusMask changed = reader->get_status_changes();
            if (changed.is_active(StatusMask::data_available()))
            {
                // 读取数据
            }
        }
    }
}
```

### ReadCondition - 按状态过滤

```cpp
// 只读取"未读过的"数据
ReadCondition* read_cond = reader->create_readcondition(
    NOT_READ_SAMPLE_STATE,    // 未读状态
    ANY_VIEW_STATE,           // 任意 View 状态
    ALIVE_INSTANCE_STATE      // 活跃实例
);

WaitSet waitset;
waitset.attach_condition(read_cond);

// 当有新数据且满足条件时触发
ConditionSeq triggered;
waitset.wait(triggered, Duration_t::infinite());

for (auto* cond : triggered)
{
    if (cond == read_cond)
    {
        LoanedSamples<HelloWorldMsg> samples = reader->take();
        // 处理数据
    }
}
```

### QueryCondition - 带查询条件

```cpp
// 只读取 id > 100 的消息
QueryCondition* query_cond = reader->create_querycondition(
    NOT_READ_SAMPLE_STATE,
    ANY_VIEW_STATE,
    ALIVE_INSTANCE_STATE,
    "id > %0",           // 查询表达式
    {"100"}              // 参数
);

WaitSet waitset;
waitset.attach_condition(query_cond);

// 当有新数据且 id > 100 时触发
waitset.wait(triggered, Duration_t::infinite());
```

---

## 4. Listener vs WaitSet 对比

| 特性 | Listener | WaitSet |
|------|----------|---------|
| **触发方式** | 自动回调 | 显式等待 |
| **线程** | DDS 接收线程 | 用户线程 |
| **实时性** | 最高 | 高 |
| **可组合性** | 难 | 易 |
| **阻塞风险** | 高 | 低 |
| **适用场景** | 简单快速响应 | 复杂多条件等待 |

### 选择建议

```cpp
// 场景 1：简单实时响应 → Listener
class SimpleListener : public DataReaderListener
{
    void on_data_available(DataReader* reader) override
    {
        take_and_process_quickly(reader);
    }
};

// 场景 2：多数据源聚合 → WaitSet
void multi_source_processor()
{
    WaitSet waitset;
    waitset.attach_condition(reader1->get_statuscondition());
    waitset.attach_condition(reader2->get_statuscondition());
    waitset.attach_condition(timer_cond);
    
    while (running_)
    {
        ConditionSeq triggered;
        waitset.wait(triggered, timeout);
        
        for (auto* cond : triggered)
        {
            dispatch_event(cond);
        }
    }
}

// 场景 3：高吞吐量 + 复杂处理 → 混合模式
class HybridProcessor : public DataReaderListener
{
private:
    LockFreeQueue<Data> queue_;
    ThreadPool workers_;
    
public:
    // Listener 快速入队
    void on_data_available(DataReader* reader) override
    {
        queue_data(reader);
    }
    
    // 工作线程处理
    void worker_loop()
    {
        while (running_)
        {
            Data data = queue_.pop();
            process_heavy(data);
        }
    }
};
```

---

## 5. 多线程数据处理

### 线程池 + 无锁队列

```cpp
class ParallelProcessor
{
private:
    DataReader* reader_;
    boost::lockfree::spsc_queue<Sample, boost::lockfree::capacity<1024>> queue_;
    std::vector<std::thread> workers_;
    std::atomic<bool> running_{true};
    
public:
    void start(int num_workers)
    {
        for (int i = 0; i < num_workers; ++i)
        {
            workers_.emplace_back(&ParallelProcessor::worker_loop, this);
        }
        receive_loop();
    }
    
    void receive_loop()
    {
        WaitSet waitset;
        waitset.attach_condition(reader_->get_statuscondition());
        
        while (running_)
        {
            ConditionSeq triggered;
            waitset.wait(triggered, Duration_t(0, 100000000));
            
            LoanedSamples<Msg> samples = reader_->take();
            for (auto& sample : samples)
            {
                if (sample.info().valid_data)
                {
                    while (!queue_.push(sample.data()))
                    {
                        std::this_thread::yield();
                    }
                }
            }
        }
    }
    
    void worker_loop()
    {
        while (running_)
        {
            Sample sample;
            if (queue_.pop(sample))
            {
                process_heavy(sample);
            }
            else
            {
                std::this_thread::yield();
            }
        }
    }
};
```

---

## 6. 调试与监控

### 检查回调触发频率

```cpp
class MonitoredListener : public DataReaderListener
{
private:
    std::atomic<uint64_t> callback_count_{0};
    std::chrono::steady_clock::time_point last_log_;
    
public:
    void on_data_available(DataReader* reader) override
    {
        ++callback_count_;
        
        auto now = std::chrono::steady_clock::now();
        if (now - last_log_ > std::chrono::seconds(1))
        {
            std::cout << "Callbacks/sec: " << callback_count_ << std::endl;
            callback_count_ = 0;
            last_log_ = now;
        }
        
        // 正常处理...
    }
};
```

### 检测回调耗时

```cpp
class TimedListener : public DataReaderListener
{
public:
    void on_data_available(DataReader* reader) override
    {
        auto start = std::chrono::high_resolution_clock::now();
        
        process_data(reader);
        
        auto end = std::chrono::high_resolution_clock::now();
        auto duration = std::chrono::duration_cast<std::chrono::microseconds>(end - start);
        
        if (duration.count() > 1000)  // 超过 1ms
        {
            std::cerr << "Warning: Callback took " << duration.count() << " us" << std::endl;
        }
    }
};
```

---

## 参考链接

- [01 RTPS源码分析](./01-RTPS-Source-Analysis.md)
- [09 进阶主题](./09-Advanced-Topics.md)
- Fast-DDS 官方文档: https://fast-dds.docs.eprosima.com/
