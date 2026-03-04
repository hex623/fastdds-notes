# Example 01: Hello World - 入门必读

**示例路径**: `Fast-DDS/examples/cpp/hello_world/`  
**学习目标**: 理解最基础的 DDS Pub/Sub 模式，掌握 Listener 和 WaitSet 两种订阅方式  
**难度**: ⭐ 入门  
**预计时长**: 30分钟

---

## 🎯 学习目标

1. 理解 DDS 基础实体：DomainParticipant → Publisher/Subscriber → DataWriter/DataReader
2. 掌握两种订阅机制：Listener 回调 vs WaitSet 等待
3. 理解发现机制：Publisher 和 Subscriber 如何自动匹配
4. 学习 QoS 配置：通过 XML 文件配置实体属性

---

## 📁 源码结构

```
hello_world/
├── CMakeLists.txt              # 构建配置
├── README.md                   # 官方文档
├── Application.hpp/cpp         # 应用基类（公共逻辑）
├── PublisherApp.hpp/cpp        # Publisher 实现
├── SubscriberApp.hpp/cpp       # Subscriber 实现（Listener 版本）
├── WaitsetSubscriberApp.hpp    # Subscriber 实现（WaitSet 版本）
├── HelloWorld.hpp              # 数据类型定义（IDL生成）
├── HelloWorldPubSubTypes.hpp   # TypeSupport（IDL生成）
└── HelloWorldTypeObjectSupport.hpp  # XTypes支持（IDL生成）
```

---

## 🏗️ 架构图

```
Publisher 端                                          Subscriber 端
═══════════════                                      ═══════════════

┌─────────────────┐                                  ┌─────────────────┐
│   Application   │                                  │   Application   │
│   (基类)        │                                  │   (基类)        │
└────────┬────────┘                                  └────────┬────────┘
         │                                                   │
         ▼                                                   ▼
┌─────────────────┐                                  ┌─────────────────┐
│ PublisherApp    │                                  │ SubscriberApp   │
│                 │                                  │   (继承 Listener)│
│ - create_participant()                             │                 │
│ - create_publisher()                               │ - 重写 on_data_ │
│ - create_datawriter()                              │   available()   │
└────────┬────────┘                                  └────────┬────────┘
         │                                                   │
         ▼                                                   ▼
┌─────────────────┐                                  ┌─────────────────┐
│ DomainParticipant│                                 │ DomainParticipant│
│  (域参与者)      │◄─────────发现机制──────────────►│  (域参与者)      │
└────────┬────────┘                                  └────────┬────────┘
         │                                                   │
         ▼                                                   ▼
┌─────────────────┐                                  ┌─────────────────┐
│   Publisher     │                                  │   Subscriber    │
│  (发布者)        │                                  │  (订阅者)        │
└────────┬────────┘                                  └────────┬────────┘
         │                                                   │
         ▼                                                   ▼
┌─────────────────┐                                  ┌─────────────────┐
│  DataWriter     │───────────HelloWorld─────────────►│  DataReader     │
│  (数据写入者)    │         (Topic: HelloWorld)      │  (数据读取者)    │
└─────────────────┘                                  └─────────────────┘

关键交互流程：
1. 双方创建 DomainParticipant（加入同一个 Domain）
2. SPDP/SEDP 发现机制自动匹配（主题名相同）
3. Publisher 写入数据 → 通过网络传输 → Subscriber 接收数据
4. Subscriber 通过 Listener 回调或 WaitSet 获取数据
```

---

## 🔍 核心源码分析

### 1. 数据类型定义 (HelloWorld.hpp)

```cpp
// IDL 生成的数据类型
struct HelloWorld
{
    uint32_t index();           // 序列号
    void index(uint32_t _index);
    
    std::string message();      // 消息内容
    void message(const std::string& _message);
};

// 对应的 TypeSupport（由 fastddsgen 生成）
class HelloWorldPubSubType : public eprosima::fastdds::dds::TopicDataType
{
public:
    // 序列化：C++ 对象 → 字节流
    bool serialize(void* data, eprosima::fastrtps::rtps::SerializedPayload_t* payload) override;
    
    // 反序列化：字节流 → C++ 对象
    bool deserialize(eprosima::fastrtps::rtps::SerializedPayload_t* payload, void* data) override;
    
    // 获取类型名称（用于发现匹配）
    std::string getName() override { return "HelloWorld"; }
};
```

**学习要点**:
- DDS 是强类型的，必须先定义数据类型并注册
- TypeSupport 负责序列化/反序列化
- 类型名称必须匹配（区分大小写）

