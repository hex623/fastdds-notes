# Fast-DDS QoS 策略实现详解

## 目录
1. [QoS 架构设计概述](#1-qos-架构设计概述)
2. [核心组件详解](#2-核心组件详解)
3. [关键 QoS 策略详解](#3-关键-qos-策略详解)
4. [QoS 兼容性检查机制](#4-qos-兼容性检查机制)
5. [代码示例](#5-代码示例)
6. [最佳实践](#6-最佳实践)

---

## 1. QoS 架构设计概述

Fast-DDS 的 QoS（Quality of Service，服务质量）系统是基于 DDS（Data Distribution Service）标准实现的，提供了丰富的策略来控制数据通信的行为。QoS 架构的核心设计目标是：

- **灵活性**：允许应用根据不同场景定制通信行为
- **可协商性**：发布者和订阅者之间可以协商兼容的 QoS 设置
- **可扩展性**：支持标准 DDS QoS 和厂商扩展 QoS

### 1.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                        QoS 架构层次                              │
├─────────────────────────────────────────────────────────────────┤
│  应用层 QoS  │  DataWriterQos / DataReaderQos / TopicQos        │
├─────────────────────────────────────────────────────────────────┤
│  策略层 QoS  │  DurabilityQosPolicy / ReliabilityQosPolicy ...   │
├─────────────────────────────────────────────────────────────────┤
│  参数层      │  Parameter_t (PID + length + value)              │
├─────────────────────────────────────────────────────────────────┤
│  传输层      │  CDRMessage (有线协议格式)                        │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 QoS 分类

| 分类 | 说明 | 代表策略 |
|------|------|----------|
| **标准 DDS QoS** | DDS 规范定义的标准策略 | Reliability, Durability, History |
| **XTypes 扩展** | DDS-XTypes 规范扩展 | DataRepresentation, TypeConsistency |
| **eProsima 扩展** | Fast-DDS 厂商特定扩展 | PublishMode, DataSharing, TransportConfig |

---

## 2. 核心组件详解

### 2.1 QosPolicy - 策略基类

所有 QoS 策略都继承自 `QosPolicy` 基类，定义位于 `include/fastdds/dds/core/policy/QosPolicies.hpp`：

```cpp
class QosPolicy
{
public:
    //! 标记 QoS 是否被修改过
    bool hasChanged;
    
    //! 构造函数
    explicit QosPolicy(bool send_always)
        : hasChanged(false)
        , send_always_(send_always)
    {
    }
    
    //! 是否总是发送（即使未修改）
    virtual bool send_always() const
    {
        return send_always_;
    }
    
    //! 清除/重置策略
    virtual inline void clear() = 0;

protected:
    bool send_always_;
};
```

**设计要点**：
- `hasChanged`：用于优化，避免发送未修改的 QoS
- `send_always_`：某些关键策略（如 Reliability）需要始终在发现阶段发送
- `clear()`：纯虚函数，子类必须实现重置逻辑

### 2.2 PolicyMask - 策略掩码

`PolicyMask` 用于高效表示一组 QoS 策略的状态，基于 `std::bitset` 实现：

```cpp
enum QosPolicyId_t : uint32_t
{
    INVALID_QOS_POLICY_ID = 0,
    USERDATA_QOS_POLICY_ID = 1,
    DURABILITY_QOS_POLICY_ID = 2,
    // ... 更多策略 ID
    RELIABILITY_QOS_POLICY_ID = 11,
    HISTORY_QOS_POLICY_ID = 13,
    LIVELINESS_QOS_POLICY_ID = 8,
    // ...
    NEXT_QOS_POLICY_ID  // 用于确定 bitset 大小
};

using PolicyMask = std::bitset<NEXT_QOS_POLICY_ID>;
```

**使用场景**：
- 标记不兼容的 QoS 策略集合
- 快速检查某个策略是否被设置
- 批量操作多个策略

### 2.3 ParameterList - 参数列表

`ParameterList` 负责 QoS 参数的序列化和反序列化，是 RTPS 协议实现的关键：

```cpp
class ParameterList
{
public:
    //! 将封装头写入 CDR 消息
    static bool writeEncapsulationToCDRMsg(rtps::CDRMessage_t* msg);
    
    //! 从 CDR 消息读取参数列表
    template<typename Pred>
    static bool readParameterListfromCDRMsg(
        rtps::CDRMessage_t& msg,
        Pred processor,
        bool use_encapsulation,
        uint32_t& qos_size);
    
    //! 从 Inline QoS 更新 CacheChange
    static bool updateCacheChangeFromInlineQos(
        rtps::CacheChange_t& change,
        rtps::CDRMessage_t* msg,
        uint32_t& qos_size);
};
```

**参数 ID（PID）定义**：

| PID | 值 | 对应策略 |
|-----|-----|----------|
| PID_DURABILITY | 0x001d | DurabilityQosPolicy |
| PID_RELIABILITY | 0x001a | ReliabilityQosPolicy |
| PID_HISTORY | 0x0040 | HistoryQosPolicy |
| PID_DEADLINE | 0x0023 | DeadlineQosPolicy |
| PID_LIVELINESS | 0x001b | LivelinessQosPolicy |
| PID_LIFESPAN | 0x002b | LifespanQosPolicy |

### 2.4 Parameter_t - 参数基类

所有参数的基类，定义了 PID 和长度：

```cpp
class Parameter_t
{
public:
    ParameterId_t Pid;    // 参数标识符
    uint16_t length;      // 参数数据长度
    
    Parameter_t(ParameterId_t pid, uint16_t length)
        : Pid(pid)
        , length(length)
    {
    }
};
```

---

## 3. 关键 QoS 策略详解

### 3.1 ReliabilityQosPolicy（可靠性策略）

**定义位置**：`include/fastdds/dds/core/policy/QosPolicies.hpp`

**作用**：控制数据传输的可靠性级别。

```cpp
typedef enum ReliabilityQosPolicyKind : fastdds::rtps::octet
{
    //! 尽力而为 - 不保证数据到达
    BEST_EFFORT_RELIABILITY_QOS = 0x01,
    
    //! 可靠传输 - 确保数据最终到达
    RELIABLE_RELIABILITY_QOS = 0x02
} ReliabilityQosPolicyKind;

class ReliabilityQosPolicy : public Parameter_t, public QosPolicy
{
public:
    ReliabilityQosPolicyKind kind;           // 可靠性类型
    fastdds::dds::Duration_t max_blocking_time;  // 最大阻塞时间（默认 100ms）
};
```

**特性对比**：

| 特性 | BEST_EFFORT | RELIABLE |
|------|-------------|----------|
| 数据确认 | 无 | 有（ACK/NACK） |
| 重传机制 | 无 | 有 |
| 延迟 | 低 | 较高 |
| 带宽占用 | 低 | 较高 |
| 适用场景 | 实时视频、传感器数据 | 关键命令、状态同步 |

**兼容性规则**：
- Writer(BEST_EFFORT) + Reader(RELIABLE) = **不兼容**
- Writer(RELIABLE) + Reader(BEST_EFFORT) = **兼容**
- 必须满足：Writer 提供的可靠性 ≥ Reader 要求的可靠性

### 3.2 DurabilityQosPolicy（持久性策略）

**作用**：控制数据在写入者生命周期结束后的保留行为。

```cpp
typedef enum DurabilityQosPolicyKind : fastdds::rtps::octet
{
    //! 数据不保留
    VOLATILE_DURABILITY_QOS,
    
    //! 数据保留在写入者内存中
    TRANSIENT_LOCAL_DURABILITY_QOS,
    
    //! 数据保留在服务内存中（需持久化服务）
    TRANSIENT_DURABILITY_QOS,
    
    //! 数据保留在永久存储中
    PERSISTENT_DURABILITY_QOS  // 当前版本不支持
} DurabilityQosPolicyKind_t;

class DurabilityQosPolicy : public Parameter_t, public QosPolicy
{
public:
    DurabilityQosPolicyKind_t kind;
    
    // 转换为 RTPS 层枚举
    inline fastdds::rtps::DurabilityKind_t durabilityKind() const;
};
```

**持久性级别排序**：
```
VOLATILE < TRANSIENT_LOCAL < TRANSIENT < PERSISTENT
```

**使用场景**：

| 策略 | 说明 | 适用场景 |
|------|------|----------|
| VOLATILE | 只发给当前在线的订阅者 | 实时流数据 |
| TRANSIENT_LOCAL | 新订阅者能获取历史数据 | 状态主题、配置数据 |
| TRANSIENT | 跨会话保留（需外部服务） | 关键状态恢复 |

**兼容性规则**：
- 必须满足：Writer 提供的持久性 ≥ Reader 要求的持久性
- Writer(VOLATILE) + Reader(TRANSIENT_LOCAL) = **不兼容**

### 3.3 HistoryQosPolicy（历史策略）

**作用**：控制实例数据的缓存行为。

```cpp
typedef enum HistoryQosPolicyKind : fastdds::rtps::octet
{
    //! 只保留最近的 N 个样本
    KEEP_LAST_HISTORY_QOS,
    
    //! 保留所有样本（直到资源限制）
    KEEP_ALL_HISTORY_QOS
} HistoryQosPolicyKind;

class HistoryQosPolicy : public Parameter_t, public QosPolicy
{
public:
    HistoryQosPolicyKind kind;  // 历史类型
    int32_t depth;              // 保留深度（仅 KEEP_LAST 有效）
};
```

**默认配置**：
- DataReader：KEEP_LAST，depth = 1
- DataWriter：KEEP_LAST，depth = 1

**与 ResourceLimits 的关系**：

```
总样本数 ≤ max_samples
单个实例样本数 ≤ max_samples_per_instance
实例数 ≤ max_instances

一致性约束：max_samples ≥ max_instances × max_samples_per_instance
```

### 3.4 DeadlineQosPolicy（截止期限策略）

**作用**：定义数据更新的最大允许间隔。

```cpp
class DeadlineQosPolicy : public Parameter_t, public QosPolicy
{
public:
    //! 数据更新的最大允许间隔
    fastdds::dds::Duration_t period;  // 默认：无限
};
```

**工作机制**：
- **Writer**：承诺每个实例至少每 `period` 时间更新一次
- **Reader**：期望每个实例至少每 `period` 时间收到一次更新
- **违约处理**：通过 Listener 回调通知应用层

**兼容性规则**：
- 必须满足：Writer.deadline.period ≤ Reader.deadline.period
- Writer 的截止期限必须比 Reader 的更严格（更短）

**与 TimeBasedFilter 的关系**：
- Reader 的 `minimum_separation` 必须 ≤ `deadline.period`
- 否则配置不一致

### 3.5 LifespanQosPolicy（生命周期策略）

**作用**：定义数据样本的有效期。

```cpp
class LifespanQosPolicy : public Parameter_t, public QosPolicy
{
public:
    //! 数据有效期
    fastdds::dds::Duration_t duration;  // 默认：无限
};
```

**工作机制**：
- 数据写入时开始计时
- 过期数据不会被发送给新订阅者
- 过期数据会从历史缓存中移除

**使用场景**：
- 传感器数据（只关心最新值）
- 限时有效的命令
- 周期性状态报告

### 3.6 LivelinessQosPolicy（活跃性策略）

**作用**：检测通信实体是否仍然活跃。

```cpp
typedef enum LivelinessQosPolicyKind : fastdds::rtps::octet
{
    //! 自动维护活跃性
    AUTOMATIC_LIVELINESS_QOS,
    
    //! 同一 Participant 内任一实体活跃即认为全部活跃
    MANUAL_BY_PARTICIPANT_LIVELINESS_QOS,
    
    //! 必须显式声明每个 Writer 的活跃性
    MANUAL_BY_TOPIC_LIVELINESS_QOS
} LivelinessQosPolicyKind;

class LivelinessQosPolicy : public Parameter_t, public QosPolicy
{
public:
    LivelinessQosPolicyKind kind;
    fastdds::dds::Duration_t lease_duration;       // 租约期限
    fastdds::dds::Duration_t announcement_period;  // 自动声明周期
};
```

**活跃性级别排序**：
```
AUTOMATIC < MANUAL_BY_PARTICIPANT < MANUAL_BY_TOPIC
```

**兼容性规则**：
1. Writer.kind ≥ Reader.kind
2. Writer.lease_duration ≤ Reader.lease_duration

**应用场景**：

| 模式 | 使用场景 |
|------|----------|
| AUTOMATIC | 常规数据发布，由中间件自动管理 |
| MANUAL_BY_PARTICIPANT | 一组相关 Writer 的集体活跃性管理 |
| MANUAL_BY_TOPIC | 需要精确控制每个 Topic 的活跃性 |

---

## 4. QoS 兼容性检查机制

### 4.1 匹配流程

QoS 兼容性检查在端点发现阶段（EDP）执行：

```
WriterProxyData ←→ ReaderProxyData
        ↓              ↓
    valid_matching()
        ↓
   检查各项 QoS 兼容性
        ↓
   生成 PolicyMask（标记不兼容项）
```

### 4.2 兼容性检查实现

核心代码位于 `src/cpp/rtps/builtin/discovery/endpoint/EDP.cpp`：

```cpp
bool EDP::valid_matching(
    const WriterProxyData* wdata,
    const ReaderProxyData* rdata,
    MatchingFailureMask& reason,
    fastdds::dds::PolicyMask& incompatible_qos)
{
    incompatible_qos.reset();
    
    // 1. Reliability 检查
    if (wdata->reliability.kind == dds::BEST_EFFORT_RELIABILITY_QOS
        && rdata->reliability.kind == dds::RELIABLE_RELIABILITY_QOS)
    {
        incompatible_qos.set(fastdds::dds::RELIABILITY_QOS_POLICY_ID);
    }
    
    // 2. Durability 检查
    if (wdata->durability.kind < rdata->durability.kind)
    {
        incompatible_qos.set(fastdds::dds::DURABILITY_QOS_POLICY_ID);
    }
    
    // 3. Ownership 检查
    if (wdata->ownership.kind != rdata->ownership.kind)
    {
        incompatible_qos.set(fastdds::dds::OWNERSHIP_QOS_POLICY_ID);
    }
    
    // 4. Deadline 检查
    if (wdata->deadline.period > rdata->deadline.period)
    {
        incompatible_qos.set(fastdds::dds::DEADLINE_QOS_POLICY_ID);
    }
    
    // 5. Liveliness 检查
    if (wdata->liveliness.lease_duration > rdata->liveliness.lease_duration)
    {
        incompatible_qos.set(fastdds::dds::LIVELINESS_QOS_POLICY_ID);
    }
    if (wdata->liveliness.kind < rdata->liveliness.kind)
    {
        incompatible_qos.set(fastdds::dds::LIVELINESS_QOS_POLICY_ID);
    }
    
    // 6. DataRepresentation 检查
    if (!checkDataRepresentationQos(wdata, rdata))
    {
        incompatible_qos.set(fastdds::dds::DATAREPRESENTATION_QOS_POLICY_ID);
    }
    
    // 存在不兼容策略时返回失败
    if (incompatible_qos.any())
    {
        reason.set(MatchingFailureMask::incompatible_qos);
        return false;
    }
    
    return true;
}
```

### 4.3 不兼容通知机制

当检测到 QoS 不兼容时，会触发以下通知：

```cpp
// Reader 侧
if (no_match_reason.test(MatchingFailureMask::incompatible_qos) 
    && reader->get_listener() != nullptr)
{
    reader->get_listener()->on_requested_incompatible_qos(reader, incompatible_qos);
    mp_PDP->notify_incompatible_qos_matching(R->getGuid(), wdatait->guid, incompatible_qos);
}

// Writer 侧
if (no_match_reason.test(MatchingFailureMask::incompatible_qos) 
    && writer->get_listener() != nullptr)
{
    writer->get_listener()->on_offered_incompatible_qos(writer, incompatible_qos);
    mp_PDP->notify_incompatible_qos_matching(W->getGuid(), rdatait->guid, incompatible_qos);
}
```

### 4.4 兼容性检查规则汇总

| QoS 策略 | 兼容性条件 | 说明 |
|----------|------------|------|
| **Reliability** | Writer ≥ Reader | Writer 可靠性不能低于 Reader 要求 |
| **Durability** | Writer ≥ Reader | Writer 持久性不能低于 Reader 要求 |
| **Ownership** | Writer == Reader | 必须完全相同 |
| **Deadline** | Writer.period ≤ Reader.period | Writer 更新频率必须更高 |
| **Liveliness** | Writer.kind ≥ Reader.kind<br>Writer.lease ≤ Reader.lease | 双重条件 |
| **DataRepresentation** | Writer.offered ⊆ Reader.requested | 提供的数据表示必须在请求列表中 |

---

## 5. 代码示例

### 5.1 配置 Reliability QoS

```cpp
#include <fastdds/dds/domain/DomainParticipantFactory.hpp>
#include <fastdds/dds/publisher/qos/DataWriterQos.hpp>
#include <fastdds/dds/subscriber/qos/DataReaderQos.hpp>

using namespace eprosima::fastdds::dds;

// 配置可靠传输的 Writer
void configure_reliable_writer(DataWriterQos& qos)
{
    // 设置为可靠传输
    qos.reliability().kind = RELIABLE_RELIABILITY_QOS;
    
    // 设置最大阻塞时间（write 操作可能阻塞）
    qos.reliability().max_blocking_time = Duration_t(0, 100000000);  // 100ms
    
    // 设置为总是发送该 QoS
    qos.reliability().send_always_ = true;
}

// 配置尽力而为传输的 Reader
void configure_best_effort_reader(DataReaderQos& qos)
{
    qos.reliability().kind = BEST_EFFORT_RELIABILITY_QOS;
}
```

### 5.2 配置 Durability QoS

```cpp
// 配置 TRANSIENT_LOCAL 持久性（适用于状态主题）
void configure_transient_local_qos(DataWriterQos& wqos, DataReaderQos& rqos)
{
    // Writer 配置
    wqos.durability().kind = TRANSIENT_LOCAL_DURABILITY_QOS;
    
    // Reader 配置
    rqos.durability().kind = TRANSIENT_LOCAL_DURABILITY_QOS;
    
    // 必须配合 History 使用
    wqos.history().kind = KEEP_LAST_HISTORY_QOS;
    wqos.history().depth = 10;  // 保留最近 10 个样本
    
    rqos.history().kind = KEEP_LAST_HISTORY_QOS;
    rqos.history().depth = 10;
    
    // 配置资源限制
    wqos.resource_limits().max_samples = 100;
    wqos.resource_limits().max_instances = 10;
    wqos.resource_limits().max_samples_per_instance = 10;
}
```

### 5.3 配置 Deadline QoS

```cpp
// 配置 1 秒截止期限
void configure_deadline_qos(DataWriterQos& wqos, DataReaderQos& rqos)
{
    // Writer：承诺每秒至少更新一次
    wqos.deadline().period = Duration_t(1, 0);  // 1秒
    
    // Reader：期望每秒至少收到一次
    rqos.deadline().period = Duration_t(1, 0);
    
    // 设置 Deadline 违约监听器
    class DeadlineListener : public DataWriterListener
    {
    public:
        void on_offered_deadline_missed(
            DataWriter* writer,
            const OfferedDeadlineMissedStatus& status) override
        {
            std::cout << "Deadline missed! Total count: " 
                      << status.total_count << std::endl;
        }
    };
}
```

### 5.4 配置 Liveliness QoS

```cpp
// 配置手动活跃性
void configure_manual_liveliness(DataWriterQos& qos)
{
    // 使用 MANUAL_BY_TOPIC 模式
    qos.liveliness().kind = MANUAL_BY_TOPIC_LIVELINESS_QOS;
    
    // 设置租约期限为 5 秒
    qos.liveliness().lease_duration = Duration_t(5, 0);
    
    // 应用层需要定期调用 assert_liveliness()
}

// 在应用中使用
void maintain_liveliness(DataWriter* writer)
{
    // 定期调用（频率应高于 lease_duration）
    writer->assert_liveliness();
}
```

### 5.5 完整的 Publisher/Subscriber QoS 配置

```cpp
#include <fastdds/dds/domain/DomainParticipant.hpp>
#include <fastdds/dds/publisher/Publisher.hpp>
#include <fastdds/dds/publisher/DataWriter.hpp>
#include <fastdds/dds/topic/Topic.hpp>

// 创建高性能实时传输配置
void configure_high_performance_qos(DataWriterQos& qos)
{
    // 使用尽力而为传输（最低延迟）
    qos.reliability().kind = BEST_EFFORT_RELIABILITY_QOS;
    
    // 不保留历史数据
    qos.durability().kind = VOLATILE_DURABILITY_QOS;
    
    // 只保留最新样本
    qos.history().kind = KEEP_LAST_HISTORY_QOS;
    qos.history().depth = 1;
    
    // 最小化资源分配
    qos.resource_limits().max_samples = 1;
    qos.resource_limits().max_instances = 1;
    qos.resource_limits().max_samples_per_instance = 1;
    
    // 数据快速过期（不缓存）
    qos.lifespan().duration = Duration_t(0, 100000000);  // 100ms
    
    // 使用异步发布模式（高吞吐场景）
    qos.publish_mode().kind = ASYNCHRONOUS_PUBLISH_MODE;
}

// 创建高可靠性传输配置
void configure_high_reliability_qos(DataWriterQos& qos)
{
    // 可靠传输
    qos.reliability().kind = RELIABLE_RELIABILITY_QOS;
    qos.reliability().max_blocking_time = Duration_t(1, 0);  // 1秒
    
    // 本地持久化
    qos.durability().kind = TRANSIENT_LOCAL_DURABILITY_QOS;
    
    // 保留所有历史
    qos.history().kind = KEEP_ALL_HISTORY_QOS;
    
    // 充足的资源限制
    qos.resource_limits().max_samples = 1000;
    qos.resource_limits().max_instances = 100;
    qos.resource_limits().max_samples_per_instance = 10;
    
    // 可靠 Writer 参数调优
    qos.reliable_writer_qos().times.heartbeat_period = Duration_t(0, 500000000);  // 500ms
    qos.reliable_writer_qos().times.nack_response_delay = Duration_t(0, 100000000);  // 100ms
}
```

### 5.6 处理不兼容 QoS 通知

```cpp
#include <fastdds/dds/core/status/IncompatibleQosStatus.hpp>

class MyWriterListener : public DataWriterListener
{
public:
    void on_offered_incompatible_qos(
        DataWriter* writer,
        const OfferedIncompatibleQosStatus& status) override
    {
        std::cout << "Incompatible QoS detected!" << std::endl;
        std::cout << "Total incompatible count: " << status.total_count << std::endl;
        std::cout << "Last incompatible policy ID: " << status.last_policy_id << std::endl;
        
        // 检查具体哪些策略不兼容
        for (const auto& policy : status.policies)
        {
            if (policy.count > 0)
            {
                std::cout << "Policy " << policy.policy_id 
                          << " incompatible count: " << policy.count << std::endl;
            }
        }
    }
};
```

---

## 6. 最佳实践

### 6.1 场景化 QoS 配置指南

#### 场景 1：实时视频流

```cpp
// 要求：低延迟、可容忍丢包
DataWriterQos video_qos;

// 尽力而为传输
video_qos.reliability().kind = BEST_EFFORT_RELIABILITY_QOS;

// 不持久化
video_qos.durability().kind = VOLATILE_DURABILITY_QOS;

// 只保留最新帧
video_qos.history().kind = KEEP_LAST_HISTORY_QOS;
video_qos.history().depth = 1;

// 数据快速过期
video_qos.lifespan().duration = Duration_t(0, 50000000);  // 50ms
```

#### 场景 2：机器人控制命令

```cpp
// 要求：高可靠、必须送达
DataWriterQos command_qos;

// 可靠传输
command_qos.reliability().kind = RELIABLE_RELIABILITY_QOS;

// 本地持久化（新订阅者可获取）
command_qos.durability().kind = TRANSIENT_LOCAL_DURABILITY_QOS;

// 保留最近 10 条命令
command_qos.history().kind = KEEP_LAST_HISTORY_QOS;
command_qos.history().depth = 10;

// 设置截止期限（确保定期更新）
command_qos.deadline().period = Duration_t(0, 100000000);  // 100ms
```

#### 场景 3：系统状态同步

```cpp
// 要求：状态一致性、历史可查
DataWriterQos state_qos;

// 可靠传输
state_qos.reliability().kind = RELIABLE_RELIABILITY_QOS;

// 本地持久化
state_qos.durability().kind = TRANSIENT_LOCAL_DURABILITY_QOS;

// 保留所有历史（直到资源限制）
state_qos.history().kind = KEEP_ALL_HISTORY_QOS;

// 充足的资源限制
state_qos.resource_limits().max_samples = 100;
state_qos.resource_limits().max_instances = 10;
state_qos.resource_limits().max_samples_per_instance = 10;
```

#### 场景 4：传感器数据采集

```cpp
// 要求：高吞吐、可容忍部分丢失
DataWriterQos sensor_qos;

// 尽力而为传输
sensor_qos.reliability().kind = BEST_EFFORT_RELIABILITY_QOS;

// 不持久化
sensor_qos.durability().kind = VOLATILE_DURABILITY_QOS;

// 保留最近的样本
sensor_qos.history().kind = KEEP_LAST_HISTORY_QOS;
sensor_qos.history().depth = 5;

// 异步发布提高吞吐
sensor_qos.publish_mode().kind = ASYNCHRONOUS_PUBLISH_MODE;

// 数据有效期（防止发送过时的传感器数据）
sensor_qos.lifespan().duration = Duration_t(0, 200000000);  // 200ms
```

### 6.2 QoS 配置检查清单

在部署系统前，检查以下项目：

| 检查项 | 说明 |
|--------|------|
| **可靠性匹配** | Writer 可靠性 ≥ Reader 可靠性 |
| **持久性匹配** | Writer 持久性 ≥ Reader 持久性 |
| **所有权一致** | Writer 和 Reader 所有权类型相同 |
| **截止期限合理** | Writer.deadline ≤ Reader.deadline |
| **资源限制充足** | max_samples ≥ max_instances × max_samples_per_instance |
| **历史深度适配** | 根据数据更新频率和订阅者加入频率设置 |

### 6.3 性能优化建议

1. **最小化 History Depth**
   - 对于只关心最新值的场景，设置 `depth = 1`
   - 减少内存占用和 CPU 开销

2. **使用 BEST_EFFORT 减少延迟**
   - 实时性要求高的场景优先使用 BEST_EFFORT
   - 避免 ACK/NACK 带来的延迟

3. **合理设置 ResourceLimits**
   - 过低的限制可能导致数据丢失
   - 过高的限制浪费内存资源
   - 根据实际数据量和实例数调整

4. **Lifespan 与 Deadline 配合**
   - 设置合理的 Lifespan 避免发送过期数据
   - Deadline 用于检测数据更新异常

5. **使用异步发布模式**
   - 高吞吐场景使用 `ASYNCHRONOUS_PUBLISH_MODE`
   - 避免 write 操作阻塞应用线程

### 6.4 常见错误与解决方案

| 错误现象 | 可能原因 | 解决方案 |
|----------|----------|----------|
| Writer/Reader 无法匹配 | QoS 不兼容 | 检查不兼容通知，调整 QoS 配置 |
| 数据延迟大 | RELIABLE 模式 ACK 延迟 | 调整 heartbeat 和 nack 参数 |
| 新订阅者收不到历史数据 | Durability 设置错误 | 使用 TRANSIENT_LOCAL 并配置 History |
| 内存占用过高 | ResourceLimits 过大 | 根据实际需求减小限制 |
| 数据丢失 | History 深度不足 | 增加 depth 或使用 KEEP_ALL |

---

## 参考资料

1. **Fast-DDS 源码**：`include/fastdds/dds/core/policy/QosPolicies.hpp`
2. **Fast-DDS 源码**：`include/fastdds/dds/core/policy/ParameterTypes.hpp`
3. **Fast-DDS 源码**：`src/cpp/rtps/builtin/discovery/endpoint/EDP.cpp`
4. **DDS 规范**：OMG DDS Specification v1.4
5. **RTPS 规范**：OMG RTPS Specification v2.5

---

*文档版本：V1.0*  
*最后更新：2026-03-02*  
*基于 Fast-DDS 版本：3.x*
