# 07 - Topic 详解

**来源**: 2026-03-05 笔记补充  
**整理时间**: 2026-03-17  
**字数**: 14,774 字（原文档精华）

---

## Topic 三要素

```
Topic = Topic Name + Data Type + QoS
```

| 要素 | 作用 | 示例 |
|------|------|------|
| **名称** | 标识数据通道 | "HelloWorldTopic" |
| **类型** | 数据结构定义 | HelloWorld.idl |
| **QoS** | 服务质量策略 | RELIABLE, KEEP_LAST |

---

## 创建与销毁流程

### 创建 Topic
```cpp
// 1. 注册数据类型
DomainParticipant* participant = ...;
TypeSupport type(new HelloWorldPubSubType());
type.register_type(participant, "HelloWorld");

// 2. 创建 Topic
Topic* topic = participant->create_topic(
    "HelloWorldTopic",  // 名称
    "HelloWorld",       // 类型名
    TOPIC_QOS_DEFAULT   // QoS
);
```

### 销毁 Topic
```cpp
participant->delete_topic(topic);
type.unregister_type(participant);
```

---

## TypeSupport 详解

TypeSupport 是 DDS 与具体数据类型的桥梁。

### 自动生成代码结构
```cpp
class HelloWorldPubSubType : public TopicDataType {
public:
    // 序列化: C++对象 → 字节流
    bool serialize(void* data, SerializedPayload_t* payload) override;
    
    // 反序列化: 字节流 → C++对象
    bool deserialize(SerializedPayload_t* payload, void* data) override;
    
    // 获取类型名
    std::string getName() override { return "HelloWorld"; }
    
    // 获取序列化大小
    uint32_t getSerializedSizeProvider(void* data) override;
    
    // 创建/删除数据实例
    void* createData() override;
    void deleteData(void* data) override;
};
```

### 生成工具
```bash
# 使用 fastddsgen 从 IDL 生成
fastddsgen -python HelloWorld.idl

# 生成文件:
# - HelloWorldPubSubType.cpp/h
# - HelloWorld.cpp/h
# - HelloWorld.i (Python 绑定)
```

---

## Writer/Reader 匹配机制

### 匹配条件
1. **Topic 名称相同**
2. **数据类型兼容**
3. **QoS 兼容**

### QoS 兼容性规则

| Writer QoS | Reader QoS | 结果 | 说明 |
|------------|------------|------|------|
| RELIABLE | RELIABLE | ✅ | 完全匹配 |
| RELIABLE | BEST_EFFORT | ❌ | 不匹配 |
| BEST_EFFORT | RELIABLE | ✅ | 降级匹配 |
| BEST_EFFORT | BEST_EFFORT | ✅ | 完全匹配 |
| VOLATILE | VOLATILE | ✅ | 完全匹配 |
| VOLATILE | TRANSIENT_LOCAL | ❌ | 不匹配 |
| TRANSIENT_LOCAL | VOLATILE | ✅ | 降级匹配 |

**核心规则**: Writer 提供的 QoS 必须**满足或超过** Reader 的要求。

### 匹配回调
```cpp
class PubListener : public PublisherListener {
public:
    void on_publication_matched(
        DataWriter* writer,
        const PublicationMatchedStatus& info) override {
        if (info.current_count_change > 0) {
            std::cout << "Writer 匹配了新的 Reader"
                      << info.last_subscription_handle << std::endl;
        }
    }
};
```

---

## 动态 Topic

### 场景
- 运行时创建新的数据类型
- 动态数据分发
- 与外部系统集成

### 使用 DynamicData
```cpp
#include <fastdds/dds/domain/DomainParticipant.hpp>
#include <fastdds/dds/topic/DynamicTopic.hpp>

// 创建动态类型
DynamicTypeBuilder_ptr builder = DynamicTypeBuilderFactory::get_instance()
    ->create_struct_builder();
builder->add_member(0, "id", DynamicTypeBuilderFactory::get_instance()
    ->create_int32_type());
builder->add_member(1, "message", DynamicTypeBuilderFactory::get_instance()
    ->create_string_type(255));

DynamicType_ptr type = builder->build();

// 注册并创建 Topic
TypeSupport type_support(new DynamicPubSubType(type));
type_support.register_type(participant);

Topic* topic = participant->create_topic("DynamicTopic", 
                                          type->get_name(), 
                                          TOPIC_QOS_DEFAULT);
```

---

## 最佳实践

### 1. Topic 命名规范
```
建议使用层级命名:
- Robot/Sensor/Lidar
- Robot/Actuator/Motor
- System/Status/Health
```

### 2. 类型版本管理
```
在类型名中包含版本:
- HelloWorld_v1
- HelloWorld_v2

或使用 namespace:
- MyApp::v1::HelloWorld
- MyApp::v2::HelloWorld
```

### 3. QoS 配置策略
```cpp
// 可靠传输配置
ReliabilityQosPolicy reliability;
reliability.kind = RELIABLE_RELIABILITY_QOS;

// 历史缓存配置
HistoryQosPolicy history;
history.kind = KEEP_LAST_HISTORY_QOS;
history.depth = 10;  // 保留最近10个样本
```

---

## 常见问题

### Q: 为什么 Writer 和 Reader 无法匹配？
**检查清单**:
1. ✅ Topic 名称完全相同（区分大小写）
2. ✅ 数据类型名相同
3. ✅ QoS 兼容（特别是 RELIABILITY）
4. ✅ 在同一个 Domain（域号相同）

### Q: 如何查看当前匹配的 Writer/Reader？
```cpp
// 在 Writer 端
PublicationMatchedStatus status;
writer->get_publication_matched_status(status);
std::cout << "匹配 Reader 数量: " << status.current_count << std::endl;

// 在 Reader端
SubscriptionMatchedStatus status;
reader->get_subscription_matched_status(status);
std::cout << "匹配 Writer 数量: " << status.current_count << std::endl;
```

---

_整理自 2026-03-05 Topic 详解笔记_