---

### 2. Publisher 实现 (PublisherApp.cpp)

```cpp
bool PublisherApp::init()
{
    // Step 1: 创建 DomainParticipant
    // DomainParticipant 是 DDS 的入口点，表示一个域参与者
    DomainParticipantQos participant_qos;
    // 可以在这里配置 participant_qos，例如传输方式、发现机制等
    
    participant_ = DomainParticipantFactory::get_instance()->create_participant(
        0,                    // Domain ID = 0
        participant_qos,      // QoS 配置
        nullptr,              // Listener（Participant 通常不需要）
        StatusMask::none());  // 监听的状态掩码
    
    if (participant_ == nullptr)
    {
        throw std::runtime_error("Participant initialization failed");
    }
    
    // Step 2: 注册数据类型
    // 必须先注册类型，才能创建 Topic
    TypeSupport type_support(new HelloWorldPubSubType());
    type_support.register_type(participant_, type_support.get_type_name());
    
    // Step 3: 创建 Topic
    // Topic 是发布和订阅的纽带，通过 TopicName 匹配
    TopicQos topic_qos;
    topic_ = participant_->create_topic(
        "HelloWorldTopic",           // Topic 名称
        type_support.get_type_name(), // 类型名称
        topic_qos);
    
    // Step 4: 创建 Publisher
    // Publisher 是 DataWriter 的工厂
    PublisherQos publisher_qos;
    publisher_ = participant_->create_publisher(publisher_qos, nullptr, StatusMask::none());
    
    // Step 5: 创建 DataWriter
    // DataWriter 是实际写入数据的实体
    DataWriterQos writer_qos;
    // 可以配置 QoS，如可靠性、历史策略等
    writer_qos.reliability().kind = RELIABLE_RELIABILITY_QOS;  // 可靠传输
    writer_qos.history().kind = KEEP_ALL_HISTORY_QOS;          // 保留所有历史
    
    writer_ = publisher_->create_datawriter(
        topic_,
        writer_qos,
        nullptr,           // 这里可以传 Listener 监听 Writer 事件
        StatusMask::none());
    
    return true;
}

void PublisherApp::run()
{
    uint32_t index = 0;
    
    // 等待 Subscriber 匹配（发现完成）
    // 实际应用中可以监听订阅者匹配事件
    std::this_thread::sleep_for(std::chrono::milliseconds(500));
    
    while (!stop_signal_.load())
    {
        // 构造数据
        HelloWorld hello;
        hello.index(++index);
        hello.message("Hello world");
        
        // 写入数据
        // write() 是异步的，数据进入 History 缓存后返回
        ReturnCode_t ret = writer_->write(&hello);
        
        if (ret != ReturnCode_t::RETCODE_OK)
        {
            std::cerr << "Write failed: " << ret() << std::endl;
        }
        
        std::cout << "Message: '" << hello.message() 
                  << "' with index: '" << hello.index() 
                  << "' SENT" << std::endl;
        
        // 每秒发送一次
        std::this_thread::sleep_for(std::chrono::seconds(1));
    }
}
```

**学习要点**:
- DDS 实体创建顺序：Participant → Type → Topic → Publisher → DataWriter
- DataWriter::write() 是异步操作，数据不会立即发送
- 发现是自动的，不需要手动指定 Subscriber 地址

---

### 3. Subscriber - Listener 版本 (SubscriberApp.cpp)

