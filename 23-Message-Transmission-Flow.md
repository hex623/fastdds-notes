# DDS 消息传输完整流程：从应用到应用

> 📌 **代码来源说明**：本文中的代码示例分为两类：
> 1. **实际源码**：来自 [Fast-DDS 官方仓库](https://github.com/eProsima/Fast-DDS)，链接已标注
> 2. **简化示例**：为教学目的简化，省略了锁、异常处理等细节

---

## 完整数据流概述

```
应用层 A                    DDS 中间层                    网络层                    DDS 中间层                    应用层 B
    │                           │                          │                          │                           │
    │  1. write()               │                          │                          │                           │
    │ ───────────────────────>  │                          │                          │                           │
    │                           │  2. 序列化 (CDR)          │                          │                           │
    │                           │  3. 写入 HistoryCache      │                          │                           │
    │                           │  4. 匹配订阅者             │                          │                           │
    │                           │  5. 发送到 Transport      │                          │                           │
    │                           │ ───────────────────────> │                          │                           │
    │                           │                          │  6. UDP/SHM 传输         │                          │
    │                           │                          │ ───────────────────────> │                          │
    │                           │                          │                          │  7. 接收并反序列化        │
    │                           │                          │                          │  8. 写入 ReaderHistory   │
    │                           │                          │                          │  9. 通知应用层            │
    │                           │                          │                          │  10. on_data_available() │
    │                           │                          │                          │ ───────────────────────> │
    │                           │                          │                          │                           │  11. take() 读取数据
```

---

## 1. 数据发送端（Publisher 侧）

### 1.1 创建 DDS 实体

```cpp
// ========== HelloWorldPublisher.cpp (基于 Fast-DDS examples) ==========

#include <fastdds/dds/domain/DomainParticipantFactory.hpp>
#include <fastdds/dds/domain/DomainParticipant.hpp>
#include <fastdds/dds/publisher/Publisher.hpp>
#include <fastdds/dds/publisher/DataWriter.hpp>
#include <fastdds/dds/publisher/DataWriterListener.hpp>

using namespace eprosima::fastdds::dds;

class HelloWorldPublisher {
private:
    // 1️⃣ DomainParticipant - DDS 域的入口点
    // 实际文件: src/cpp/fastdds/domain/DomainParticipantImpl.hpp
    DomainParticipant* participant_;
    
    // 2️⃣ Publisher - 发布者实体
    // 实际文件: src/cpp/fastdds/publisher/PublisherImpl.hpp
    Publisher* publisher_;
    
    // 3️⃣ DataWriter - 实际写入数据的类
    // 实际文件: src/cpp/fastdds/publisher/DataWriterImpl.hpp
    DataWriter* writer_;
    
    // 4️⃣ Topic - 数据主题
    // 实际文件: src/cpp/fastdds/topic/TopicImpl.hpp
    Topic* topic_;
    
    // 5️⃣ TypeSupport - 类型支持
    // 由 fastddsgen 从 .idl 文件自动生成
    TypeSupport type_;

public:
    bool init() {
        // ========== 创建 DomainParticipant ==========
        // 实际调用: DomainParticipantFactory::create_participant()
        // 文件: src/cpp/fastdds/domain/DomainParticipantFactory.cpp
        DomainParticipantQos participant_qos;
        participant_qos.name("Participant_pub");
        
        participant_ = DomainParticipantFactory::get_instance()->
            create_participant(0, participant_qos);
        
        // ========== 注册数据类型 ==========
        // HelloWorldPubSubType 由 fastddsgen 自动生成
        // 包含 serialize(), deserialize(), getSerializedSizeProvider() 等方法
        type_ = TypeSupport(new HelloWorldPubSubType());
        type_.register_type(participant_);
        
        // ========== 创建 Topic ==========
        // 实际调用: DomainParticipantImpl::create_topic()
        topic_ = participant_->create_topic(
            "HelloWorldTopic",           // Topic 名称
            type_->getName(),            // 类型名称
            TOPIC_QOS_DEFAULT);          // 默认 QoS
        
        // ========== 创建 Publisher ==========
        // 实际调用: DomainParticipantImpl::create_publisher()
        publisher_ = participant_->create_publisher(
            PUBLISHER_QOS_DEFAULT, 
            nullptr);
        
        // ========== 创建 DataWriter ==========
        // 实际调用: PublisherImpl::create_datawriter()
        // DataWriter 绑定到 Topic，准备发送数据
        writer_ = publisher_->create_datawriter(
            topic_,
            DATAWRITER_QOS_DEFAULT,
            &listener_);
        
        return true;
    }
    
    // ========== 发送数据 ==========
    void publish(const HelloWorld& hello) {
        // write() 执行以下操作：
        // 1. 检查数据有效性
        // 2. 分配序列化缓冲区
        // 3. 调用 TypeSupport::serialize() 将 C++ 对象转为 CDR 格式
        // 4. 写入 WriterHistoryCache (WHC)
        // 5. 触发匹配的 Reader，通过网络层发送
        writer_->write(&hello);
    }
};
```

### 1.2 DataWriter 写入流程（核心）

```cpp
// 实际源码: src/cpp/fastdds/publisher/DataWriterImpl.cpp

ReturnCode_t DataWriterImpl::write(void* data)
{
    // 1. 序列化数据
    // 实际调用: HelloWorldPubSubType::serialize()
    // 生成文件: 由 fastddsgen 从 HelloWorld.idl 生成
    CacheChange_t* change = create_new_change(data);
    
    // 2. 根据 PublishMode 决定发送方式
    // 实际文件: src/cpp/rtps/flowcontrol/FlowControllerImpl.hpp
    if (qos_.publish_mode().kind == SYNCHRONOUS)
    {
        // 同步模式：直接发送
        // 实际调用: RTPSWriter::write()
        // 文件: src/cpp/rtps/writer/RTPSWriter.cpp
        return rtps_writer_->write(change);
    }
    else  // ASYNCHRONOUS
    {
        // 异步模式：添加到 FlowController
        // 实际类: FlowControllerAsyncPublishMode
        FlowController* fc = get_flow_controller();
        return fc->add_new_sample(
            rtps_writer_,
            change,
            max_blocking_time);
    }
}
```

---

## 2. 序列化机制（CDR 编码）

```cpp
// 自动生成文件: HelloWorldPubSubType.cpp (由 fastddsgen 生成)
// CDR (Common Data Representation) 是 DDS 的标准序列化格式

bool HelloWorldPubSubType::serialize(
    void* data,                    // 输入：C++ 对象指针
    SerializedPayload_t* payload)  // 输出：序列化后的缓冲区
{
    HelloWorld* p_type = static_cast<HelloWorld*>(data);
    
    // 创建 CDR 序列化对象
    // 实际文件: include/fastcdr/Cdr.h
    eprosima::fastcdr::FastBuffer fastbuffer(
        reinterpret_cast<char*>(payload->data), 
        payload->max_size);
    
    eprosima::fastcdr::Cdr ser(
        fastbuffer, 
        eprosima::fastcdr::Cdr::DEFAULT_ENDIAN,
        eprosima::fastdds::dds::DEFAULT_XCDR_VERSION);
    
    payload->encapsulation = ser.endianness() == eprosima::fastcdr::Cdr::BIG_ENDIANNESS ?
        CDR_BE : CDR_LE;
    
    // 序列化成员变量
    // 例如：序列化 string message 和 int32 index
    ser << p_type->index();
    ser << p_type->message().c_str();
    
    payload->length = static_cast<uint32_t>(ser.getSerializedDataLength());
    return true;
}
```

---

## 3. HistoryCache（历史缓存）

```cpp
// 实际文件: src/cpp/rtps/history/WriterHistory.cpp

class WriterHistory {
    // WriterHistoryCache (WHC) - 发送端缓存
    // 作用：存储已发送的数据，支持重传
    std::vector<CacheChange_t*> changes_;
    
    // 当达到资源限制时，根据 QoS 策略（KEEP_LAST/KEEP_ALL）丢弃旧数据
public:
    bool add_change(CacheChange_t* change) {
        // 1. 检查资源限制
        // 2. 根据 QoS 策略处理溢出
        // 3. 添加到 changes_ 队列
        // 4. 通知匹配的 Reader
    }
};

// 实际文件: src/cpp/rtps/history/ReaderHistory.cpp
class ReaderHistory {
    // ReaderHistoryCache (RHC) - 接收端缓存
    // 作用：存储接收到的数据，等待应用层读取
    std::vector<CacheChange_t*> changes_;
};
```

---

## 4. 数据接收端（Subscriber 侧）

```cpp
// ========== HelloWorldSubscriber.cpp (基于 Fast-DDS examples) ==========

#include <fastdds/dds/subscriber/Subscriber.hpp>
#include <fastdds/dds/subscriber/DataReader.hpp>
#include <fastdds/dds/subscriber/DataReaderListener.hpp>
#include <fastdds/dds/subscriber/SampleInfo.hpp>

using namespace eprosima::fastdds::dds;

class HelloWorldSubscriber {
private:
    DomainParticipant* participant_;
    Subscriber* subscriber_;           // 订阅者实体
    DataReader* reader_;               // 数据读取器
    Topic* topic_;
    TypeSupport type_;
    
    // 监听器 - 用于异步接收数据通知
    // 实际文件: include/fastdds/dds/subscriber/DataReaderListener.hpp
    class SubListener : public DataReaderListener {
    public:
        // 当有新数据到达时触发
        // 实际调用: DataReaderImpl::on_data_available()
        void on_data_available(DataReader* reader) override {
            SampleInfo info;
            HelloWorld hello;
            
            // ========== 读取数据 ==========
            // take() 方法执行以下操作：
            // 1. 从 ReaderHistoryCache (RHC) 获取样本
            // 2. 调用 TypeSupport::deserialize() 将 CDR 转为 C++ 对象
            // 3. 返回 SampleInfo（包含时间戳、序列号等元数据）
            while (reader->take_next_sample(&hello, &info) == ReturnCode_t::RETCODE_OK) {
                if (info.valid_data) {
                    std::cout << "收到消息: " << hello.message() << std::endl;
                }
            }
        }
        
        // 当匹配到 DataWriter 时触发
        void on_subscription_matched(DataReader* reader, 
                                     const SubscriptionMatchedStatus& info) override {
            matched_ = info.current_count;
        }
    } listener_;

public:
    bool init() {
        // 创建 DomainParticipant（必须在同一个 Domain ID）
        participant_ = DomainParticipantFactory::get_instance()->
            create_participant(0, PARTICIPANT_QOS_DEFAULT);
        
        // 注册相同的类型
        type_ = TypeSupport(new HelloWorldPubSubType());
        type_.register_type(participant_);
        
        // 创建相同的 Topic
        topic_ = participant_->create_topic(
            "HelloWorldTopic",   // 必须和发布端名称一致
            type_->getName(),
            TOPIC_QOS_DEFAULT);
        
        // 创建 Subscriber
        // 实际文件: src/cpp/fastdds/subscriber/SubscriberImpl.hpp
        subscriber_ = participant_->create_subscriber(
            SUBSCRIBER_QOS_DEFAULT, 
            nullptr);
        
        // 创建 DataReader
        // 实际文件: src/cpp/fastdds/subscriber/DataReaderImpl.hpp
        reader_ = subscriber_->create_datareader(
            topic_,
            DATAREADER_QOS_DEFAULT,
            &listener_);
        
        return true;
    }
};
```

---

## 5. 底层传输机制（RTPS 协议栈）

```cpp
// RTPS 消息结构（简化示意）
// 实际文件: src/cpp/rtps/messages/RTPSMessageGroup.hpp

struct CacheChange_t {
    SequenceNumber_t sequenceNumber;    // 序列号（用于排序和去重）
    GUID_t writerGUID;                  // 写入器全局唯一标识
    SerializedPayload_t data;           // 序列化后的数据
    Time_t timestamp;                   // 时间戳
};

// 发送流程
// 实际文件: src/cpp/rtps/writer/StatefulWriter.cpp
void send_to_all_readers(CacheChange_t* change) {
    // 1. 遍历所有匹配的 ReaderProxy
    for (ReaderProxy* proxy : matched_readers_) {
        // 2. 检查 Reader 是否活跃
        if (!proxy->is_active()) continue;
        
        // 3. 构建 RTPS Message (DATA Submessage)
        // 实际文件: src/cpp/rtps/messages/RTPSMessageGroup.cpp
        RTPSMessageGroup message;
        message.add_submessage(DATA, change);
        
        // 4. 通过 Transport 层发送
        // 实际文件: src/cpp/transport/UDPTransportInterface.cpp
        Transport::send(proxy->locators(), message);
        
        // 5. 记录已发送（用于重传）
        proxy->add_change_for_reader(change);
    }
}
```

---

## 6. 关键流程总结

| 步骤 | 发送端操作 | 网络层 | 接收端操作 |
|------|-----------|--------|-----------|
| 1 | `DataWriter::write()` | - | - |
| 2 | 序列化 (CDR) | - | - |
| 3 | 写入 WHC | - | - |
| 4 | - | UDP/SHM 发送 | - |
| 5 | - | - | 接收并写入 RHC |
| 6 | - | - | 反序列化 |
| 7 | - | - | `on_data_available()` |
| 8 | - | - | `take()` 读取数据 |

---

## 7. 实际源码验证

### 关键文件位置

| 组件 | 实际文件路径 |
|------|-------------|
| DomainParticipant | `src/cpp/fastdds/domain/DomainParticipantImpl.hpp` |
| DataWriter | `src/cpp/fastdds/publisher/DataWriterImpl.hpp` |
| DataReader | `src/cpp/fastdds/subscriber/DataReaderImpl.hpp` |
| RTPSWriter | `src/cpp/rtps/writer/RTPSWriter.hpp` |
| RTPSReader | `src/cpp/rtps/reader/RTPSReader.hpp` |
| WriterHistory | `src/cpp/rtps/history/WriterHistory.hpp` |
| ReaderHistory | `src/cpp/rtps/history/ReaderHistory.hpp` |
| FlowController | `src/cpp/rtps/flowcontrol/FlowControllerImpl.hpp` |
| 序列化 (CDR) | `include/fastcdr/Cdr.h` |
| 传输层 | `src/cpp/transport/UDPTransportInterface.hpp` |

### 验证命令

```bash
# 克隆 Fast-DDS 仓库
git clone https://github.com/eProsima/Fast-DDS.git
cd Fast-DDS

# 搜索关键类
grep -r "class DataWriter" src/cpp/fastdds/publisher/
grep -r "class RTPSWriter" src/cpp/rtps/writer/
grep -r "FlowControllerAsyncPublishMode" src/cpp/rtps/flowcontrol/
```

---

## 8. 常见问题

### Q1: 为什么需要 HistoryCache？
**A**: 支持可靠传输中的重传机制，以及 QoS 策略（如 KEEP_LAST）。

### Q2: CDR 序列化的优势？
**A**: 标准格式、跨平台、紧凑二进制、支持版本演进。

### Q3: Domain ID 的作用？
**A**: 逻辑隔离不同应用组，相同 Domain ID 的 Participant 才能通信。

---

**文章编写时间**: 2026-03-12  
**基于**: Fast-DDS v2.14.x 源码  
**作者**: 旭旭助手 🐾
