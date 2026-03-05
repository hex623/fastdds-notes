# Fast-DDS Topic 详解

**文档编号**: 03B  
**难度**: ⭐⭐ 中级  
**前置知识**: [02-DDS-Layer-Architecture.md](./02-DDS-Layer-Architecture.md)

---

## 目录

1. [什么是 Topic](#什么是-topic)
2. [Topic 的核心组件](#topic-的核心组件)
3. [Topic 的创建与销毁](#topic-的创建与销毁)
4. [Topic 与数据类型的绑定](#topic-与数据类型的绑定)
5. [Topic 的 QoS 策略](#topic-的-qos-策略)
6. [Topic 与 Writer/Reader 的关系](#topic-与-writerreader-的关系)
7. [动态 Topic](#动态-topic)
8. [Topic 匹配机制](#topic-匹配机制)
9. [最佳实践](#最佳实践)
10. [代码示例](#代码示例)

---

## 什么是 Topic

### 概念理解

**Topic 是 DDS 中数据分发的逻辑通道**，可以理解为：
- **消息队列中的队列名称**
- **ROS 中的 topic 名称**
- **MQTT 中的主题**

**类比**：
```
电视频道类比：
- Topic = 频道名称 (如 "CCTV-1", "HBO")
- DataWriter = 电视台 (发送信号)
- DataReader = 电视机 (接收信号)
- 数据类型 = 视频格式 (如 4K, 1080p)

只有相同频道的电视才能收到对应的节目
```

### Topic 的三要素

```cpp
struct TopicDefinition {
    std::string name;           // Topic 名称 (唯一标识)
    std::string type_name;      // 数据类型名称
    TypeSupport type_support;   // 类型支持 (序列化/反序列化)
};
```

**示例**：
```cpp
TopicDefinition temperature_topic = {
    .name = "sensor/temperature",      // Topic 名称
    .type_name = "TemperatureData",    // 数据类型
    .type_support = TemperatureTypeSupport  // 类型支持
};
```

---

## Topic 的核心组件

### 1. Topic 类层次结构

```
DomainParticipant
    └── Topic (多个)
            ├── TopicDescription
            │       ├── name: "sensor/temp"
            │       └── type_name: "Temperature"
            │
            ├── TypeSupport
            │       ├── serialize()    // 序列化
            │       ├── deserialize()  // 反序列化
            │       └── get_type_name()
            │
            └── TopicListener (可选)
                    └── on_inconsistent_topic()  // 类型不一致回调
```

### 2. TopicDescription

**作用**：描述 Topic 的元数据

```cpp
// 获取 Topic 描述
TopicDescription* desc = topic->get_description();

// 获取信息
std::string name = desc->get_name();        // "sensor/temperature"
std::string type = desc->get_type_name();   // "TemperatureData"
```

### 3. TypeSupport

**核心职责**：
- **序列化**：将 C++ 对象转为字节流
- **反序列化**：将字节流转为 C++ 对象
- **类型注册**：向 DDS 注册数据类型

**示例**（HelloWorld）：
```cpp
// 定义数据类型
struct HelloWorld {
    uint32_t index;
    std::string message;
};

// 生成 TypeSupport (通过 Fast DDS-Gen 或手动)
class HelloWorldTypeSupport : public TypeSupport {
public:
    // 序列化
    bool serialize(void* data, SerializedPayload_t* payload) {
        HelloWorld* hw = static_cast<HelloWorld*>(data);
        // 将 index 和 message 写入 payload
        memcpy(payload->data, &hw->index, sizeof(uint32_t));
        memcpy(payload->data + 4, hw->message.c_str(), hw->message.length());
        return true;
    }
    
    // 反序列化
    bool deserialize(SerializedPayload_t* payload, void* data) {
        HelloWorld* hw = static_cast<HelloWorld*>(data);
        memcpy(&hw->index, payload->data, sizeof(uint32_t));
        hw->message = std::string((char*)payload->data + 4);
        return true;
    }
};
```

---

## Topic 的创建与销毁

### 创建流程

```cpp
// Step 1: 创建 Participant
DomainParticipant* participant = 
    DomainParticipantFactory::get_instance()->create_participant(0, PARTICIPANT_QOS_DEFAULT);

// Step 2: 注册数据类型
HelloWorldTypeSupport type_support;
type_support.register_type(participant);

// Step 3: 创建 Topic
Topic* topic = participant->create_topic(
    "HelloWorldTopic",           // Topic 名称
    "HelloWorld",                // 类型名称 (必须与 register_type 一致)
    TOPIC_QOS_DEFAULT            // QoS 配置
);

// 错误检查
if (topic == nullptr) {
    std::cerr << "Failed to create topic" << std::endl;
    return -1;
}
```

### 销毁流程

```cpp
// 销毁顺序：先 Writer/Reader，再 Topic，最后 Participant

// Step 1: 删除 Writer/Reader
participant->delete_datawriter(writer);
participant->delete_datareader(reader);

// Step 2: 删除 Topic
participant->delete_topic(topic);

// Step 3: 注销类型 (可选)
type_support.unregister_type(participant);

// Step 4: 删除 Participant
DomainParticipantFactory::get_instance()->delete_participant(participant);
```

**重要**：销毁顺序不能错，否则会导致内存泄漏或崩溃！

---

## Topic 与数据类型的绑定

### 方式一：Fast DDS-Gen 自动生成（推荐）

**步骤**：
```bash
# 1. 定义 IDL 文件
cat > HelloWorld.idl << 'EOF'
struct HelloWorld {
    unsigned long index;
    string message;
};
EOF

# 2. 使用 Fast DDS-Gen 生成代码
fastddsgen HelloWorld.idl

# 生成文件：
# - HelloWorld.h/cxx          (数据类型定义)
# - HelloWorldPubSubTypes.h/cxx  (TypeSupport 实现)
# - HelloWorldTypeObject.h/cxx   (类型对象)
```

**使用**：
```cpp
#include "HelloWorldPubSubTypes.h"

// 自动生成 HelloWorldPubSubType
HelloWorldPubSubType type_support;
participant->register_type(&type_support);

Topic* topic = participant->create_topic(
    "HelloWorldTopic",
    type_support.get_type_name(),  // 自动获取 "HelloWorld"
    TOPIC_QOS_DEFAULT
);
```

### 方式二：手动实现 TypeSupport

**适用场景**：
- 简单数据类型
- 需要自定义序列化逻辑
- 与第三方系统集成

**示例**：
```cpp
class RawBufferTypeSupport : public TypeSupport {
public:
    RawBufferTypeSupport() : TypeSupport() {
        set_name("RawBuffer");
    }
    
    bool serialize(void* data, SerializedPayload_t* payload) override {
        std::vector<uint8_t>* buffer = static_cast<std::vector<uint8_t>*>(data);
        payload->length = buffer->size();
        memcpy(payload->data, buffer->data(), buffer->size());
        return true;
    }
    
    bool deserialize(SerializedPayload_t* payload, void* data) override {
        std::vector<uint8_t>* buffer = static_cast<std::vector<uint8_t>*>(data);
        buffer->resize(payload->length);
        memcpy(buffer->data(), payload->data, payload->length);
        return true;
    }
};
```

---

## Topic 的 QoS 策略

### Topic 级别的 QoS

```cpp
TopicQos topic_qos;

// 1. 可靠性
topic_qos.reliability().kind = RELIABLE_RELIABILITY_QOS;
// 或 BEST_EFFORT_RELIABILITY_QOS (传感器数据)

// 2. 持久性
topic_qos.durability().kind = TRANSIENT_LOCAL_DURABILITY_QOS;
// 新订阅者能收到历史数据

// 3. 历史缓存
topic_qos.history().kind = KEEP_LAST_HISTORY_QOS;
topic_qos.history().depth = 10;  // 保留最近 10 条

// 4. 生命周期
topic_qos.lifespan().duration = {5, 0};  // 数据有效期 5 秒

// 5. 截止期限
topic_qos.deadline().period = {1, 0};  // 期望每秒发布一次

Topic* topic = participant->create_topic(
    "SensorData",
    "Sensor",
    topic_qos  // 使用自定义 QoS
);
```

### QoS 匹配规则

**重要**：Writer 和 Reader 的 QoS 必须兼容才能匹配！

```
匹配规则表：

Writer QoS        Reader QoS         是否匹配
─────────────────────────────────────────────────
RELIABLE          RELIABLE           ✅ 匹配
RELIABLE          BEST_EFFORT        ✅ 匹配 (降级)
BEST_EFFORT       RELIABLE           ❌ 不匹配
BEST_EFFORT       BEST_EFFORT        ✅ 匹配

KEEP_ALL          KEEP_LAST(depth=10) ❌ 不匹配 (writer 要求更多)
KEEP_LAST(10)     KEEP_LAST(5)       ✅ 匹配 (reader 接受更少)
```

**最佳实践**：Topic 上设置默认 QoS，Writer/Reader 可以覆盖。

---

## Topic 与 Writer/Reader 的关系

### 一对多关系

```
Topic: "sensor/temperature"
├── DataWriter (Publisher A)
├── DataWriter (Publisher B)
├── DataReader (Subscriber X)
└── DataReader (Subscriber Y)

多个 Writer 可以写入同一个 Topic
多个 Reader 可以从同一个 Topic 读取
```

### 创建 Writer/Reader 时绑定 Topic

```cpp
// 创建 Publisher
Publisher* publisher = participant->create_publisher(PUBLISHER_QOS_DEFAULT);

// 创建 DataWriter，绑定到 Topic
DataWriter* writer = publisher->create_datawriter(
    topic,                    // 绑定到已创建的 Topic
    DATAWRITER_QOS_DEFAULT,
    nullptr                   // Listener (可选)
);

// 同理创建 DataReader
Subscriber* subscriber = participant->create_subscriber(SUBSCRIBER_QOS_DEFAULT);
DataReader* reader = subscriber->create_datareader(
    topic,                    // 同一个 Topic
    DATAREADER_QOS_DEFAULT,
    nullptr
);
```

### 多 Writer 竞争

```cpp
// 多个 Writer 写入同一个 Topic
DataWriter* writer1 = publisher1->create_datawriter(topic, qos, nullptr);
DataWriter* writer2 = publisher2->create_datawriter(topic, qos, nullptr);

// 写入数据 (会竞争)
writer1->write(&data1);
writer2->write(&data2);

// Reader 会收到来自两个 Writer 的数据
```

**注意**：如果有多个 Writer，Reader 需要区分数据来源！

---

## 动态 Topic

### 场景：运行时创建 Topic

```cpp
class DynamicTopicManager {
public:
    // 根据配置动态创建 Topic
    Topic* create_topic_by_config(const std::string& topic_name, 
                                   const std::string& type_name) {
        // 检查是否已存在
        Topic* existing = participant->lookup_topicdescription(topic_name);
        if (existing != nullptr) {
            return static_cast<Topic*>(existing);
        }
        
        // 动态注册类型
        if (!is_type_registered(type_name)) {
            register_type_dynamically(type_name);
        }
        
        // 创建 Topic
        return participant->create_topic(topic_name, type_name, TOPIC_QOS_DEFAULT);
    }
};
```

### Topic 查找

```cpp
// 在 Domain 中查找 Topic
TopicDescription* desc = participant->lookup_topicdescription("HelloWorldTopic");
if (desc != nullptr) {
    Topic* topic = static_cast<Topic*>(desc);
    // 使用已存在的 Topic
}
```

---

## Topic 匹配机制

### 匹配条件

两个 Endpoint (Writer & Reader) 匹配的条件：

```cpp
bool match(WriterAttributes writer, ReaderAttributes reader) {
    // 1. Topic 名称必须相同
    if (writer.topic_name != reader.topic_name) return false;
    
    // 2. 数据类型必须兼容
    if (!types_compatible(writer.type, reader.type)) return false;
    
    // 3. QoS 必须兼容
    if (!qos_compatible(writer.qos, reader.qos)) return false;
    
    // 4. 分区匹配 (如果配置了分区)
    if (!partitions_intersect(writer.partitions, reader.partitions)) return false;
    
    return true;
}
```

### 监听匹配事件

```cpp
class MyWriterListener : public DataWriterListener {
public:
    void on_publication_matched(DataWriter* writer, 
                                 const PublicationMatchedStatus& info) override {
        if (info.current_count_change > 0) {
            std::cout << "New reader matched! Total: " << info.current_count << std::endl;
        } else {
            std::cout << "Reader disconnected" << std::endl;
        }
    }
};
```

---

## 最佳实践

### 1. Topic 命名规范

```cpp
// ✅ 好的命名：层次化、清晰
"sensor/temperature/living_room"
"robot/cmd_vel"
"system/log/error"

// ❌ 差的命名：模糊、易冲突
"temp"
"data"
"topic1"
```

### 2. 数据类型版本管理

```cpp
// 使用命名空间区分版本
struct SensorData_v1 { ... };
struct SensorData_v2 { ... };

// Topic 名称体现版本
"sensor/data/v1"
"sensor/data/v2"
```

### 3. Topic 生命周期管理

```cpp
// 使用智能指针模式管理 Topic 生命周期
class TopicManager {
    std::map<std::string, std::shared_ptr<TopicHandle>> topics;
    
public:
    std::shared_ptr<TopicHandle> get_or_create_topic(const std::string& name) {
        auto it = topics.find(name);
        if (it != topics.end()) {
            return it->second;  // 返回已存在的
        }
        
        // 创建新的
        auto topic = create_topic(name);
        topics[name] = topic;
        return topic;
    }
};
```

### 4. 监控和调试

```cpp
// 获取 Topic 统计信息
Topic* topic = ...;

// 打印 Topic 信息
std::cout << "Topic: " << topic->get_name() << std::endl;
std::cout << "Type: " << topic->get_type_name() << std::endl;

// 检查匹配的 Reader 数量
// (通过 WriterListener 的回调统计)
```

---

## 代码示例

### 完整示例：传感器数据发布

```cpp
#include <fastdds/dds/domain/DomainParticipantFactory.hpp>
#include <fastdds/dds/domain/DomainParticipant.hpp>
#include <fastdds/dds/topic/TypeSupport.hpp>
#include <fastdds/dds/publisher/Publisher.hpp>
#include <fastdds/dds/publisher/DataWriter.hpp>

using namespace eprosima::fastdds::dds;

// 1. 定义数据类型 (通过 IDL 生成或手动)
struct SensorData {
    uint32_t sensor_id;
    float temperature;
    float humidity;
    int64_t timestamp;
};

// 2. 主程序
int main() {
    // 创建 Participant
    DomainParticipant* participant = 
        DomainParticipantFactory::get_instance()->create_participant(
            0, PARTICIPANT_QOS_DEFAULT);
    
    // 注册类型
    SensorDataTypeSupport type_support;
    type_support.register_type(participant);
    
    // 创建 Topic (关键步骤)
    Topic* topic = participant->create_topic(
        "sensor/environment",        // Topic 名称
        type_support.get_type_name(), // 类型名称
        TOPIC_QOS_DEFAULT
    );
    
    if (topic == nullptr) {
        std::cerr << "Failed to create topic" << std::endl;
        return -1;
    }
    
    // 创建 Publisher
    Publisher* publisher = participant->create_publisher(
        PUBLISHER_QOS_DEFAULT, nullptr);
    
    // 创建 DataWriter (绑定到 Topic)
    DataWriter* writer = publisher->create_datawriter(
        topic,  // 绑定 Topic
        DATAWRITER_QOS_DEFAULT,
        nullptr
    );
    
    // 发布数据
    SensorData data;
    data.sensor_id = 1;
    data.temperature = 25.5;
    data.humidity = 60.0;
    data.timestamp = std::chrono::system_clock::now().time_since_epoch().count();
    
    writer->write(&data);
    
    // 清理
    participant->delete_datawriter(writer);
    participant->delete_publisher(publisher);
    participant->delete_topic(topic);
    DomainParticipantFactory::get_instance()->delete_participant(participant);
    
    return 0;
}
```

### 多 Topic 管理示例

```cpp
class MultiTopicPublisher {
    DomainParticipant* participant_;
    Publisher* publisher_;
    std::map<std::string, DataWriter*> writers_;
    
public:
    void init() {
        participant_ = DomainParticipantFactory::get_instance()
            ->create_participant(0, PARTICIPANT_QOS_DEFAULT);
        publisher_ = participant_->create_publisher(PUBLISHER_QOS_DEFAULT, nullptr);
    }
    
    template<typename T>
    void register_topic(const std::string& topic_name, TypeSupport* type) {
        type->register_type(participant_);
        
        Topic* topic = participant_->create_topic(
            topic_name, type->get_type_name(), TOPIC_QOS_DEFAULT);
        
        DataWriter* writer = publisher_->create_datawriter(
            topic, DATAWRITER_QOS_DEFAULT, nullptr);
        
        writers_[topic_name] = writer;
    }
    
    template<typename T>
    void publish(const std::string& topic_name, T* data) {
        auto it = writers_.find(topic_name);
        if (it != writers_.end()) {
            it->second->write(data);
        }
    }
};

// 使用
MultiTopicPublisher pub;
pub.init();
pub.register_topic<SensorData>("sensor/temp", &sensor_type);
pub.register_topic<ImageData>("camera/image", &image_type);

SensorData temp_data{...};
pub.publish("sensor/temp", &temp_data);
```

---

## 总结

### Topic 核心要点

1. **Topic 是数据通道**：名称 + 数据类型唯一标识
2. **必须先注册类型**：TypeSupport 负责序列化
3. **QoS 影响匹配**：Writer 和 Reader 的 QoS 必须兼容
4. **生命周期管理**：注意创建和销毁顺序
5. **支持动态创建**：运行时可以根据需要创建 Topic

### 常见错误

| 错误 | 原因 | 解决 |
|------|------|------|
| create_topic 返回 null | 类型未注册 | 先调用 register_type() |
| Writer/Reader 无法匹配 | Topic 名称不一致 | 检查字符串是否完全相同 |
| 类型不匹配错误 | 类型名称拼写错误 | 使用 type_support.get_type_name() |
| 内存泄漏 | 销毁顺序错误 | 先 Writer/Reader，再 Topic，最后 Participant |

### 学习路径

```
了解概念 → 创建 Topic → 绑定 Writer/Reader → 配置 QoS → 动态管理 → 性能优化
   ↑                                                               ↓
   └──────────────── 实践和调试 ← 监控和日志 ← 异常处理 ──────────┘
```

---

**相关文档**:
- [02-DDS-Layer-Architecture.md](./02-DDS-Layer-Architecture.md) - DDS 层架构
- [04-QoS-Implementation.md](./04-QoS-Implementation.md) - QoS 详解
- [13-Example-01-HelloWorld.md](./13-Example-01-HelloWorld.md) - 完整示例

**最后更新**: 2026-03-05  
**文档版本**: v1.0