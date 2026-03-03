# Fast-DDS DDS Layer 架构分析

## 目录

1. [概述](#1-概述)
2. [DDS 层与 RTPS 层的映射关系](#2-dds-层与-rtps-层的映射关系)
3. [核心类创建流程](#3-核心类创建流程)
   - 3.1 [DomainParticipant 创建流程](#31-domainparticipant-创建流程)
   - 3.2 [Publisher 创建流程](#32-publisher-创建流程)
   - 3.3 [Subscriber 创建流程](#33-subscriber-创建流程)
   - 3.4 [Topic 创建流程](#34-topic-创建流程)
   - 3.5 [DataWriter 创建流程](#35-datawriter-创建流程)
   - 3.6 [DataReader 创建流程](#36-datareader-创建流程)
4. [关键类分析](#4-关键类分析)
   - 4.1 [DomainParticipantFactory](#41-domainparticipantfactory)
   - 4.2 [DomainParticipantImpl](#42-domainparticipantimpl)
5. [设计模式](#5-设计模式)
   - 5.1 [工厂模式](#51-工厂模式)
   - 5.2 [观察者模式](#52-观察者模式)
   - 5.3 [桥接模式](#53-桥接模式)
6. [代码示例](#6-代码示例)
7. [总结](#7-总结)

---

## 1. 概述

Fast-DDS 是一个实现了 DDS (Data Distribution Service) 标准的实时发布订阅通信框架。其架构分为两个主要层次：

- **DDS Layer**: 提供标准化的 DDS API，符合 OMG DDS 规范
- **RTPS Layer**: 实现 RTPS (Real-Time Publish Subscribe) 协议，处理底层网络通信

DDS Layer 作为上层抽象，为应用程序提供了面向对象的接口；而 RTPS Layer 则负责实际的数据序列化、传输和发现机制。

### 架构层次图

```
┌─────────────────────────────────────────────────────────────┐
│                      Application Layer                       │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────┐   │
│  │                    DDS Layer                         │   │
│  │  ┌─────────────┐  ┌──────────┐  ┌────────────────┐  │   │
│  │  │DomainParticipant│  │ Publisher│  │   Subscriber   │  │   │
│  │  │   Factory    │  │          │  │                │  │   │
│  │  └─────────────┘  └────┬─────┘  └───────┬────────┘  │   │
│  │                        │                │           │   │
│  │                   ┌────┴────┐      ┌────┴────┐     │   │
│  │                   │DataWriter│      │DataReader│     │   │
│  │                   └────┬────┘      └────┬────┘     │   │
│  │                        │                │           │   │
│  │                   ┌────┴────────────────┴────┐     │   │
│  │                   │           Topic          │     │   │
│  │                   └──────────────────────────┘     │   │
│  └─────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────┐   │
│  │                    RTPS Layer                        │   │
│  │  ┌─────────────┐  ┌──────────┐  ┌────────────────┐  │   │
│  │  │RTPSParticipant│  │RTPSWriter│  │   RTPSReader   │  │   │
│  │  └─────────────┘  └────┬─────┘  └───────┬────────┘  │   │
│  │                        │                │           │   │
│  │              ┌─────────┴────────────────┴─────────┐ │   │
│  │              │       RTPSMessage Processing        │ │   │
│  │              │   (Serialization/Deserialization)   │ │   │
│  │              └─────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│                     Transport Layer                          │
│              (UDP/TCP/Shared Memory/SHM)                     │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. DDS 层与 RTPS 层的映射关系

DDS 层和 RTPS 层之间存在清晰的一对一映射关系：

| DDS Layer | RTPS Layer | 职责描述 |
|-----------|-----------|---------|
| `DomainParticipant` | `RTPSParticipant` | 域参与者，管理同一域内的所有实体 |
| `Publisher` | - | 发布者，管理 DataWriter 的集合 |
| `Subscriber` | - | 订阅者，管理 DataReader 的集合 |
| `DataWriter` | `RTPSWriter` | 数据写入器，负责发送数据 |
| `DataReader` | `RTPSReader` | 数据读取器，负责接收数据 |
| `Topic` | - | 主题，定义数据类型和 QoS |

### 映射关系架构图

```
                    DDS Layer                              RTPS Layer
    ┌──────────────────────────────────┐          ┌────────────────────────┐
    │      DomainParticipant           │─────────▶│    RTPSParticipant     │
    │  ┌──────────────────────────┐   │          │  ┌──────────────────┐  │
    │  │      Publisher           │   │          │  │   RTPSWriter     │  │
    │  │  ┌──────────────────┐   │   │          │  │  (Writer1...N)   │  │
    │  │  │   DataWriter     │───┼───┼──────────┼──▶│                  │  │
    │  │  └──────────────────┘   │   │          │  └──────────────────┘  │
    │  └──────────────────────────┘   │          │                        │
    │  ┌──────────────────────────┐   │          │  ┌──────────────────┐  │
    │  │      Subscriber          │   │          │  │   RTPSReader     │  │
    │  │  ┌──────────────────┐   │   │          │  │  (Reader1...N)   │  │
    │  │  │   DataReader     │───┼───┼──────────┼──▶│                  │  │
    │  │  └──────────────────┘   │   │          │  └──────────────────┘  │
    │  └──────────────────────────┘   │          │                        │
    │  ┌──────────────────────────┐   │          │  ┌──────────────────┐  │
    │  │        Topic             │   │          │  │   Type Support   │  │
    │  │   (Type + QoS Info)      │───┼──────────┼──▶│   (Serialized)   │  │
    │  └──────────────────────────┘   │          │  └──────────────────┘  │
    └──────────────────────────────────┘          └────────────────────────┘
```

### 关键映射点说明

1. **DomainParticipant ↔ RTPSParticipant**: 每个 DDS DomainParticipant 对应一个 RTPSParticipant，负责管理 RTPS 层的生命周期。

2. **DataWriter ↔ RTPSWriter**: DataWriter 内部持有 RTPSWriter 指针，实际写操作委托给 RTPSWriter。

3. **DataReader ↔ RTPSReader**: DataReader 内部持有 RTPSReader 指针，实际读操作委托给 RTPSReader。

4. **Topic 映射**: Topic 在 RTPS 层没有直接对应，其信息（类型名称、QoS）被用于创建 RTPSWriter/RTPSReader。

---

## 3. 核心类创建流程

### 3.1 DomainParticipant 创建流程

```
┌─────────────────┐     ┌─────────────────────────────┐     ┌──────────────────┐
│   Application   │────▶│DomainParticipantFactory::   │────▶│   DomainParticipant
│                 │     │   create_participant()      │     │    (User Object)
└─────────────────┘     └─────────────┬───────────────┘     └──────────────────┘
                                      │
                                      ▼
                        ┌─────────────────────────────┐
                        │   DomainParticipantImpl     │
                        │   (Implementation Object)   │
                        └─────────────┬───────────────┘
                                      │
                                      ▼
                        ┌─────────────────────────────┐
                        │  RTPSDomain::createParticipant│
                        │       (RTPS Layer)          │
                        └─────────────┬───────────────┘
                                      │
                                      ▼
                        ┌─────────────────────────────┐
                        │      RTPSParticipant        │
                        └─────────────────────────────┘
```

**创建流程详解：**

1. **获取工厂实例**: 通过 `DomainParticipantFactory::get_instance()` 获取单例工厂
2. **创建 DomainParticipant**: 调用工厂方法创建用户可见的 DomainParticipant 对象
3. **创建 DomainParticipantImpl**: 创建对应的实现类，负责实际逻辑
4. **创建 RTPSParticipant**: 调用 RTPSDomain 创建底层的 RTPSParticipant
5. **初始化回调**: 设置 RTPSParticipantListener 以接收发现事件

**核心代码路径** (`src/cpp/fastdds/domain/DomainParticipantFactory.cpp`):

```cpp
DomainParticipant* DomainParticipantFactory::create_participant(
    DomainId_t did,
    const DomainParticipantQos& qos,
    DomainParticipantListener* listener,
    const StatusMask& mask)
{
    // 1. 加载配置文件
    load_profiles();
    
    // 2. 创建用户可见的 DomainParticipant
    DomainParticipant* dom_part = new DomainParticipant(mask);
    
    // 3. 创建实现类 DomainParticipantImpl
    DomainParticipantImpl* dom_part_impl = new DomainParticipantImpl(
        dom_part, did, pqos, listener);
    
    // 4. 注册到工厂管理
    {
        std::lock_guard<std::mutex> guard(mtx_participants_);
        participants_[did].push_back(dom_part_impl);
    }
    
    // 5. 根据配置自动启用
    if (factory_qos_.entity_factory().autoenable_created_entities) {
        dom_part->enable();
    }
    
    return dom_part;
}
```

### 3.2 Publisher 创建流程

```
┌────────────────────┐     ┌───────────────────────────┐     ┌────────────────┐
│  DomainParticipant │────▶│DomainParticipantImpl::    │────▶│   Publisher    │
│                    │     │   create_publisher()      │     │ (User Object)  │
└────────────────────┘     └───────────┬───────────────┘     └────────────────┘
                                       │
                                       ▼
                         ┌───────────────────────────┐
                         │   PublisherImpl           │
                         │   (Implementation)        │
                         └───────────────────────────┘
```

**核心代码路径** (`src/cpp/fastdds/domain/DomainParticipantImpl.cpp`):

```cpp
Publisher* DomainParticipantImpl::create_publisher(
    const PublisherQos& qos,
    PublisherListener* listener,
    const StatusMask& mask)
{
    // 1. QoS 校验
    if (RETCODE_OK != PublisherImpl::check_qos(qos)) {
        return nullptr;
    }
    
    // 2. 创建 PublisherImpl
    PublisherImpl* pubimpl = create_publisher_impl(qos, listener);
    
    // 3. 创建用户可见的 Publisher
    Publisher* pub = new Publisher(pubimpl, mask);
    pubimpl->user_publisher_ = pub;
    pubimpl->rtps_participant_ = get_rtps_participant();
    
    // 4. 创建 InstanceHandle
    InstanceHandle_t pub_handle;
    create_instance_handle(pub_handle);
    pubimpl->handle_ = pub_handle;
    
    // 5. 注册到 DomainParticipant
    {
        std::lock_guard<std::mutex> lock(mtx_pubs_);
        publishers_by_handle_[pub_handle] = pub;
        publishers_[pub] = pubimpl;
    }
    
    // 6. 自动启用
    if (enabled && qos_.entity_factory().autoenable_created_entities) {
        pub->enable();
    }
    
    return pub;
}
```

### 3.3 Subscriber 创建流程

Subscriber 的创建流程与 Publisher 类似：

```cpp
Subscriber* DomainParticipantImpl::create_subscriber(
    const SubscriberQos& qos,
    SubscriberListener* listener,
    const StatusMask& mask)
{
    // 1. 创建 SubscriberImpl
    SubscriberImpl* subimpl = create_subscriber_impl(qos, listener);
    
    // 2. 创建用户可见的 Subscriber
    Subscriber* sub = new Subscriber(subimpl, mask);
    subimpl->user_subscriber_ = sub;
    subimpl->rtps_participant_ = get_rtps_participant();
    
    // 3. 创建 InstanceHandle
    InstanceHandle_t sub_handle;
    create_instance_handle(sub_handle);
    subimpl->handle_ = sub_handle;
    
    // 4. 注册到 DomainParticipant
    {
        std::lock_guard<std::mutex> lock(mtx_subs_);
        subscribers_by_handle_[sub_handle] = sub;
        subscribers_[sub] = subimpl;
    }
    
    // 5. 自动启用
    if (enabled && qos_.entity_factory().autoenable_created_entities) {
        sub->enable();
    }
    
    return sub;
}
```

### 3.4 Topic 创建流程

```
┌────────────────────┐     ┌───────────────────────────┐     ┌─────────────────┐
│  DomainParticipant │────▶│DomainParticipantImpl::    │────▶│  TopicProxy     │
│                    │     │   create_topic()          │     │  (User Object)  │
└────────────────────┘     └───────────┬───────────────┘     └─────────────────┘
                                       │
                                       ▼
                         ┌───────────────────────────┐
                         │   TopicProxyFactory       │
                         │   (Manages Topic lifecycle)│
                         └───────────┬───────────────┘
                                       │
                                       ▼
                         ┌───────────────────────────┐
                         │   TopicImpl               │
                         │   (Implementation)        │
                         └───────────────────────────┘
```

**核心代码** (`src/cpp/fastdds/domain/DomainParticipantImpl.cpp`):

```cpp
Topic* DomainParticipantImpl::create_topic(
    const std::string& topic_name,
    const std::string& type_name,
    const TopicQos& qos,
    TopicListener* listener,
    const StatusMask& mask)
{
    // 1. 查找类型注册
    TypeSupport type_support = find_type(type_name);
    if (type_support.empty()) {
        return nullptr;  // 类型未注册
    }
    
    // 2. QoS 校验（包括资源限制）
    if (RETCODE_OK != TopicImpl::check_qos_including_resource_limits(qos, type_support)) {
        return nullptr;
    }
    
    std::lock_guard<std::mutex> lock(mtx_topics_);
    
    // 3. 检查 Topic 是否已存在
    if (topics_.find(topic_name) != topics_.end()) {
        return nullptr;  // Topic 已存在
    }
    
    // 4. 创建 InstanceHandle
    InstanceHandle_t topic_handle;
    create_instance_handle(topic_handle);
    
    // 5. 创建 TopicProxyFactory 和 TopicProxy
    TopicProxyFactory* factory = new TopicProxyFactory(
        this, topic_name, type_name, mask, type_support, qos, listener);
    TopicProxy* proxy = factory->create_topic();
    Topic* topic = proxy->get_topic();
    topic->set_instance_handle(topic_handle);
    
    // 6. 注册到 DomainParticipant
    topics_by_handle_[topic_handle] = topic;
    topics_[topic_name] = factory;
    
    return topic;
}
```

### 3.5 DataWriter 创建流程

```
┌────────────────┐     ┌─────────────────────────────┐     ┌─────────────────┐
│   Publisher    │────▶│   PublisherImpl::           │────▶│    DataWriter   │
│                │     │   create_datawriter()       │     │  (User Object)  │
└────────────────┘     └─────────────┬───────────────┘     └─────────────────┘
                                     │
                                     ▼
                       ┌─────────────────────────────┐
                       │   DataWriterImpl            │
                       │   (Implementation)          │
                       └─────────────┬───────────────┘
                                     │
                                     ▼
                       ┌─────────────────────────────┐
                       │   RTPSWriter                │
                       │   (RTPS Layer)              │
                       └─────────────────────────────┘
```

**核心代码** (`src/cpp/fastdds/publisher/PublisherImpl.cpp`):

```cpp
DataWriter* PublisherImpl::create_datawriter(
    Topic* topic,
    const DataWriterQos& qos,
    DataWriterListener* listener,
    const StatusMask& mask,
    std::shared_ptr<fastdds::rtps::IPayloadPool> payload_pool)
{
    // 1. 查找类型支持
    TypeSupport type_support = participant_->find_type(topic->get_type_name());
    if (type_support.empty()) {
        return nullptr;  // 类型未注册
    }
    
    // 2. QoS 校验
    if (RETCODE_OK != DataWriterImpl::check_qos_including_resource_limits(qos, type_support)) {
        return nullptr;
    }
    
    // 3. 创建 DataWriterImpl
    DataWriterImpl* impl = create_datawriter_impl(type_support, topic, qos, listener, payload_pool);
    
    // 4. 增加 Topic 引用计数
    topic->get_impl()->reference();
    
    // 5. 创建用户可见的 DataWriter
    DataWriter* writer = new DataWriter(impl, mask);
    impl->user_datawriter_ = writer;
    
    // 6. 注册到 Publisher
    {
        std::lock_guard<std::mutex> lock(mtx_writers_);
        writers_[topic->get_name()].push_back(impl);
    }
    
    // 7. 自动启用
    if (user_publisher_->is_enabled() && qos_.entity_factory().autoenable_created_entities) {
        writer->enable();
    }
    
    return writer;
}
```

### 3.6 DataReader 创建流程

```
┌────────────────┐     ┌─────────────────────────────┐     ┌─────────────────┐
│   Subscriber   │────▶│  SubscriberImpl::           │────▶│    DataReader   │
│                │     │  create_datareader()        │     │  (User Object)  │
└────────────────┘     └─────────────┬───────────────┘     └─────────────────┘
                                     │
                                     ▼
                       ┌─────────────────────────────┐
                       │   DataReaderImpl            │
                       │   (Implementation)          │
                       └─────────────┬───────────────┘
                                     │
                                     ▼
                       ┌─────────────────────────────┐
                       │   RTPSReader                │
                       │   (RTPS Layer)              │
                       └─────────────────────────────┘
```

---

## 4. 关键类分析

### 4.1 DomainParticipantFactory

**类位置**: `include/fastdds/dds/domain/DomainParticipantFactory.hpp`  
**实现位置**: `src/cpp/fastdds/domain/DomainParticipantFactory.cpp`

**职责**: 
- 管理 DomainParticipant 的生命周期
- 维护所有 DomainParticipant 的注册表
- 提供单例访问点
- 加载和管理 XML 配置文件

**类定义**:

```cpp
class DomainParticipantFactory
{
public:
    // 单例访问
    static DomainParticipantFactory* get_instance();
    
    // DomainParticipant 创建
    DomainParticipant* create_participant(
        DomainId_t did,
        const DomainParticipantQos& qos,
        DomainParticipantListener* listener = nullptr,
        const StatusMask& mask = StatusMask::all());
    
    // DomainParticipant 删除
    ReturnCode_t delete_participant(DomainParticipant* part);
    
    // 查找 DomainParticipant
    DomainParticipant* lookup_participant(DomainId_t domain_id) const;
    std::vector<DomainParticipant*> lookup_participants(DomainId_t domain_id) const;
    
    // XML 配置加载
    ReturnCode_t load_XML_profiles_file(const std::string& xml_profile_file);
    ReturnCode_t load_XML_profiles_string(const char* data, size_t length);
    
    // 默认 QoS 管理
    ReturnCode_t get_default_participant_qos(DomainParticipantQos& qos) const;
    ReturnCode_t set_default_participant_qos(const DomainParticipantQos& qos);

protected:
    // 构造函数保护，防止外部实例化
    DomainParticipantFactory();
    ~DomainParticipantFactory();
    
    // 参与者映射: DomainID -> DomainParticipantImpl 列表
    std::map<DomainId_t, std::vector<DomainParticipantImpl*>> participants_;
    mutable std::mutex mtx_participants_;
    
    // 默认 QoS
    DomainParticipantQos default_participant_qos_;
    DomainParticipantFactoryQos factory_qos_;
    DomainId_t default_domain_id_;
    
    // XML 配置加载标志
    bool default_xml_profiles_loaded;
    std::mutex default_xml_profiles_loaded_mtx_;
};
```

**设计要点**:

1. **单例模式**: 使用 Meyer's Singleton 实现线程安全的单例
2. **工厂方法**: 负责创建 DomainParticipant 及其实现类
3. **参与者管理**: 使用 `std::map<DomainId_t, std::vector<DomainParticipantImpl*>>` 管理所有参与者
4. **线程安全**: 使用互斥锁保护参与者列表的并发访问

### 4.2 DomainParticipantImpl

**类位置**: `src/cpp/fastdds/domain/DomainParticipantImpl.hpp`

**职责**:
- 实现 DomainParticipant 的实际逻辑
- 管理 Publisher、Subscriber、Topic 的创建和生命周期
- 管理类型注册
- 与 RTPS 层交互

**核心数据结构**:

```cpp
class DomainParticipantImpl
{
protected:
    // 基础信息
    DomainId_t domain_id_;
    int32_t participant_id_ = -1;
    fastdds::rtps::GUID_t guid_;
    InstanceHandle_t handle_;
    DomainParticipantQos qos_;
    
    // RTPS 层引用
    fastdds::rtps::RTPSParticipant* rtps_participant_;
    
    // 用户对象引用
    DomainParticipant* participant_;
    DomainParticipantListener* listener_;
    
    // Publisher 管理
    std::map<Publisher*, PublisherImpl*> publishers_;
    std::map<InstanceHandle_t, Publisher*> publishers_by_handle_;
    mutable std::mutex mtx_pubs_;
    PublisherQos default_pub_qos_;
    
    // Subscriber 管理
    std::map<Subscriber*, SubscriberImpl*> subscribers_;
    std::map<InstanceHandle_t, Subscriber*> subscribers_by_handle_;
    mutable std::mutex mtx_subs_;
    SubscriberQos default_sub_qos_;
    
    // Topic 管理
    std::map<std::string, TopicProxyFactory*> topics_;
    std::map<InstanceHandle_t, Topic*> topics_by_handle_;
    std::map<std::string, std::unique_ptr<ContentFilteredTopic>> filtered_topics_;
    mutable std::mutex mtx_topics_;
    std::condition_variable cond_topics_;
    TopicQos default_topic_qos_;
    
    // 类型注册管理
    std::map<std::string, TypeSupport> types_;
    mutable std::mutex mtx_types_;
    
    // RTPS 监听器（用于接收发现事件）
    class MyRTPSParticipantListener : public fastdds::rtps::RTPSParticipantListener
    {
        // 实现发现回调：on_participant_discovery, on_reader_discovery, on_writer_discovery
    } rtps_listener_;
};
```

**关键方法分析**:

#### enable() - 启用 DomainParticipant

```cpp
ReturnCode_t DomainParticipantImpl::enable()
{
    // 1. 检查 QoS
    auto qos_check = check_qos(qos_);
    if (RETCODE_OK != qos_check) {
        return qos_check;
    }
    
    // 2. 转换 QoS 到 RTPS 属性
    fastdds::rtps::RTPSParticipantAttributes rtps_attr;
    utils::set_attributes_from_qos(rtps_attr, qos_);
    rtps_attr.participantID = participant_id_;
    
    // 3. 创建 RTPSParticipant
    RTPSParticipant* part = RTPSDomain::createParticipant(
        domain_id_, false, rtps_attr, &rtps_listener_);
    
    if (part == nullptr) {
        return RETCODE_ERROR;
    }
    
    // 4. 更新 GUID
    guid_ = part->getGuid();
    handle_ = guid_;
    rtps_participant_ = part;
    
    // 5. 设置类型检查回调
    part->set_check_type_function([this](const std::string& type_name) -> bool {
        return find_type(type_name).get() != nullptr;
    });
    
    // 6. 启用已创建的实体
    if (qos_.entity_factory().autoenable_created_entities) {
        // 启用 Topics
        for (auto topic : topics_) {
            topic.second->enable_topic();
        }
        // 启用 Publishers 和 Subscribers
        // ...
    }
    
    // 7. 启用 RTPSParticipant
    part->enable();
    
    return RETCODE_OK;
}
```

#### create_publisher() - 创建发布者

```cpp
Publisher* DomainParticipantImpl::create_publisher(
    const PublisherQos& qos,
    PublisherListener* listener,
    const StatusMask& mask)
{
    // 1. QoS 校验
    if (RETCODE_OK != PublisherImpl::check_qos(qos)) {
        return nullptr;
    }
    
    // 2. 创建 PublisherImpl（虚函数，可被子类重写）
    PublisherImpl* pubimpl = create_publisher_impl(qos, listener);
    
    // 3. 创建用户可见的 Publisher
    Publisher* pub = new Publisher(pubimpl, mask);
    pubimpl->user_publisher_ = pub;
    pubimpl->rtps_participant_ = get_rtps_participant();
    
    // 4. 创建 InstanceHandle
    InstanceHandle_t pub_handle;
    create_instance_handle(pub_handle);
    pubimpl->handle_ = pub_handle;
    
    // 5. 注册到管理映射
    {
        std::lock_guard<std::mutex> lock(mtx_pubs_);
        publishers_by_handle_[pub_handle] = pub;
        publishers_[pub] = pubimpl;
    }
    
    // 6. 自动启用
    if (enabled && qos_.entity_factory().autoenable_created_entities) {
        pub->enable();
    }
    
    return pub;
}
```

---

## 5. 设计模式

### 5.1 工厂模式

Fast-DDS 在多处使用工厂模式来创建对象：

#### DomainParticipantFactory - 单例工厂

```cpp
class DomainParticipantFactory
{
public:
    static DomainParticipantFactory* get_instance()
    {
        return get_shared_instance().get();
    }
    
    static std::shared_ptr<DomainParticipantFactory> get_shared_instance()
    {
        // Meyer's Singleton - 线程安全
        static std::shared_ptr<DomainParticipantFactory> instance(
            new DomainParticipantFactory(),
            [](DomainParticipantFactory* p) { delete p; });
        return instance;
    }
};
```

**优点**:
- 确保全局唯一的 DomainParticipantFactory 实例
- 控制 DomainParticipant 的创建过程
- 统一加载配置文件

#### 虚工厂方法 - 支持扩展

```cpp
class DomainParticipantImpl
{
protected:
    // 虚函数，允许子类（如统计模块）重写
    virtual PublisherImpl* create_publisher_impl(
        const PublisherQos& qos,
        PublisherListener* listener)
    {
        return new PublisherImpl(this, qos, listener);
    }
    
    virtual SubscriberImpl* create_subscriber_impl(
        const SubscriberQos& qos,
        SubscriberListener* listener)
    {
        return new SubscriberImpl(this, qos, listener);
    }
};
```

**应用场景**: 统计模块 (`statistics::dds::DomainParticipantImpl`) 继承并重写这些方法，创建统计专用的 Publisher/Subscriber。

### 5.2 观察者模式

Fast-DDS 使用观察者模式实现事件通知机制：

#### 监听器层次结构

```
                     ┌─────────────────────┐
                     │   Listener (Base)   │
                     └──────────┬──────────┘
                                │
           ┌────────────────────┼────────────────────┐
           │                    │                    │
    ┌──────▼──────┐    ┌────────▼────────┐  ┌───────▼────────┐
    │DomainParticipant│    │ PublisherListener│  │ SubscriberListener│
    │   Listener    │    │                 │  │                │
    └──────┬──────┘    └────────┬────────┘  └───────┬────────┘
           │                    │                    │
           │            ┌───────▼───────┐   ┌──────▼───────┐
           │            │ DataWriterListener│   │DataReaderListener│
           │            │                 │   │              │
           │            └───────────────┘   └──────────────┘
           │
    ┌──────▼──────────────────────────────────────┐
    │             MyRTPSParticipantListener        │
    │   (RTPSParticipantListener implementation)   │
    └─────────────────────────────────────────────┘
```

#### 实现示例

**PublisherImpl 中的监听器代理**:

```cpp
class PublisherImpl
{
protected:
    // Publisher 持有的监听器
    PublisherListener* listener_;
    
    // 内部 DataWriter 监听器，将事件代理给 Publisher 监听器
    class PublisherWriterListener : public DataWriterListener
    {
    public:
        PublisherWriterListener(PublisherImpl* p) : publisher_(p) {}
        
        void on_publication_matched(DataWriter* writer, const PublicationMatchedStatus& info) override
        {
            // 代理到 Publisher 的监听器
            if (publisher_->listener_ != nullptr) {
                publisher_->listener_->on_publication_matched(writer, info);
            }
        }
        
        void on_offered_deadline_missed(DataWriter* writer, const OfferedDeadlineMissedStatus& status) override
        {
            if (publisher_->listener_ != nullptr) {
                publisher_->listener_->on_offered_deadline_missed(writer, status);
            }
        }
        
        void on_liveliness_lost(DataWriter* writer, const LivelinessLostStatus& status) override
        {
            if (publisher_->listener_ != nullptr) {
                publisher_->listener_->on_liveliness_lost(writer, status);
            }
        }
        
        PublisherImpl* publisher_;
    } publisher_listener_;
};
```

**DomainParticipantImpl 中的 RTPS 监听器**:

```cpp
class DomainParticipantImpl
{
    class MyRTPSParticipantListener : public fastdds::rtps::RTPSParticipantListener
    {
    public:
        MyRTPSParticipantListener(DomainParticipantImpl* impl) : participant_(impl) {}
        
        // 发现新参与者
        void on_participant_discovery(
            RTPSParticipant* participant,
            ParticipantDiscoveryStatus reason,
            const ParticipantBuiltinTopicData& info,
            bool& should_be_ignored) override
        {
            // 转发到 DomainParticipantListener
            auto listener = participant_->get_listener_for(
                StatusMask::participant_discovery());
            if (listener != nullptr) {
                listener->on_participant_discovery(
                    participant_->get_participant(), reason, info, should_be_ignored);
            }
        }
        
        // 发现新 Reader
        void on_reader_discovery(
            RTPSParticipant* participant,
            ReaderDiscoveryStatus reason,
            const SubscriptionBuiltinTopicData& info,
            bool& should_be_ignored) override
        {
            // 转发到 DomainParticipantListener
            // ...
        }
        
        // 发现新 Writer
        void on_writer_discovery(
            RTPSParticipant* participant,
            WriterDiscoveryStatus reason,
            const PublicationBuiltinTopicData& info,
            bool& should_be_ignored) override
        {
            // 转发到 DomainParticipantListener
            // ...
        }
        
        DomainParticipantImpl* participant_;
        int callback_counter_ = 0;  // 用于线程安全的回调计数
    } rtps_listener_;
};
```

#### 线程安全处理

监听器回调使用 Sentry 模式确保线程安全：

```cpp
class MyRTPSParticipantListener : public RTPSParticipantListener
{
    struct Sentry
    {
        Sentry(MyRTPSParticipantListener* listener) 
            : listener_(listener), on_guard_(false)
        {
            std::lock_guard<std::mutex> _(listener_->participant_->mtx_gs_);
            if (listener_->callback_counter_ >= 0) {
                ++listener_->callback_counter_;
                on_guard_ = true;
            }
        }
        
        ~Sentry()
        {
            if (on_guard_) {
                bool notify = false;
                {
                    std::lock_guard<std::mutex> lock(listener_->participant_->mtx_gs_);
                    --listener_->callback_counter_;
                    notify = !listener_->callback_counter_;
                }
                if (notify) {
                    listener_->participant_->cv_gs_.notify_all();
                }
            }
        }
        
        MyRTPSParticipantListener* listener_;
        bool on_guard_;
    };
};
```

### 5.3 桥接模式

Fast-DDS 使用桥接模式将 DDS API 与具体实现分离：

```
    DDS API (抽象)              Implementation (实现)
    ┌───────────────┐           ┌───────────────────┐
    │DomainParticipant│◄────────│DomainParticipantImpl│
    │   - public    │           │   - implementation │
    │   interface   │           │   details          │
    └───────┬───────┘           └───────────────────┘
            │
    ┌───────▼───────┐           ┌───────────────────┐
    │   Publisher   │◄────────│   PublisherImpl    │
    └───────┬───────┘           └───────────────────┘
            │
    ┌───────▼───────┐           ┌───────────────────┐
    │  DataWriter   │◄────────│   DataWriterImpl   │
    └───────────────┘           └───────────────────┘
```

**实现示例**:

```cpp
// DDS API 层 - 仅提供接口
class DomainParticipant : public Entity
{
public:
    Publisher* create_publisher(const PublisherQos& qos, ...)
    {
        return impl_->create_publisher(qos, ...);  // 委托给实现
    }
    
    ReturnCode_t set_qos(const DomainParticipantQos& qos)
    {
        return impl_->set_qos(qos);  // 委托给实现
    }
    
protected:
    DomainParticipantImpl* impl_;  // 实现类指针
};

// 实现层 - 包含实际逻辑
class DomainParticipantImpl
{
public:
    Publisher* create_publisher(const PublisherQos& qos, ...);
    ReturnCode_t set_qos(const DomainParticipantQos& qos);
    
    // 实现细节...
    RTPSParticipant* rtps_participant_;
    std::map<Publisher*, PublisherImpl*> publishers_;
};
```

**优点**:
1. **分离接口与实现**: 用户代码仅依赖公共 API 头文件
2. **易于测试**: 可以 mock 实现类进行单元测试
3. **支持扩展**: 可以通过继承实现类添加功能（如统计模块）
4. **二进制兼容**: 实现细节改变不影响公共接口

---

## 6. 代码示例

### 完整 DDS 应用示例

```cpp
#include <fastdds/dds/domain/DomainParticipantFactory.hpp>
#include <fastdds/dds/domain/DomainParticipant.hpp>
#include <fastdds/dds/publisher/Publisher.hpp>
#include <fastdds/dds/publisher/DataWriter.hpp>
#include <fastdds/dds/subscriber/Subscriber.hpp>
#include <fastdds/dds/subscriber/DataReader.hpp>
#include <fastdds/dds/topic/Topic.hpp>

using namespace eprosima::fastdds::dds;

// 1. 定义数据类型（使用 IDL 生成）
class HelloWorldType : public TopicDataType
{
public:
    HelloWorldType() {
        set_name("HelloWorld");
        // 配置序列化/反序列化...
    }
    
    bool serialize(void* data, SerializedPayload_t* payload) override {
        // 实现序列化...
        return true;
    }
    
    bool deserialize(SerializedPayload_t* payload, void* data) override {
        // 实现反序列化...
        return true;
    }
};

// 2. 发布者应用
class PublisherApp
{
public:
    PublisherApp() : participant_(nullptr), publisher_(nullptr), 
                     topic_(nullptr), writer_(nullptr), type_(new HelloWorldType())
    {
    }
    
    bool init()
    {
        // 2.1 创建 DomainParticipant
        DomainParticipantQos participant_qos;
        participant_qos.name("PublisherParticipant");
        
        participant_ = DomainParticipantFactory::get_instance()->create_participant(
            0, participant_qos);
        if (participant_ == nullptr) {
            return false;
        }
        
        // 2.2 注册类型
        type_.register_type(participant_);
        
        // 2.3 创建 Topic
        TopicQos topic_qos;
        topic_ = participant_->create_topic("HelloWorldTopic", "HelloWorld", topic_qos);
        if (topic_ == nullptr) {
            return false;
        }
        
        // 2.4 创建 Publisher
        PublisherQos publisher_qos;
        publisher_ = participant_->create_publisher(publisher_qos, nullptr);
        if (publisher_ == nullptr) {
            return false;
        }
        
        // 2.5 创建 DataWriter
        DataWriterQos writer_qos;
        writer_qos.reliability().kind = RELIABLE_RELIABILITY_QOS;
        writer_qos.durability().kind = TRANSIENT_LOCAL_DURABILITY_QOS;
        
        writer_ = publisher_->create_datawriter(topic_, writer_qos, &listener_);
        if (writer_ == nullptr) {
            return false;
        }
        
        return true;
    }
    
    void publish(const std::string& message)
    {
        HelloWorld hello;
        hello.message(message);
        writer_->write(&hello);
    }
    
    void cleanup()
    {
        // 清理顺序：writer -> publisher -> topic -> participant
        if (writer_ != nullptr) {
            publisher_->delete_datawriter(writer_);
        }
        if (publisher_ != nullptr) {
            participant_->delete_publisher(publisher_);
        }
        if (topic_ != nullptr) {
            participant_->delete_topic(topic_);
        }
        if (participant_ != nullptr) {
            DomainParticipantFactory::get_instance()->delete_participant(participant_);
        }
    }

private:
    // 监听器示例
    class PubListener : public DataWriterListener
    {
    public:
        void on_publication_matched(DataWriter* writer, const PublicationMatchedStatus& info) override
        {
            if (info.current_count_change == 1) {
                std::cout << "Matched with a Subscriber!" << std::endl;
            } else if (info.current_count_change == -1) {
                std::cout << "Unmatched from a Subscriber!" << std::endl;
            }
        }
    };
    
    DomainParticipant* participant_;
    Publisher* publisher_;
    Topic* topic_;
    DataWriter* writer_;
    HelloWorldType type_;
    PubListener listener_;
};

// 3. 订阅者应用
class SubscriberApp
{
public:
    bool init()
    {
        // 类似发布者，创建 participant, subscriber, topic
        // ...
        
        // 创建 DataReader（带监听器）
        DataReaderQos reader_qos;
        reader_qos.reliability().kind = RELIABLE_RELIABILITY_QOS;
        
        reader_ = subscriber_->create_datareader(topic_, reader_qos, &listener_);
        
        return true;
    }

private:
    class SubListener : public DataReaderListener
    {
    public:
        void on_data_available(DataReader* reader) override
        {
            SampleInfo info;
            HelloWorld hello;
            
            if (reader->take_next_sample(&hello, &info) == ReturnCode_t::RETCODE_OK) {
                if (info.valid_data) {
                    std::cout << "Received: " << hello.message() << std::endl;
                }
            }
        }
        
        void on_subscription_matched(DataReader* reader, const SubscriptionMatchedStatus& info) override
        {
            if (info.current_count_change == 1) {
                std::cout << "Matched with a Publisher!" << std::endl;
            }
        }
    };
    
    DomainParticipant* participant_;
    Subscriber* subscriber_;
    Topic* topic_;
    DataReader* reader_;
    SubListener listener_;
};

// 4. 主函数
int main(int argc, char** argv)
{
    if (argc > 1 && std::string(argv[1]) == "publisher") {
        PublisherApp app;
        if (app.init()) {
            while (true) {
                app.publish("Hello, Fast-DDS!");
                std::this_thread::sleep_for(std::chrono::seconds(1));
            }
        }
    } else {
        SubscriberApp app;
        if (app.init()) {
            std::this_thread::sleep_for(std::chrono::seconds(60));
        }
    }
    
    return 0;
}
```

### 使用 XML 配置

```cpp
// 加载 XML 配置文件
DomainParticipantFactory::get_instance()->load_XML_profiles_file("profiles.xml");

// 使用配置文件创建 Participant
DomainParticipant* participant = 
    DomainParticipantFactory::get_instance()->create_participant_with_profile(
        "participant_profile");

// 使用配置文件创建 Publisher
Publisher* publisher = participant->create_publisher_with_profile("publisher_profile");

// 使用配置文件创建 DataWriter
DataWriter* writer = publisher->create_datawriter_with_profile(topic, "writer_profile");
```

---

## 7. 总结

Fast-DDS 的 DDS Layer 架构设计具有以下特点：

### 7.1 架构优势

1. **清晰的层次分离**: DDS Layer 提供标准 API，RTPS Layer 处理底层通信，职责明确
2. **桥接模式**: 接口与实现分离，便于测试和扩展
3. **工厂模式**: 统一的对象创建管理，支持配置文件加载
4. **观察者模式**: 灵活的事件通知机制，支持多级监听器代理

### 7.2 关键设计决策

1. **Impl 模式**: 每个 DDS 实体都有对应的 Impl 类，隐藏实现细节
2. **引用管理**: 使用 `reference()/dereference()` 管理 Topic 生命周期
3. **InstanceHandle**: 为每个实体分配唯一标识，支持 discovery
4. **自动启用**: 支持 `autoenable_created_entities` QoS 策略

### 7.3 性能考虑

1. **内存池**: DataWriter/DataReader 使用 IPayloadPool 管理内存
2. **零拷贝**: 支持 loan_sample() 实现零拷贝写操作
3. **批量处理**: RTPS Layer 支持批处理减少网络开销

### 7.4 扩展点

1. **自定义传输**: 可通过 Transport API 添加新传输层
2. **内容过滤**: 支持注册自定义 IContentFilterFactory
3. **类型系统**: 支持动态类型 (DynamicType) 和静态类型

---

*文档版本: 1.0*  
*基于 Fast-DDS 源码版本: 2.x*  
*最后更新: 2026-03-02*