```cpp
// SubscriberApp 继承 DataReaderListener，接收回调
class SubscriberApp : public Application, public DataReaderListener
{
public:
    // 重写 DataReaderListener 的回调方法
    void on_subscription_matched(
        DataReader* reader,
        const SubscriptionMatchedStatus& info) override;
    
    void on_data_available(DataReader* reader) override;
};

void SubscriberApp::on_subscription_matched(
    DataReader* reader,
    const SubscriptionMatchedStatus& info)
{
    // 当匹配的 Writer 发生变化时回调
    if (info.current_count_change > 0)
    {
        std::cout << "Subscriber matched." << std::endl;
    }
    else
    {
        std::cout << "Subscriber unmatched." << std::endl;
    }
}

void SubscriberApp::on_data_available(DataReader* reader)
{
    // 有新数据到达时回调
    // ⚠️ 注意：这个回调在 DDS 内部线程中执行，不要阻塞！
    
    HelloWorld hello;
    SampleInfo info;
    
    // take_next_sample: 读取并移除数据（不保留在 History）
    // read_next_sample: 读取但不移除（下次还能读到）
    ReturnCode_t ret = reader->take_next_sample(&hello,     // 输出：数据
                                               &info);     // 输出：样本信息
    
    if (ret == ReturnCode_t::RETCODE_OK && info.valid_data)
    {
        // info.valid_data 为 true 表示是有效数据（不是生命周期变化通知）
        std::cout << "Message: '" << hello.message()
                  << "' with index: '" << hello.index()
                  << "' RECEIVED" << std::endl;
    }
}

bool SubscriberApp::init()
{
    // ... 创建 Participant、注册 Type、创建 Topic（同 Publisher）
    
    // 创建 Subscriber
    SubscriberQos subscriber_qos;
    subscriber_ = participant_->create_subscriber(
        subscriber_qos, nullptr, StatusMask::none());
    
    // 创建 DataReader，传入 this 作为 Listener
    DataReaderQos reader_qos;
    reader_qos.reliability().kind = RELIABLE_RELIABILITY_QOS;
    reader_qos.history().kind = KEEP_ALL_HISTORY_QOS;
    
    reader_ = subscriber_->create_datareader(
        topic_,
        reader_qos,
        this,              // 🔴 关键：传入 Listener 接收回调
        StatusMask::data_available() | StatusMask::subscription_matched());
    
    return true;
}

void SubscriberApp::run()
{
    // 使用 Condition Variable 等待停止信号
    // 实际数据处理都在 on_data_available 回调中完成
    std::unique_lock<std::mutex> lock(mutex_);
    cv_.wait(lock, [this] { return stop_signal_.load(); });
}
```

**学习要点**:
- Listener 机制：DataReader 通过回调通知应用层有新数据
- 回调在 DDS 内部线程执行，不能阻塞（否则影响其他数据处理）
- StatusMask 指定监听哪些事件

---

### 4. Subscriber - WaitSet 版本 (WaitsetSubscriberApp.hpp)

```cpp
// WaitSet 版本不继承 Listener，使用条件变量等待
class WaitsetSubscriberApp : public Application
{
public:
    void run() override;
};

void WaitsetSubscriberApp::run()
{
    // 创建 StatusCondition
    // Condition 是 WaitSet 的基本单元
    StatusCondition* condition = reader_>get_statuscondition();
    
    // 设置监听的状态
    StatusMask mask;
    mask.set(StatusMask::data_available());      // 数据到达
    mask.set(StatusMask::subscription_matched()); // 匹配变化
    condition->set_enabled_statuses(mask);
    
    // 创建 WaitSet
    WaitSet waitset;
    waitset.attach_condition(condition);
    
    while (!stop_signal_.load())
    {
        ConditionSeq triggered_conditions;
        Duration_t timeout(1, 0);  // 1秒超时
        
        // 等待条件触发（阻塞）
        ReturnCode_t ret = waitset.wait(triggered_conditions, timeout);
        
        if (ret == ReturnCode_t::RETCODE_OK)
        {
            // 有 Condition 触发，检查是哪个
            for (Condition* cond : triggered_conditions)
            {
                if (cond == condition)
                {
                    // 获取状态变化
                    StatusMask changed_status = reader_>get_status_changes();
                    
                    if (changed_status.is_active(StatusMask::data_available()))
                    {
                        // 读取数据（同 Listener 版本）
                        HelloWorld hello;
                        SampleInfo info;
                        while (reader_>take_next_sample(&hello, &info) == ReturnCode_t::RETCODE_OK)
                        {
                            if (info.valid_data)
                            {
                                std::cout << "Message: '" << hello.message()
                                          << "' with index: '" << hello.index()
                                          << "' RECEIVED" << std::endl;
                            }
                        }
                    }
                }
            }
        }
        else if (ret == ReturnCode_t::RETCODE_TIMEOUT)
        {
            // 超时，没有数据
            // 可以在这里做其他事情
        }
    }
}
```

**学习要点**:
- WaitSet：在用户线程中阻塞等待事件，适合需要精确控制时机的场景
- StatusCondition：监听 Entity 的状态变化
- 可以组合多个 Condition，实现多路复用

---

## 🔄 Listener vs WaitSet 对比

| 特性 | Listener | WaitSet |
|------|----------|---------|
| **执行线程** | DDS 内部线程 | 用户线程 |
| **实时性** | 最高（立即回调） | 高（等待后处理）|
| **阻塞性** | 非阻塞（回调不能耗时） | 阻塞（用户控制）|
| **复杂度** | 简单 | 稍复杂 |
| **适用场景** | 快速响应，简单处理 | 批量处理，复杂逻辑 |
| **可组合性** | 难 | 易（多个 Condition）|

