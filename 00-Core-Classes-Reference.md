# Fast-DDS 核心类体系详解

**创建时间**: 2026-03-10  
**源码版本**: Fast-DDS 3.5.0  
**作者**: 旭旭助手

---

## 目录

1. [架构总览](#一架构总览)
2. [DDS Layer 核心类](#二dds-layer-核心类)
3. [RTPS Layer 核心类](#三rtps-layer-核心类)
4. [数据与缓存类](#四数据与缓存类)
5. [发现协议类](#五发现协议类)
6. [辅助与工具类](#六辅助与工具类)
7. [类关系图](#七类关系图)
8. [代码示例](#八代码示例)
9. [设计模式总结](#九设计模式总结)

---

## 一、架构总览

Fast-DDS 采用分层架构设计，主要分为三个层次：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Application Layer                                  │
│                     (用户应用程序代码)                                        │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              DDS Layer                                       │
│  ┌─────────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │DomainParticipant │  │  Publisher  │  │  Subscriber │  │      Topic      │  │
│  │     Factory      │  │             │  │             │  │                 │  │
│  └────────┬────────┘  └──────┬──────┘  └──────┬──────┘  └─────────────────┘  │
│           │                  │                │                              │
│           ▼                  ▼                ▼                              │
│  ┌─────────────────┐  ┌─────────────┐  ┌─────────────┐                       │
│  │DomainParticipant │  │ DataWriter  │  │ DataReader  │                       │
│  │                 │◀─┤             │  │             │                       │
│  └────────┬────────┘  └──────┬──────┘  └──────┬──────┘                       │
│           │                  │                │                              │
└───────────┼──────────────────┼────────────────┼──────────────────────────────┘
            │                  │                │
            │                  ▼                ▼
            │           ┌─────────────────────────────┐
            │           │   TypeSupport / TopicData   │
            │           └─────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              RTPS Layer                                      │
│  ┌─────────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │   RTPSDomain    │  │RTPSParticipant│  │ RTPSWriter  │  │  RTPSReader     │  │
│  │   (单例工厂)     │  │             │  │             │  │                 │  │
│  └────────┬────────┘  └──────┬──────┘  └──────┬──────┘  └────────┬────────┘  │
│           │                  │                │                   │         │
│           ▼                  ▼                ▼                   ▼         │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                     Endpoint (抽象基类)                                 │ │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐ │ │
│  │  │   RTPSWriter    │  │   RTPSReader    │  │   BuiltinProtocols      │ │ │
│  │  │  StatefulWriter │  │  StatefulReader │  │  (PDP/EDP)              │ │ │
│  │  │ StatelessWriter │  │ StatelessReader │  │                         │ │ │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────────────┘ │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Transport Layer                                    │
│              (UDP / TCP / Shared Memory / Zero Copy / SHM)                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 二、DDS Layer 核心类

### 2.1 DomainParticipantFactory - 域参与者工厂

| 属性 | 说明 |
|------|------|
| **设计模式** | 单例模式 (Singleton) |
| **头文件** | `include/fastdds/dds/domain/DomainParticipantFactory.hpp` |
| **职责** | 管理所有 DomainParticipant 的生命周期，提供统一的创建/删除接口 |

#### 核心成员变量

```cpp
class DomainParticipantFactory {
protected:
    // 参与者列表映射: domain_id -> vector<DomainParticipantImpl*>
    std::map<DomainId_t, std::vector<DomainParticipantImpl*>> participants_;
    
    // 工厂自身的 QoS 配置
    DomainParticipantFactoryQos factory_qos_;
    
    // 互斥锁保护 participants_ 的并发访问
    std::mutex mtx_participants_;
    
    // 配置是否已加载
    bool has_configuration_file_;
};
```

#### 核心成员函数

| 函数签名 | 作用说明 |
|---------|---------|
| `static DomainParticipantFactory* get_instance()` | 获取单例实例，线程安全 |
| `DomainParticipant* create_participant(DomainId_t did, const DomainParticipantQos& qos, DomainParticipantListener* listener, const StatusMask& mask)` | 创建 DomainParticipant |
| `ReturnCode_t delete_participant(DomainParticipant* part)` | 删除指定的 DomainParticipant |
| `DomainParticipant* lookup_participant(DomainId_t did)` | 查找指定 Domain 的参与者 |
| `ReturnCode_t load_profiles()` | 加载 XML 配置文件 |
| `ReturnCode_t get_qos(DomainParticipantFactoryQos& qos)` | 获取工厂 QoS |
| `ReturnCode_t set_qos(const DomainParticipantFactoryQos& qos)` | 设置工厂 QoS |

#### 使用示例

```cpp
// 1. 获取工厂单例
DomainParticipantFactory* factory = DomainParticipantFactory::get_instance();

// 2. 设置工厂 QoS (可选)
DomainParticipantFactoryQos factory_qos;
factory_qos.entity_factory().autoenable_created_entities = true;
factory->set_qos(factory_qos);

// 3. 创建 DomainParticipant
DomainParticipantQos participant_qos;
DomainParticipant* participant = factory->create_participant(
    0,                      // Domain ID = 0
    participant_qos,        // QoS 配置
    nullptr,                // Listener (可选)
    StatusMask::none()      // 监听的状态掩码
);
```

---

### 2.2 DomainParticipant - 域参与者

| 属性 | 说明 |
|------|------|
| **设计模式** | Pimpl (Pointer to Implementation) |
| **头文件** | `include/fastdds/dds/domain/DomainParticipant.hpp` |
| **职责** | DDS 应用程序的入口点，管理同一 Domain 内所有实体 |

#### 类层次关系

```
DomainParticipant (User Object - 用户直接操作)
└── DomainParticipantImpl (Implementation - 实际实现)
    ├── RTPSParticipant* rtps_participant_  (指向 RTPS 层)
    ├── std::map<Publisher*, PublisherImpl*> publishers_  (Publisher 列表)
    ├── std::map<Subscriber*, SubscriberImpl*> subscribers_ (Subscriber 列表)
    ├── std::map<std::string, TopicProxy*> topics_ (Topic 列表)
    └── BuiltinProtocols builtin_protocols_ (内置发现协议)
```

#### 核心成员变量

```cpp
class DomainParticipant : public Entity {
protected:
    DomainParticipantImpl* impl_;           // 实现类指针 (Pimpl 模式)
    DomainId_t domain_id_;                  // 所属 Domain ID
    DomainParticipantQos qos_;              // QoS 配置
    DomainParticipantListener* listener_;   // 监听器回调
    StatusMask mask_;                       // 状态监听掩码
    bool enabled_;                          // 是否已启用
};
```

#### 核心成员函数

**生命周期管理：**

| 函数 | 作用 |
|------|------|
| `enable()` | 启用参与者，开始发现过程 |
| `close()` | 关闭参与者，释放资源 |
| `get_status_changes()` | 获取状态变更 |
| `get_instance_handle()` | 获取实例句柄 |

**创建子实体：**

| 函数 | 作用 |
|------|------|
| `create_publisher(const PublisherQos& qos, PublisherListener* listener, const StatusMask& mask)` | 创建 Publisher |
| `create_subscriber(const SubscriberQos& qos, SubscriberListener* listener, const StatusMask& mask)` | 创建 Subscriber |
| `create_topic(const std::string& topic_name, const std::string& type_name, const TopicQos& qos, TopicListener* listener, const StatusMask& mask)` | 创建 Topic |
| `delete_publisher(Publisher* pub)` | 删除 Publisher |
| `delete_subscriber(Subscriber* sub)` | 删除 Subscriber |
| `delete_topic(Topic* topic)` | 删除 Topic |

**查询接口：**

| 函数 | 作用 |
|------|------|
| `get_rtps_participant()` | 获取底层 RTPSParticipant |
| `get_qos(DomainParticipantQos& qos)` / `set_qos(const DomainParticipantQos& qos)` | 获取/设置 QoS |
| `get_listener()` / `set_listener(DomainParticipantListener* listener)` | 获取/设置监听器 |
| `lookup_topicdescription(const std::string& topic_name)` | 查找 Topic |
| `get_discovered_participants(...)` | 获取已发现的参与者 |
| `get_discovered_participant_data(...)` | 获取参与者数据 |

#### 使用示例

```cpp
// 创建 Publisher
PublisherQos pub_qos;
Publisher* publisher = participant->create_publisher(
    pub_qos, nullptr, StatusMask::none()
);

// 创建 Topic
TopicQos topic_qos;
Topic* topic = participant->create_topic(
    "HelloWorldTopic",
    "HelloWorld",
    topic_qos,
    nullptr,
    StatusMask::none()
);

// 获取底层 RTPSParticipant
fastrtps::rtps::RTPSParticipant* rtps_part = participant->get_rtps_participant();
```

---

### 2.3 Publisher - 发布者

| 属性 | 说明 |
|------|------|
| **设计模式** | Pimpl 模式 |
| **头文件** | `include/fastdds/dds/publisher/Publisher.hpp` |
| **职责** | 管理 DataWriter 的集合，提供发布组策略和 QoS |

#### 核心成员变量

```cpp
class Publisher : public DomainEntity {
protected:
    PublisherImpl* impl_;                    // 实现类指针
    DomainParticipant* participant_;         // 所属 DomainParticipant
    PublisherQos qos_;                       // Publisher QoS
    PublisherListener* listener_;            // 监听器
    StatusMask mask_;                        // 状态监听掩码
    InstanceHandle_t handle_;                // 实例句柄
};
```

#### 核心成员函数

| 函数 | 作用 |
|------|------|
| `create_datawriter(Topic* topic, const DataWriterQos& qos, DataWriterListener* listener, const StatusMask& mask)` | 创建 DataWriter |
| `delete_datawriter(DataWriter* writer)` | 删除 DataWriter |
| `lookup_datawriter(const std::string& topic_name)` | 按 Topic 名称查找 DataWriter |
| `get_datawriters(...)` | 获取所有 DataWriters |
| `has_datawriters()` | 检查是否有 DataWriter |
| `wait_for_acknowledgments(const Duration_t& max_wait)` | 等待所有数据被确认 |
| `get_participant()` | 获取所属 DomainParticipant |
| `get_qos()` / `set_qos()` | 获取/设置 QoS |

---

### 2.4 Subscriber - 订阅者

| 属性 | 说明 |
|------|------|
| **设计模式** | Pimpl 模式 |
| **头文件** | `include/fastdds/dds/subscriber/Subscriber.hpp` |
| **职责** | 管理 DataReader 的集合，提供订阅组策略和 QoS |

#### 核心成员变量

```cpp
class Subscriber : public DomainEntity {
protected:
    SubscriberImpl* impl_;                   // 实现类指针
    DomainParticipant* participant_;         // 所属 DomainParticipant
    SubscriberQos qos_;                      // Subscriber QoS
    SubscriberListener* listener_;           // 监听器
    StatusMask mask_;                        // 状态监听掩码
    InstanceHandle_t handle_;                // 实例句柄
};
```

#### 核心成员函数

| 函数 | 作用 |
|------|------|
| `create_datawriter(TopicDescription* topic, const DataWriterQos& qos, DataWriterListener* listener, const StatusMask& mask)` | 创建 DataWriter |
| `delete_datawriter(DataWriter* writer)` | 删除 DataWriter |
| `lookup_datawriter(const std::string& topic_name)` | 按 Topic 名称查找 DataWriter |
| `get_datawriters(...)` | 获取所有 DataWriters |
| `has_datawriters()` | 检查是否有 DataWriter |
| `wait_for_acknowledgments(const Duration_t& max_wait)` | 等待所有数据被确认 |
| `get_participant()` | 获取所属 DomainParticipant |
| `get_qos()` / `set_qos()` | 获取/设置 QoS |

---

### 2.5 DataWriter - 数据写入器

| 属性 | 说明 |
|------|------|
| **设计模式** | 委托模式 (Delegate to RTPSWriter) |
| **头文件** | `include/fastdds/dds/publisher/DataWriter.hpp` |
| **职责** | 应用程序写入数据的接口，实际写操作委托给 RTPSWriter |

#### 类层次关系

```
DataWriter (DDS Layer - 用户 API)
└── DataWriterImpl (Implementation)
    ├── RTPSWriter* writer_              (底层 RTPSWriter)
    ├── TypeSupport type_support_        (数据类型支持)
    ├── Publisher* publisher_            (所属 Publisher)
    ├── Topic* topic_                    (关联 Topic)
    ├── DataWriterQos qos_               (QoS 配置)
    ├── DataWriterListener* listener_    (监听器)
    └── WriterHistory* history_          (发送历史缓存)
```

#### 核心成员变量

```cpp
class DataWriter : public DomainEntity {
protected:
    DataWriterImpl* impl_;                  // 实现类指针
    Publisher* publisher_;                  // 所属 Publisher
    Topic* topic_;                          // 关联 Topic
    DataWriterQos qos_;                     // QoS 配置
    DataWriterListener* listener_;          // 监听器
    StatusMask mask_;                       // 状态监听掩码
    RTPSWriter* rtps_writer_;               // 底层 RTPSWriter
};
```

#### 核心成员函数

**数据写入：**

| 函数 | 作用 |
|------|------|
| `write(void* data)` | 写入数据 |
| `write(void* data, const InstanceHandle_t& handle)` | 写入数据并指定实例 |
| `dispose(const InstanceHandle_t& handle)` | 标记实例为已删除 |
| `unregister_instance(const InstanceHandle_t& handle)` | 注销实例 |
| `dispose_w_timestamp(...)` / `unregister_instance_w_timestamp(...)` | 带时间戳的版本 |

**同步与确认：**

| 函数 | 作用 |
|------|------|
| `wait_for_acknowledgments(const Duration_t& max_wait)` | 等待数据被所有 Reader 确认 |
| `get_offered_deadline_missed_status(...)` | 获取 Deadline Missed 状态 |
| `get_offered_incompatible_qos_status(...)` | 获取 Incompatible QoS 状态 |
| `get_publication_matched_status(...)` | 获取匹配状态 |

**查询接口：**

| 函数 | 作用 |
|------|------|
| `get_guid()` | 获取 GUID |
| `get_topic()` | 获取关联 Topic |
| `get_publisher()` | 获取所属 Publisher |
| `get_qos()` / `set_qos()` | 获取/设置 QoS |
| `get_matched_subscriptions(...)` | 获取匹配的订阅者 |
| `get_matched_subscription_data(...)` | 获取匹配订阅者的数据 |

#### 使用示例

```cpp
// 创建 DataWriter
DataWriterQos writer_qos;
DataWriter* writer = publisher->create_datawriter(
    topic,
    writer_qos,
    nullptr,
    StatusMask::none()
);

// 写入数据
HelloWorld hello;
hello.message("Hello, Fast-DDS!");
writer->write(&hello);

// 等待确认 (Reliable QoS)
writer->wait_for_acknowledgments(Duration_t(10, 0));
```

---

### 2.6 DataReader - 数据读取器

| 属性 | 说明 |
|------|------|
| **设计模式** | 委托模式 (Delegate to RTPSReader) |
| **头文件** | `include/fastdds/dds/subscriber/DataReader.hpp` |
| **职责** | 应用程序读取数据的接口，实际读操作委托给 RTPSReader |

#### 类层次关系

```
DataReader (DDS Layer - 用户 API)
└── DataReaderImpl (Implementation)
    ├── RTPSReader* reader_              (底层 RTPSReader)
    ├── TypeSupport type_support_        (数据类型支持)
    ├── Subscriber* subscriber_          (所属 Subscriber)
    ├── TopicDescription* topic_         (关联 Topic)
    ├── DataReaderQos qos_               (QoS 配置)
    ├── DataReaderListener* listener_    (监听器)
    └── ReaderHistory* history_          (接收历史缓存)
```

#### 核心成员变量

```cpp
class DataReader : public DomainEntity {
protected:
    DataReaderImpl* impl_;                  // 实现类指针
    Subscriber* subscriber_;                // 所属 Subscriber
    TopicDescription* topic_;               // 关联 Topic
    DataReaderQos qos_;                     // QoS 配置
    DataReaderListener* listener_;          // 监听器
    StatusMask mask_;                       // 状态监听掩码
    RTPSReader* rtps_reader_;               // 底层 RTPSReader
};
```

#### 核心成员函数

**数据读取：**

| 函数 | 作用 |
|------|------|
| `take(void* data, SampleInfo* info)` | 读取并移除数据 |
| `take_next_sample(void* data, SampleInfo* info)` | 读取下一个样本 |
| `read(void* data, SampleInfo* info)` | 读取数据 (不移除) |
| `read_next_sample(void* data, SampleInfo* info)` | 读取下一个样本 (不移除) |
| `return_loan(void* data, SampleInfo* info)` | 归还借用的数据缓冲区 |
| `take_instance(...)` / `read_instance(...)` | 读取指定实例 |
| `take_next_instance(...)` / `read_next_instance(...)` | 读取下一个实例 |

**同步与等待：**

| 函数 | 作用 |
|------|------|
| `wait_for_historical_data(const Duration_t& max_wait)` | 等待历史数据 |
| `get_requested_deadline_missed_status(...)` | 获取 Deadline Missed 状态 |
| `get_requested_incompatible_qos_status(...)` | 获取 Incompatible QoS 状态 |
| `get_subscription_matched_status(...)` | 获取匹配状态 |
| `get_sample_lost_status(...)` | 获取样本丢失状态 |
| `get_sample_rejected_status(...)` | 获取样本拒绝状态 |
| `get_liveliness_changed_status(...)` | 获取活性变更状态 |

**查询接口：**

| 函数 | 作用 |
|------|------|
| `get_topicdescription()` | 获取 Topic 描述 |
| `get_subscriber()` | 获取所属 Subscriber |
| `get_qos()` / `set_qos()` | 获取/设置 QoS |
| `get_matched_publications(...)` | 获取匹配的发布者 |
| `get_matched_publication_data(...)` | 获取匹配发布者的数据 |

#### 使用示例

```cpp
// 创建 DataReader
DataReaderQos reader_qos;
DataReader* reader = subscriber->create_datareader(
    topic,
    reader_qos,
    nullptr,
    StatusMask::none()
);

// 读取数据
HelloWorld hello;
SampleInfo info;
if (reader->take_next_sample(&hello, &info) == ReturnCode_t::RETCODE_OK) {
    if (info.valid_data) {
        std::cout << "Received: " << hello.message() << std::endl;
    }
}
```

---

### 2.7 Topic / TopicDescription - 主题

| 属性 | 说明 |
|------|------|
| **设计模式** | 描述符模式 |
| **头文件** | `include/fastdds/dds/topic/Topic.hpp` |
| **职责** | 定义数据类型和 QoS，作为发布/订阅的纽带 |

#### 核心成员变量

```cpp
class Topic : public DomainEntity, public TopicDescription {
protected:
    TopicImpl* impl_;                        // 实现类指针
    DomainParticipant* participant_;         // 所属 DomainParticipant
    std::string topic_name_;                 // Topic 名称
    std::string type_name_;                  // 数据类型名称
    TopicQos qos_;                           // Topic QoS
    TopicListener* listener_;                // 监听器
    StatusMask mask_;                        // 状态监听掩码
};
```

#### 核心成员函数

| 函数 | 作用 |
|------|------|
| `get_name()` | 获取 Topic 名称 |
| `get_type_name()` | 获取类型名称 |
| `get_qos()` / `set_qos()` | 获取/设置 QoS |
| `get_participant()` | 获取所属 DomainParticipant |
| `get_inconsistent_topic_status(...)` | 获取不一致状态 |

---

## 三、RTPS Layer 核心类

### 3.1 RTPSDomain - RTPS 域管理器

| 属性 | 说明 |
|------|------|
| **设计模式** | 单例模式，纯静态方法 |
| **头文件** | `include/fastdds/rtps/RTPSDomain.hpp` |
| **职责** | 管理所有 RTPSParticipant 的生命周期 |

#### 核心成员函数

| 函数 | 作用 |
|------|------|
| `static RTPSParticipant* createParticipant(...)` | 创建 RTPSParticipant |
| `static RTPSWriter* createRTPSWriter(...)` | 创建 RTPSWriter |
| `static RTPSReader* createRTPSReader(...)` | 创建 RTPSReader |
| `static bool removeRTPSWriter(RTPSWriter* writer)` | 删除 RTPSWriter |
| `static bool removeRTPSReader(RTPSReader* reader)` | 删除 RTPSReader |
| `static bool removeRTPSParticipant(RTPSParticipant* part)` | 删除 RTPSParticipant |
| `static void stopAll()` | 关闭所有 RTPS 实体 |
| `static void setMaxRTPSParticipantId(uint32_t max_id)` | 设置最大参与者 ID |

---

### 3.2 RTPSParticipant - RTPS 参与者

| 属性 | 说明 |
|------|------|
| **设计模式** | Pimpl 模式 |
| **头文件** | `include/fastdds/rtps/participant/RTPSParticipant.hpp` |
| **职责** | RTPS 层的核心实体，管理 Writers/Readers，实现发现协议 |

#### 核心组件架构

```
RTPSParticipant
├── GuidPrefix_t m_guidPrefix                    // GUID 前缀
├── RTPSParticipantImpl* mp_impl                 // 实现类 (Pimpl)
│   ├── std::vector<RTPSWriter*> m_writers       // Writer 列表
│   ├── std::vector<RTPSReader*> m_readers       // Reader 列表
│   ├── BuiltinProtocols m_builtinProtocols      // 内置协议
│   │   ├── PDP* mp_PDP                          // 参与者发现协议
│   │   └── EDP* mp_EDP                          // 端点发现协议
│   ├── ResourceEvent mp_resourceEvent           // 资源事件循环
│   ├── MessageReceiver mp_receiver              // 消息接收器
│   └── std::vector<Locator> m_defaultLocators   // 传输地址
└── RTPSParticipantAttributes m_att              // 参与者属性
```

#### 核心成员函数

**生命周期管理：**

| 函数 | 作用 |
|------|------|
| `getGuid()` | 获取 GUID |
| `enable()` | 启用参与者 |
| `announceRTPSParticipantState()` | 强制宣告参与者状态 |

**Writer/Reader 管理：**

| 函数 | 作用 |
|------|------|
| `register_writer(RTPSWriter* writer, ...)` | 注册 Writer 到内置协议 |
| `register_reader(RTPSReader* reader, ...)` | 注册 Reader 到内置协议 |
| `unregister_writer(RTPSWriter* writer)` | 注销 Writer |
| `unregister_reader(RTPSReader* reader)` | 注销 Reader |
| `getWriters()` | 获取所有 Writers |
| `getReaders()` | 获取所有 Readers |

**发现相关：**

| 函数 | 作用 |
|------|------|
| `newRemoteWriterDiscovered(const GUID_t& pguid, int16_t userDefinedId)` | 发现新远程 Writer |
| `newRemoteReaderDiscovered(const GUID_t& pguid, int16_t userDefinedId)` | 发现新远程 Reader |
| `get_remote_writer_info(const GUID_t& writerGuid, ...)` | 获取远程 Writer 信息 |
| `get_remote_reader_info(const GUID_t& readerGuid, ...)` | 获取远程 Reader 信息 |

---

### 3.3 Endpoint - 端点基类

| 属性 | 说明 |
|------|------|
| **设计模式** | 抽象基类 |
| **头文件** | `include/fastdds/rtps/Endpoint.hpp` |
| **职责** | RTPSWriter 和 RTPSReader 的共同基类 |

#### 核心成员变量

```cpp
class Endpoint {
protected:
    RTPSParticipantImpl* mp_RTPSParticipant;      // 所属参与者实现
    const GUID_t m_guid;                          // 全局唯一标识符
    EndpointAttributes m_att;                     // 端点属性
    mutable RecursiveTimedMutex mp_mutex;         // 递归互斥锁 (线程安全)
};
```

#### 核心成员函数

| 函数 | 作用 |
|------|------|
| `getGuid()` | 获取 GUID |
| `getMutex()` | 获取互斥锁 (用于线程同步) |
| `getAttributes()` | 获取端点属性 |
| `getRTPSParticipant()` | 获取所属 RTPSParticipant |

---

### 3.4 RTPSWriter - RTPS 写入器

| 属性 | 说明 |
|------|------|
| **继承关系** | Endpoint ← RTPSWriter ← StatefulWriter / StatelessWriter |
| **头文件** | `include/fastdds/rtps/writer/RTPSWriter.hpp` |
| **职责** | 实际负责数据发送，管理发送历史和流控 |

#### 继承层次

```
Endpoint (基类)
└── RTPSWriter (抽象基类)
    ├── StatefulWriter (有状态，追踪每个 Reader 的状态)
    │   └── 维护 ReaderProxy 列表
    │   └── 支持 Reliable 传输
    └── StatelessWriter (无状态，不追踪 Reader)
        └── 支持 Best-Effort 传输
```

#### 核心成员变量

```cpp
class RTPSWriter : public Endpoint {
protected:
    WriterHistory* mp_history;                    // 发送历史缓存
    FlowController* mp_flowController;            // 流控器
    std::vector<Locator> m_locators;              // 发送地址列表
    uint32_t m_maxMessageSize;                    // 最大消息大小
    uint32_t m_fragmentSize;                      // 分片大小
    bool m_isReliable;                            // 是否可靠传输
    
    // StatefulWriter 特有
    std::vector<ReaderProxy*> m_matchedReaders;   // 匹配的 Reader 代理
};
```

#### 核心成员函数

**数据操作：**

| 函数 | 作用 |
|------|------|
| `new_change(const std::function<uint32_t()>& dataSizeCalculator, ChangeKind_t changeKind, InstanceHandle_t handle)` | 创建新的 CacheChange |
| `release_change(CacheChange_t* change)` | 释放 CacheChange |
| `send(CacheChange_t* change, ...)` | 发送单个变更 |
| `send(std::vector<CacheChange_t*>& changes, ...)` | 发送多个变更 |

**匹配管理：**

| 函数 | 作用 |
|------|------|
| `matched_reader_add(const ReaderProxyData& info)` | 添加匹配的 Reader |
| `matched_reader_remove(const GUID_t& readerGuid)` | 移除匹配的 Reader |
| `matched_reader_is_matched(const GUID_t& readerGuid)` | 检查是否已匹配 |
| `get_matched_readers(...)` | 获取匹配的 Readers |

**查询接口：**

| 函数 | 作用 |
|------|------|
| `getHistory()` | 获取 WriterHistory |
| `getFlowController()` | 获取流控器 |
| `is_reliable()` | 检查是否可靠传输 |
| `getMaxMessageSize()` | 获取最大消息大小 |

---

### 3.5 RTPSReader - RTPS 读取器

| 属性 | 说明 |
|------|------|
| **继承关系** | Endpoint ← RTPSReader ← StatefulReader / StatelessReader |
| **头文件** | `include/fastdds/rtps/reader/RTPSReader.hpp` |
| **职责** | 实际负责数据接收，管理接收历史和回调监听 |

#### 继承层次

```
Endpoint (基类)
└── RTPSReader (抽象基类)
    ├── StatefulReader (有状态，追踪每个 Writer 的状态)
    │   └── 维护 WriterProxy 列表
    │   └── 发送 ACK/NACK 反馈
    └── StatelessReader (无状态，不追踪 Writer)
        └── 不发送反馈
```

#### 核心成员变量

```cpp
class RTPSReader : public Endpoint {
protected:
    ReaderHistory* mp_history;                    // 接收历史缓存
    ReaderListener* mp_listener;                  // 监听器回调
    bool m_acceptMessagesToUnknownReaders;        // 是否接受未知 Reader 的消息
    bool m_acceptMessagesFromUnknownWriters;      // 是否接受未知 Writer 的消息
    
    // StatefulReader 特有
    std::vector<WriterProxy*> m_matchedWriters;   // 匹配的 Writer 代理
    ResourceEvent& mp_resourceEvent;              // 事件循环引用
};
```

#### 核心成员函数

**数据接收：**

| 函数 | 作用 |
|------|------|
| `read_next_cache_change(...)` | 读取下一个缓存变更 |
| `processDataMsg(...)` | 处理接收到的数据消息 |
| `processDataFragMsg(...)` | 处理分片数据消息 |
| `processHeartbeatMsg(...)` | 处理心跳消息 |
| `processGapMsg(...)` | 处理 Gap 消息 |

**匹配管理：**

| 函数 | 作用 |
|------|------|
| `matched_writer_add(const WriterProxyData& info)` | 添加匹配的 Writer |
| `matched_writer_remove(const GUID_t& writerGuid, ...)` | 移除匹配的 Writer |
| `matched_writer_is_matched(const GUID_t& writerGuid)` | 检查是否已匹配 |
| `get_matched_writers(...)` | 获取匹配的 Writers |

**回调机制：**

| 函数 | 作用 |
|------|------|
| `setListener(ReaderListener* listener)` | 设置监听器 |
| `getListener()` | 获取监听器 |

---

## 四、数据与缓存类

### 4.1 CacheChange_t - 缓存变更

| 属性 | 说明 |
|------|------|
| **头文件** | `include/fastdds/rtps/common/CacheChange.h` |
| **职责** | 表示一个数据样本的封装单元，是 RTPS 传输的基本单位 |

#### 核心成员变量

```cpp
struct CacheChange_t {
    ChangeKind_t kind;                    // 变更类型 (ALIVE, NOT_ALIVE_DISPOSED, etc.)
    GUID_t writerGUID;                    // 写入者 GUID
    InstanceHandle_t instanceHandle;      // 实例句柄
    SequenceNumber_t sequenceNumber;      // 序列号 (用于排序和重传)
    SerializedPayload_t serializedPayload; // 序列化后的数据负载
    Time_t sourceTimestamp;               // 源时间戳
    Time_t receptionTimestamp;            // 接收时间戳
    bool isRead;                          // 是否已被读取
    
    // 分片相关
    uint16_t fragmentStartingNum;         // 起始分片号
    uint16_t fragmentsInSubmessage;       // 子消息中的分片数
    FragmentNumberSet_t fragmentSnState;  // 分片状态
};
```

#### ChangeKind_t 枚举

```cpp
enum ChangeKind_t {
    ALIVE,                            // 正常数据
    NOT_ALIVE_DISPOSED,              // 实例被删除
    NOT_ALIVE_UNREGISTERED,          // 实例被注销
    NOT_ALIVE_DISPOSED_UNREGISTERED  // 既删除又注销
};
```

---

### 4.2 WriterHistory - 写入历史缓存

| 属性 | 说明 |
|------|------|
| **头文件** | `include/fastdds/rtps/history/WriterHistory.h` |
| **职责** | 管理 RTPSWriter 的发送历史缓存，实现 QoS 的 History 策略 |

#### 核心成员变量

```cpp
class WriterHistory : public History {
protected:
    RTPSWriter* mp_writer;                    // 关联的 Writer
    std::vector<CacheChange_t*> m_changes;    // 缓存变更列表
    HistoryAttributes m_att;                  // 历史缓存属性
    uint32_t m_poolSize;                      // 缓存池大小
};
```

#### 核心成员函数

| 函数 | 作用 |
|------|------|
| `add_change(CacheChange_t* change)` | 添加变更到历史 |
| `remove_change(CacheChange_t* change)` | 从历史中移除变更 |
| `remove_min_change()` | 移除最旧的变更 |
| `get_oldest_sample()` | 获取最旧的样本 |
| `get_min_available_changes_seq_num()` | 获取最小可用序列号 |

---

### 4.3 ReaderHistory - 读取历史缓存

| 属性 | 说明 |
|------|------|
| **头文件** | `include/fastdds/rtps/history/ReaderHistory.h` |
| **职责** | 管理 RTPSReader 的接收历史缓存 |

#### 核心成员变量

```cpp
class ReaderHistory : public History {
protected:
    RTPSReader* mp_reader;                    // 关联的 Reader
    std::vector<CacheChange_t*> m_changes;    // 缓存变更列表
    HistoryAttributes m_att;                  // 历史缓存属性
};
```

#### 核心成员函数

| 函数 | 作用 |
|------|------|
| `received_change(CacheChange_t* change, size_t sampleSize)` | 接收并存储变更 |
| `remove_change(CacheChange_t* change)` | 移除变更 |
| `remove_changes_with_guid(const GUID_t& guid)` | 移除指定 GUID 的所有变更 |
| `get_seq_num_min()` | 获取最小序列号 |
| `get_seq_num_max()` | 获取最大序列号 |
| `thereIsRecordOf(const SequenceNumber_t& seq, const GUID_t& guid)` | 检查是否有序列记录 |

---

### 4.4 GUID_t - 全局唯一标识符

| 属性 | 说明 |
|------|------|
| **头文件** | `include/fastdds/rtps/common/Guid.h` |
| **职责** | 唯一标识 RTPS 实体 (Participant, Writer, Reader) |

#### 结构定义

```cpp
struct GUID_t {
    GuidPrefix_t guidPrefix;      // 12 字节前缀 (标识 Participant)
    EntityId_t entityId;          // 4 字节实体 ID (标识 Writer/Reader)
};

// GuidPrefix_t: 12 字节
struct GuidPrefix_t {
    octet value[12];
};

// EntityId_t: 4 字节
struct EntityId_t {
    octet value[4];
};
```

#### 内置 EntityId

```cpp
// Participant
#define ENTITYID_PARTICIPANT 0x000001c1

// Writers (内置)
#define ENTITYID_SEDP_BUILTIN_PUBLICATIONS_WRITER 0x000003c2
#define ENTITYID_SEDP_BUILTIN_SUBSCRIPTIONS_WRITER 0x000004c2
#define ENTITYID_BUILTIN_PARTICIPANT_STATELESS_WRITER 0x000002c2
#define ENTITYID_BUILTIN_PARTICIPANT_VOLATILE_MESSAGE_WRITER 0x000002c3

// Readers (内置)
#define ENTITYID_SEDP_BUILTIN_PUBLICATIONS_READER 0x000003c7
#define ENTITYID_SEDP_BUILTIN_SUBSCRIPTIONS_READER 0x000004c7
#define ENTITYID_BUILTIN_PARTICIPANT_STATELESS_READER 0x000002c7
#define ENTITYID_BUILTIN_PARTICIPANT_VOLATILE_MESSAGE_READER 0x000002c3
```

---

## 五、发现协议类

### 5.1 PDP - 参与者发现协议 (Participant Discovery Protocol)

| 属性 | 说明 |
|------|------|
| **头文件** | `include/fastdds/rtps/builtin/discovery/participant/PDP.h` |
| **职责** | 发现网络中的其他参与者，维护参与者列表 |

#### 继承层次

```
PDP (抽象基类)
├── PDPSimple          // 标准 Simple PDP 实现
├── PDPServer          // Discovery Server 服务器模式
└── PDPClient          // Discovery Server 客户端模式
```

#### 核心成员变量

```cpp
class PDP {
protected:
    RTPSParticipantImpl* mp_RTPSParticipant;          // 所属参与者
    EDP* mp_EDP;                                      // 端点发现协议
    std::map<GUID_t, ParticipantProxyData*> m_participantProxies; // 参与者代理列表
    
    // 内置端点
    std::vector<WriterHistory*> m_writerHistory;      // 内置 Writer 历史
    std::vector<ReaderHistory*> m_readerHistory;      // 内置 Reader 历史
    
    Duration_t m_discovery_duration;                  // 发现周期
    Duration_t m_leaseDuration;                       // 租约时长
};
```

#### 核心成员函数

| 函数 | 作用 |
|------|------|
| `init(RTPSParticipantImpl* part)` | 初始化 PDP |
| `announceParticipantState()` | 宣告参与者状态 |
| `assertRemoteParticipantLiveliness(GUID_t& guid)` | 确认远程参与者活性 |
| `remove_remote_participant(GUID_t& guid, ...)` | 移除远程参与者 |
| `get_participant_proxy_data(const GUID_t& guid)` | 获取参与者代理数据 |

---

### 5.2 EDP - 端点发现协议 (Endpoint Discovery Protocol)

| 属性 | 说明 |
|------|------|
| **头文件** | `include/fastdds/rtps/builtin/discovery/endpoint/EDP.h` |
| **职责** | 发现 Writers 和 Readers，基于 Topic 和 QoS 进行匹配 |

#### 继承层次

```
EDP (抽象基类)
├── EDPSimple    // 动态发现
└── EDPStatic    // 静态配置 (通过 XML)
```

#### 核心成员变量

```cpp
class EDP {
protected:
    PDP* mp_PDP;                                      // 关联的 PDP
    RTPSParticipantImpl* mp_RTPSParticipant;          // 所属参与者
    
    // 内置端点
    WriterHistory* m_publicationsWriterHistory;       // 发布信息 Writer 历史
    ReaderHistory* m_publicationsReaderHistory;       // 发布信息 Reader 历史
    WriterHistory* m_subscriptionsWriterHistory;      // 订阅信息 Writer 历史
    ReaderHistory* m_subscriptionsReaderHistory;      // 订阅信息 Reader 历史
};
```

#### 核心成员函数

| 函数 | 作用 |
|------|------|
| `initEDP(...)` | 初始化 EDP |
| `newLocalWriterProxyData(RTPSWriter* writer, ...)` | 注册本地 Writer |
| `newLocalReaderProxyData(RTPSReader* reader, ...)` | 注册本地 Reader |
| `unpair(RTPSWriter* writer)` | 取消 Writer 配对 |
| `unpair(RTPSReader* reader)` | 取消 Reader 配对 |

---

## 六、辅助与工具类

### 6.1 Locator - 网络定位器

| 属性 | 说明 |
|------|------|
| **头文件** | `include/fastdds/rtps/common/Locator.h` |
| **职责** | 描述网络传输地址 (IP + Port) |

#### 核心成员变量

```cpp
struct Locator_t {
    int32_t kind;                     // 传输类型 (LOCATOR_KIND_UDPv4, etc.)
    uint32_t port;                    // 端口号
    octet address[16];                // IP 地址 (IPv4/IPv6)
};

// 常用 Kind 定义
#define LOCATOR_KIND_INVALID -1
#define LOCATOR_KIND_RESERVED 0
#define LOCATOR_KIND_UDPv4 1
#define LOCATOR_KIND_UDPv6 2
#define LOCATOR_KIND_TCPv4 4
#define LOCATOR_KIND_SHM 0x01000000    // 共享内存
```

---

### 6.2 SequenceNumber_t - 序列号

| 属性 | 说明 |
|------|------|
| **头文件** | `include/fastdds/rtps/common/SequenceNumber.h` |
| **职责** | 标识数据的顺序，用于可靠传输和去重 |

#### 核心成员变量

```cpp
struct SequenceNumber_t {
    int32_t high;                     // 高位
    uint32_t low;                     // 低位
};

// 特殊序列号
#define SEQUENCENUMBER_UNKNOWN {-1, 0}
```

---

### 6.3 SerializedPayload_t - 序列化负载

| 属性 | 说明 |
|------|------|
| **头文件** | `include/fastdds/rtps/common/SerializedPayload.h` |
| **职责** | 存储序列化后的数据 |

#### 核心成员变量

```cpp
struct SerializedPayload_t {
    uint16_t encapsulation;           // 封装格式 (CDR, PL_CDR, etc.)
    uint32_t length;                  // 数据长度
    octet* data;                      // 数据指针
    uint32_t max_size;                // 最大容量
    bool data_is_internal;            // 数据是否内部管理
};
```

---

## 七、类关系图

### 7.1 DDS Layer 完整类图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           DDS Layer                                          │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    DomainParticipantFactory                          │    │
│  │                      (Singleton 单例)                                 │    │
│  │                         get_instance()                                │    │
│  └─────────────────────────────────┬───────────────────────────────────┘    │
│                                    │                                         │
│                                    ▼                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                      DomainParticipant                               │    │
│  │                         (1 per Domain)                               │    │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐      │    │
│  │  │    Publisher    │  │    Subscriber   │  │      Topic      │      │    │
│  │  │    (0..n)       │  │     (0..n)      │  │     (0..n)      │      │    │
│  │  └────────┬────────┘  └────────┬────────┘  └─────────────────┘      │    │
│  │           │                    │                                     │    │
│  │           ▼                    ▼                                     │    │
│  │  ┌─────────────────┐  ┌─────────────────┐                            │    │
│  │  │   DataWriter    │  │   DataReader    │                            │    │
│  │  │    (0..n)       │  │    (0..n)       │                            │    │
│  │  └────────┬────────┘  └────────┬────────┘                            │    │
│  │           │                    │                                     │    │
│  │           └────────┬───────────┘                                     │    │
│  │                    │                                                  │    │
│  │                    ▼                                                  │    │
│  │           ┌─────────────────┐                                         │    │
│  │           │  TypeSupport    │                                         │    │
│  │           │  (Data Type)    │                                         │    │
│  │           └─────────────────┘                                         │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                    │                                         │
└────────────────────────────────────┼─────────────────────────────────────────┘
                                     │
                                     ▼
```

### 7.2 RTPS Layer 完整类图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           RTPS Layer                                         │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                         RTPSDomain                                   │    │
│  │                       (Singleton 单例)                                │    │
│  │    createParticipant() / createRTPSWriter() / createRTPSReader()     │    │
│  └─────────────────────────────────┬───────────────────────────────────┘    │
│                                    │                                         │
│                                    ▼                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                      RTPSParticipant                                 │    │
│  │                         (1 per Domain)                               │    │
│  │                                                                      │    │
│  │  ┌───────────────────────────────────────────────────────────────┐   │    │
│  │  │                   BuiltinProtocols                             │   │    │
│  │  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐   │   │    │
│  │  │  │     PDP     │  │     EDP     │  │    TypeLookup       │   │   │    │
│  │  │  │  (Simple/   │  │  (Simple/   │  │   (可选)            │   │   │    │
│  │  │  │   Server/   │  │   Static)   │  │                     │   │   │    │
│  │  │  │   Client)   │  │             │  │                     │   │   │    │
│  │  │  └─────────────┘  └─────────────┘  └─────────────────────┘   │   │    │
│  │  └───────────────────────────────────────────────────────────────┘   │    │
│  │                                                                      │    │
│  │  ┌───────────────────────────────────────────────────────────────┐   │    │
│  │  │                        Endpoint                                │   │    │
│  │  │                       (抽象基类)                                │   │    │
│  │  │                         m_guid                                 │   │    │
│  │  │                         mp_mutex                               │   │    │
│  │  └───────────────┬───────────────────────────────┬───────────────┘   │    │
│  │                  │                               │                   │    │
│  │                  ▼                               ▼                   │    │
│  │  ┌─────────────────────────────┐  ┌─────────────────────────────┐   │    │
│  │  │         RTPSWriter          │  │         RTPSReader          │   │    │
│  │  │         (抽象基类)           │  │         (抽象基类)           │   │    │
│  │  │  ┌───────────────────────┐  │  │  ┌───────────────────────┐  │   │    │
│  │  │  │   StatefulWriter      │  │  │  │   StatefulReader      │  │   │    │
│  │  │  │   (追踪 Reader 状态)   │  │  │  │   (追踪 Writer 状态)   │  │   │    │
│  │  │  │   - ReaderProxy 列表   │  │  │  │   - WriterProxy 列表   │  │   │    │
│  │  │  │   - 支持 Reliable     │  │  │  │   - 发送 ACK/NACK     │  │   │    │
│  │  │  └───────────────────────┘  │  │  └───────────────────────┘  │   │    │
│  │  │  ┌───────────────────────┐  │  │  ┌───────────────────────┐  │   │    │
│  │  │  │  StatelessWriter      │  │  │  │  StatelessReader      │  │   │    │
│  │  │  │  (不追踪状态)          │  │  │  │  (不追踪状态)          │  │   │    │
│  │  │  │  - 支持 Best-Effort   │  │  │  │  - 无反馈             │  │   │    │
│  │  │  └───────────────────────┘  │  │  └───────────────────────┘  │   │    │
│  │  └─────────────────────────────┘  └─────────────────────────────┘   │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 7.3 DDS 与 RTPS 映射关系

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    DDS Layer  ←→  RTPS Layer 映射                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌─────────────────────┐          ┌─────────────────────┐                  │
│   │ DomainParticipant   │ ←────→   │  RTPSParticipant    │  (1:1 映射)      │
│   │                     │          │                     │                  │
│   │  - create_publisher │          │  - register_writer  │                  │
│   │  - create_subscriber│          │  - register_reader  │                  │
│   │  - create_topic     │          │  - PDP / EDP        │                  │
│   └─────────────────────┘          └─────────────────────┘                  │
│                                                                              │
│   ┌─────────────────────┐          ┌─────────────────────┐                  │
│   │    DataWriter       │ ←────→   │    RTPSWriter       │  (1:1 映射)      │
│   │                     │          │                     │                  │
│   │  - write()          │   委托   │  - new_change()     │                  │
│   │  - dispose()        │  ─────→  │  - send()           │                  │
│   │  - wait_for_acks()  │          │  - matched_reader_* │                  │
│   └─────────────────────┘          └─────────────────────┘                  │
│                                                                              │
│   ┌─────────────────────┐          ┌─────────────────────┐                  │
│   │    DataReader       │ ←────→   │    RTPSReader       │  (1:1 映射)      │
│   │                     │          │                     │                  │
│   │  - take()           │   委托   │  - read_next_*()    │                  │
│   │  - read()           │  ←─────  │  - processDataMsg() │                  │
│   │  - return_loan()    │          │  - matched_writer_* │                  │
│   └─────────────────────┘          └─────────────────────┘                  │
│                                                                              │
│   ┌─────────────────────┐                                                   │
│   │    Publisher        │  (DDS 层特有，管理一组 DataWriters)               │
│   │    Subscriber       │  (DDS 层特有，管理一组 DataReaders)               │
│   │    Topic            │  (DDS 层特有，描述数据类型和 QoS)                 │
│   └─────────────────────┘                                                   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 八、代码示例

### 8.1 完整的发布者-订阅者示例

```cpp
// ==================== Publisher.cpp ====================
#include <fastdds/dds/domain/DomainParticipantFactory.hpp>
#include <fastdds/dds/domain/DomainParticipant.hpp>
#include <fastdds/dds/publisher/Publisher.hpp>
#include <fastdds/dds/publisher/DataWriter.hpp>
#include <fastdds/dds/publisher/DataWriterListener.hpp>
#include <fastdds/dds/topic/Topic.hpp>

using namespace eprosima::fastdds::dds;

class HelloWorldPublisher {
private:
    DomainParticipant* participant_;
    Publisher* publisher_;
    Topic* topic_;
    DataWriter* writer_;
    TypeSupport type_;

public:
    HelloWorldPublisher() : participant_(nullptr), publisher_(nullptr), 
                            topic_(nullptr), writer_(nullptr) {}

    bool init() {
        // 1. 创建 DomainParticipant
        DomainParticipantQos participant_qos;
        participant_ = DomainParticipantFactory::get_instance()->create_participant(
            0, participant_qos);
        if (participant_ == nullptr) return false;

        // 2. 注册数据类型
        type_ = TypeSupport(new HelloWorldPubSubType());
        type_.register_type(participant_);

        // 3. 创建 Topic
        topic_ = participant_->create_topic("HelloWorldTopic", "HelloWorld", TOPIC_QOS_DEFAULT);
        if (topic_ == nullptr) return false;

        // 4. 创建 Publisher
        publisher_ = participant_->create_publisher(PUBLISHER_QOS_DEFAULT, nullptr);
        if (publisher_ == nullptr) return false;

        // 5. 创建 DataWriter
        writer_ = publisher_->create_datawriter(topic_, DATAWRITER_QOS_DEFAULT, nullptr);
        if (writer_ == nullptr) return false;

        return true;
    }

    void publish(HelloWorld& hello) {
        writer_->write(&hello);
    }

    void run() {
        HelloWorld hello;
        hello.message("Hello Fast-DDS!");
        
        for (int i = 0; i < 10; ++i) {
            hello.index(i);
            publish(hello);
            std::this_thread::sleep_for(std::chrono::milliseconds(1000));
        }
    }
};
```

```cpp
// ==================== Subscriber.cpp ====================
#include <fastdds/dds/domain/DomainParticipantFactory.hpp>
#include <fastdds/dds/domain/DomainParticipant.hpp>
#include <fastdds/dds/subscriber/Subscriber.hpp>
#include <fastdds/dds/subscriber/DataReader.hpp>
#include <fastdds/dds/subscriber/DataReaderListener.hpp>
#include <fastdds/dds/subscriber/qos/DataReaderQos.hpp>
#include <fastdds/dds/subscriber/SampleInfo.hpp>

using namespace eprosima::fastdds::dds;

class HelloWorldSubscriber {
private:
    DomainParticipant* participant_;
    Subscriber* subscriber_;
    DataReader* reader_;
    Topic* topic_;
    TypeSupport type_;

    class SubListener : public DataReaderListener {
    public:
        void on_data_available(DataReader* reader) override {
            SampleInfo info;
            HelloWorld hello;
            if (reader->take_next_sample(&hello, &info) == ReturnCode_t::RETCODE_OK) {
                if (info.valid_data) {
                    std::cout << "Received: " << hello.message() 
                              << " [" << hello.index() << "]" << std::endl;
                }
            }
        }
    } listener_;

public:
    bool init() {
        // 1. 创建 DomainParticipant
        DomainParticipantQos participant_qos;
        participant_ = DomainParticipantFactory::get_instance()->create_participant(
            0, participant_qos);
        if (participant_ == nullptr) return false;

        // 2. 注册数据类型
        type_ = TypeSupport(new HelloWorldPubSubType());
        type_.register_type(participant_);

        // 3. 创建 Topic
        topic_ = participant_->create_topic("HelloWorldTopic", "HelloWorld", TOPIC_QOS_DEFAULT);
        if (topic_ == nullptr) return false;

        // 4. 创建 Subscriber
        subscriber_ = participant_->create_subscriber(SUBSCRIBER_QOS_DEFAULT, nullptr);
        if (subscriber_ == nullptr) return false;

        // 5. 创建 DataReader (带监听器)
        reader_ = subscriber_->create_datareader(topic_, DATAREADER_QOS_DEFAULT, &listener_);
        if (reader_ == nullptr) return false;

        return true;
    }

    void run() {
        std::cin.ignore();
    }
};
```

---

## 九、设计模式总结

| 设计模式 | 应用场景 | 具体实现 |
|---------|---------|---------|
| **单例模式** | 全局唯一实例管理 | `DomainParticipantFactory`, `RTPSDomain` |
| **工厂模式** | 创建复杂对象 | `create_participant()`, `createRTPSWriter()` |
| **Pimpl 模式** | 隐藏实现细节 | `DomainParticipant` → `DomainParticipantImpl`, `RTPSParticipant` → `RTPSParticipantImpl` |
| **委托模式** | DDS 层委托 RTPS 层 | `DataWriter` → `RTPSWriter`, `DataReader` → `RTPSReader` |
| **观察者模式** | 事件监听回调 | `DataWriterListener`, `DataReaderListener`, `DomainParticipantListener` |
| **桥接模式** | 抽象与实现分离 | DDS Layer 与 RTPS Layer 的分离 |
| **策略模式** | 可替换的算法 | `PDP` (Simple/Server/Client), `EDP` (Simple/Static) |
| **模板方法模式** | 算法骨架定义 | `Endpoint` 定义接口，`RTPSWriter`/`RTPSReader` 实现 |

---

## 十、总结

Fast-DDS 的类体系设计遵循以下原则：

1. **分层清晰**: DDS Layer 提供标准 API，RTPS Layer 处理底层通信
2. **职责单一**: 每个类只负责一个明确的功能领域
3. **可扩展性**: 通过抽象基类和策略模式支持多种实现
4. **线程安全**: 使用递归互斥锁保护共享状态
5. **资源管理**: 通过 History 和 FlowController 管理内存和带宽

理解这些核心类及其关系，是掌握 Fast-DDS 使用和调优的基础。

---

_文档版本: 1.0  
最后更新: 2026-03-10  
作者: 旭旭助手_