---

## 🚀 运行示例

### 编译

```bash
cd ~/Documents/GitHub/Fast-DDS/examples/cpp/hello_world
mkdir build && cd build
cmake ..
make -j$(nproc)
```

### 运行

```bash
# 终端 1：启动 Subscriber
./hello_world subscriber

# 终端 2：启动 Publisher
./hello_world publisher
```

### 预期输出

**Subscriber**:
```
Subscriber running. Please press Ctrl+C to stop the Subscriber at any time.
Subscriber matched.
Message: 'Hello world' with index: '1' RECEIVED
Message: 'Hello world' with index: '2' RECEIVED
Message: 'Hello world' with index: '3' RECEIVED
...
```

**Publisher**:
```
Publisher running. Please press Ctrl+C to stop the Publisher at any time.
Publisher matched.
Message: 'Hello world' with index: '1' SENT
Message: 'Hello world' with index: '2' SENT
...
```

### 使用 WaitSet 版本

```bash
# Subscriber 使用 WaitSet
./hello_world subscriber --waitset
```

---

## 🧪 实验任务

### 实验 1：观察发现过程

1. 先启动 Publisher，等待 10 秒
2. 再启动 Subscriber
3. 观察 Publisher 是否在 Subscriber 启动后才开始发送数据

**结论**: DDS 的发现是动态的，Publisher 会等待 Subscriber 匹配后才发送

### 实验 2：修改 QoS

修改 `HelloWorldPublisher.xml`，尝试以下配置：

```xml
<!-- 修改可靠性为 BEST_EFFORT -->
<reliability>
    <kind>BEST_EFFORT</kind>
</reliability>

<!-- 修改历史为 KEEP_LAST，深度为 1 -->
<history>
    <kind>KEEP_LAST</kind>
    <depth>1</depth>
</history>
```

**观察**: 丢包率变化、Subscriber 是否能收到所有消息

### 实验 3：测试 Listener 阻塞

在 `on_data_available` 中添加 sleep：

```cpp
void on_data_available(DataReader* reader) override
{
    std::this_thread::sleep_for(std::chrono::seconds(5));  // 模拟耗时操作
    // ... 读取数据
}
```

**观察**: 是否会影响其他数据的接收？

**结论**: Listener 回调不能阻塞，否则会影响 DDS 内部线程

---

## 📚 与笔记关联

| 本示例概念 | 对应笔记 |
|-----------|---------|
| DomainParticipant | [01 RTPS源码分析](./01-RTPS-Source-Analysis.md#rtpsparticipant) |
| DataWriter/DataReader | [01 RTPS源码分析](./01-RTPS-Source-Analysis.md#rtpswriter--rtpsreader) |
| 发现机制 | [03 发现机制](./03-Discovery-Mechanism.md) |
| Listener/WaitSet | [10 监听与回调](./10-Listener-WaitSet.md) |
| QoS 配置 | [04 QoS实现](./04-QoS-Implementation.md) |
| TypeSupport | [02 类型系统](./02-DDS-Layer-Architecture.md#typesupport) |

---

## ✅ 学习检查清单

- [ ] 理解 DDS 实体创建顺序
- [ ] 理解数据类型注册流程
- [ ] 掌握 DataWriter::write() 用法
- [ ] 掌握 DataReader::take_next_sample() 用法
- [ ] 理解 Listener 回调机制
- [ ] 理解 WaitSet 等待机制
- [ ] 成功运行示例并观察输出
- [ ] 完成至少 1 个实验任务

---

## 🎓 进阶思考

1. **为什么 DataWriter::write() 是异步的？**
   - 数据先进入 WriterHistory 缓存
   - 由 DDS 内部线程负责实际网络发送
   - 可以实现批量发送优化

2. **如果 Subscriber 启动比 Publisher 晚，会丢失数据吗？**
   - 取决于 Durability QoS
   - TRANSIENT_LOCAL: Publisher 会保留历史，Subscriber 能收到
   - VOLATILE: Subscriber 只能收到之后的数据

3. **Listener 和 WaitSet 可以混用吗？**
   - 同一个 DataReader 不推荐混用
   - 不同 DataReader 可以分别使用
   - WaitSet 可以监听多个 Reader

---

_下一个示例：[RTPS 底层 API](./13-Example-02-RTPS.md)_
