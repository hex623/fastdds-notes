# Fast-DDS 面试题大全

**创建时间**: 2026-03-13  
**适用岗位**: 中间件工程师、机器人软件工程师、嵌入式通信工程师  
**难度分布**: 初级(30%) / 中级(50%) / 高级(20%)  
**作者**: 旭旭助手

---

## 目录

1. [基础概念篇](#一基础概念篇)
2. [架构与设计篇](#二架构与设计篇)
3. [QoS 策略篇](#三qos-策略篇)
4. [发现机制篇](#四发现机制篇)
5. [可靠传输篇](#五可靠传输篇)
6. [性能优化篇](#六性能优化篇)
7. [安全与部署篇](#七安全与部署篇)
8. [ROS2 集成篇](#八ros2-集成篇)
9. [场景设计与实战篇](#九场景设计与实战篇)
10. [手撕代码篇](#十手撕代码篇)

---

## 一、基础概念篇

### 1.1 DDS 核心概念（初级）

**Q1: 什么是 DDS？它解决了什么问题？**

<details>
<summary>参考答案</summary>

**DDS** (Data Distribution Service) 是 OMG 制定的数据分发服务标准，用于分布式实时系统中以**发布-订阅**模式进行数据通信。

**解决的问题**:
1. **去中心化通信** - 无需中央服务器，自动发现节点
2. **QoS 控制** - 提供丰富的服务质量策略
3. **实时性** - 低延迟、确定性延迟
4. **可扩展性** - 支持上千个节点
5. **可靠性** - 支持可靠传输和持久化

**应用领域**: 自动驾驶、航空航天、工业控制、机器人、国防系统

</details>

**Q2: DDS 与 ROS2 的关系是什么？**

<details>
<summary>参考答案</summary>

**关系**:
- ROS2 使用 DDS 作为底层通信中间件
- ROS2 的 RMW (ROS Middleware Interface) 层封装了 DDS 实现
- 支持多种 DDS: Fast-DDS、CycloneDDS、RTI Connext

**映射关系**:
| ROS2 | DDS |
|------|-----|
| Node | DomainParticipant |
| Publisher | DataWriter |
| Subscription | DataReader |
| Topic | Topic |
| QoS Profile | QoS Policy |

</details>

**Q3: 解释 DDS 中的 Domain、Participant、Topic、Publisher、Subscriber 的关系**

<details>
<summary>参考答案</summary>

```
Domain (逻辑分区)
    └── DomainParticipant (通信入口)
            ├── Publisher (数据发布者)
            │       └── DataWriter (实际写入)
            │               └── Topic (数据主题)
            └── Subscriber (数据订阅者)
                    └── DataReader (实际读取)
                            └── Topic (数据主题)
```

**关系说明**:
- **Domain**: 逻辑隔离，不同 Domain 的参与者互不通信
- **Participant**: 容器，管理所有通信实体
- **Topic**: 数据类型 + 名称，连接发布和订阅
- **Publisher/Subscriber**: 逻辑分组，管理 DataWriter/DataReader

</details>

### 1.2 RTPS 协议（初级）

**Q4: 什么是 RTPS？与 DDS 的关系是什么？**

<details>
<summary>参考答案</summary>

**RTPS** (Real-Time Publish-Subscribe) 是 DDS 的**有线协议**，定义了 DDS 实体之间如何通过网络交换数据。

**关系**:
```
DDS Layer (抽象接口)
    ↓ 映射
RTPS Layer (协议实现)
    ↓ 传输
Transport Layer (UDP/TCP/SHM)
```

**RTPS 核心实体**:
- RTPSParticipant ↔ DomainParticipant
- RTPSWriter ↔ DataWriter
- RTPSReader ↔ DataReader

</details>

**Q5: RTPS 消息由哪些子消息组成？**

<details>
<summary>参考答案</summary>

**主要子消息**:

| 子消息 | 方向 | 作用 |
|--------|------|------|
| **DATA** | W→R | 传输用户数据 |
| **DATA_FRAG** | W→R | 传输分片数据 |
| **HEARTBEAT** | W→R | 告知数据可用性，请求确认 |
| **ACKNACK** | R→W | 确认收到/请求重传 |
| **GAP** | W→R | 通知数据不可用 |
| **INFO_TS** | 双向 | 时间戳信息 |
| **INFO_DST** | 双向 | 目标端信息 |

</details>

---

## 二、架构与设计篇

### 2.1 核心类设计（中级）

**Q6: 描述 RTPSDomain 的设计模式及其作用**

<details>
<summary>参考答案</summary>

**设计模式**: **单例模式 (Singleton)**

**作用**:
- 全局唯一的 RTPS 入口点
- 管理所有 RTPSParticipant 的生命周期
- 提供工厂方法创建 Writer/Reader

**核心方法**:
```cpp
// 获取单例
static RTPSDomain* get_instance();

// 创建/删除 Participant
static RTPSParticipant* create_participant(...);
static bool remove_participant(RTPSParticipant* part);

// 创建 Writer/Reader
static RTPSWriter* create_rtps_writer(...);
static RTPSReader* create_rtps_reader(...);
```

**线程安全**: 内部使用互斥锁保护 participants_ 列表

</details>

**Q7: Endpoint 抽象类的设计意图是什么？**

<details>
<summary>参考答案</summary>

**设计意图**: 统一 RTPSWriter 和 RTPSReader 的公共接口

**类层次**:
```cpp
class Endpoint {
protected:
    GUID_t guid_;                    // 全局唯一标识
    TopicAttributes topic_att_;      // Topic 属性
    EndpointAttributes endpoint_att_;// 端点属性
    RTPSParticipantImpl* participant_;// 所属参与者
};

class RTPSWriter : public Endpoint { /* 发送逻辑 */ };
class RTPSReader : public Endpoint { /* 接收逻辑 */ };
```

**优势**:
- 代码复用 (GUID、Topic 管理)
- 多态处理 (统一接口操作 Writer/Reader)
- 扩展性 (易于添加新端点类型)

</details>

**Q8: 解释 WriterProxy 和 ReaderProxy 的作用**

<details>
<summary>参考答案</summary>

**作用**: 维护**远端**端点的状态信息

**WriterProxy (在 Reader 端)**:
```cpp
struct WriterProxy {
    GUID_t remoteWriterGuid;           // 远端 Writer ID
    SequenceNumber_t last_available_seq;  // 最新可用序列号
    SequenceNumberSet missing_changes;    // 丢失的序列号
    Time_t last_heartbeat_time;        // 最后心跳时间
};
// 作用: 跟踪远端 Writer 状态，检测丢包
```

**ReaderProxy (在 Writer 端)**:
```cpp
struct ReaderProxy {
    GUID_t remoteReaderGuid;           // 远端 Reader ID
    SequenceNumber_t acked_seq_num;    // 已确认序列号
    SequenceNumberSet requested_changes; // 请求重传的序列号
    std::set<SequenceNumber_t> outstanding_changes; // 未确认
};
// 作用: 跟踪哪些数据需要重传
```

</details>

### 2.2 设计模式（中级）

**Q9: Fast-DDS 中使用了哪些设计模式？举例说明**

<details>
<summary>参考答案</summary>

| 模式 | 应用位置 | 目的 |
|------|---------|------|
| **单例** | RTPSDomain | 全局唯一入口 |
| **Pimpl** | RTPSParticipant | 隐藏实现细节，ABI 兼容 |
| **抽象工厂** | Endpoint 体系 | 统一创建 Writer/Reader |
| **代理** | WriterProxy/ReaderProxy | 维护远端状态 |
| **观察者** | Listener 回调 | 异步事件通知 |
| **策略** | QoS Policy | 可配置行为 |
| **对象池** | CacheChangePool | 内存管理 |

**示例 - Pimpl**:
```cpp
// 头文件 (稳定接口)
class RTPSParticipant {
    RTPSParticipantImpl* impl_;  // 实现指针
public:
    void enable();
};

// 实现文件 (可变更)
class RTPSParticipantImpl {
    // 实际实现，不影响用户代码
};
```

</details>

---

## 三、QoS 策略篇

### 3.1 QoS 基础（中级）

**Q10: 解释以下 QoS 策略：Reliability、Durability、History**

<details>
<summary>参考答案</summary>

**Reliability (可靠性)**:
- `RELIABLE`: 确保送达，丢失时重传
- `BEST_EFFORT`: 尽力而为，不保证送达

**Durability (持久性)**:
- `VOLATILE`: 不保留历史数据
- `TRANSIENT_LOCAL`: 保留历史，新订阅者可获取
- `TRANSIENT`: 保留到持久化存储
- `PERSISTENT`: 永久保留

**History (历史)**:
- `KEEP_LAST(n)`: 保留最近 n 个样本
- `KEEP_ALL`: 保留所有（直到 ResourceLimits 满）

**常见组合**:
```
实时传感器: BEST_EFFORT + VOLATILE + KEEP_LAST(1)
关键指令:   RELIABLE + TRANSIENT_LOCAL + KEEP_ALL
日志记录:   RELIABLE + PERSISTENT + KEEP_ALL
```

</details>

**Q11: QoS 兼容性规则是什么？**

<details>
<summary>参考答案</summary>

**匹配原则**: DataWriter 和 DataReader 的 QoS 必须**兼容**才能通信

**关键规则**:

| Writer QoS | Reader QoS | 兼容性 | 说明 |
|-----------|-----------|--------|------|
| RELIABLE | RELIABLE | ✅ | 完全匹配 |
| RELIABLE | BEST_EFFORT | ❌ | Writer 无法降级 |
| BEST_EFFORT | RELIABLE | ✅ | Reader 降级接受 |
| BEST_EFFORT | BEST_EFFORT | ✅ | 完全匹配 |
| VOLATILE | TRANSIENT_LOCAL | ❌ | 不匹配 |
| TRANSIENT_LOCAL | VOLATILE | ✅ | Reader 降级 |
| KEEP_ALL | KEEP_LAST(n) | ✅ | 混合 |

**原则**: Writer 的"承诺"必须满足 Reader 的"需求"

</details>

### 3.2 Deadline 与 Liveliness（中级）

**Q12: Deadline QoS 的工作原理？**

<details>
<summary>参考答案</summary>

**机制**:
1. 配置 `deadline.period`（如 1 秒）
2. 系统期望每 1 秒至少收到一个新样本
3. 如果超时未收到 → 触发 `on_requested_deadline_missed()` 回调

**应用场景**:
- 传感器数据监控（检测传感器故障）
- 心跳检测（替代自定义心跳机制）

**代码示例**:
```cpp
DataReaderQos qos;
qos.deadline().period = Duration_t(1, 0);  // 1秒

class MyListener : public DataReaderListener {
    void on_requested_deadline_missed(
        DataReader* reader,
        const RequestedDeadlineMissedStatus& status) override {
        // 处理超时
    }
};
```

</details>

**Q13: Liveliness 的作用是什么？AUTOMATIC 和 MANUAL_BY_TOPIC 的区别？**

<details>
<summary>参考答案</summary>

**作用**: 检测远端节点是否**存活**

**两种模式**:

| 模式 | 机制 | 适用场景 |
|------|------|---------|
| **AUTOMATIC** | DDS 自动发送心跳 | 大多数场景，无需干预 |
| **MANUAL_BY_TOPIC** | 应用层调用 `assert_liveliness()` | 应用控制心跳时机 |

**租约机制**:
```
Writer 配置: lease_duration = 10s
├─ Writer: 每 10s 内必须声明存活（自动或手动）
└─ Reader: 超过 10s 未收到声明 → 触发 on_liveliness_changed()
```

</details>

---

## 四、发现机制篇

### 4.1 发现协议（中级）

**Q14: 解释 SPDP 和 SEDP 的作用及区别**

<details>
<summary>参考答案</summary>

**SPDP** (Simple Participant Discovery Protocol):
- **Phase 1**: 发现网络中的 **Participant**
- 周期性发送 `DATA(p)` 消息宣告自身存在
- 使用组播 (239.255.0.1:7400) 或单播

**SEDP** (Simple Endpoint Discovery Protocol):
- **Phase 2**: 发现 **DataWriter/DataReader**
- 使用 4 个内置端点交换 Endpoint 信息
- 检查 Topic、Type、QoS 兼容性

**发现流程**:
```
1. SPDP: 发现 "谁在场"
   ↓
2. SEDP: 发现 "谁能做什么"
   ↓
3. 匹配: Topic + Type + QoS 兼容
   ↓
4. 建立连接: 开始数据传输
```

</details>

**Q15: 什么是租约 (Lease Duration)？**

<details>
<summary>参考答案</summary>

**定义**: 参与者/端点声明的有效期

**机制**:
```
租约时长: 20s (默认)
宣告周期: 3s (默认)

节点 A                    节点 B
  │                        │
  ├── DATA(p), t=0 ───────▶│  B 发现 A
  ├── DATA(p), t=3s ─────▶│  刷新租约
  ├── DATA(p), t=6s ─────▶│  刷新租约
  │    ...                 │
  │  [A 崩溃]              │
  │                        │
  │  t=26s (超过租约)      │
  │                        │▶ 触发 on_participant_removed()
```

**作用**: 故障检测，自动清理离线节点

</details>

### 4.2 Discovery Server（高级）

**Q16: 什么场景需要使用 Discovery Server？**

<details>
<summary>参考答案</summary>

**Simple Discovery 的局限性**:
- 组播不支持跨网段/VPN/云环境
- 网络流量 O(N²)，大规模系统发现风暴
- 初始化时间长

**Discovery Server 优势**:
- 使用单播，支持复杂网络拓扑
- 网络流量 O(N)，可扩展
- 支持冗余和持久化

**适用场景**:
- 跨网段/VPN 通信
- Kubernetes/Docker 环境
- 100+ 节点的大规模系统
- 云边协同

</details>

**Q17: Discovery Server 的架构是怎样的？**

<details>
<summary>参考答案</summary>

```
┌─────────────────────────────────────────────────────────────┐
│                   Discovery Server                          │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  集中式发现数据库                                      │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │   │
│  │  │ Participant A│  │ Participant B│  │     ...    │ │   │
│  │  └──────────────┘  └──────────────┘  └────────────┘ │   │
│  └─────────────────────────────────────────────────────┘   │
└──────────────────────────┬──────────────────────────────────┘
           ▲               │               ▲
           │               │               │
    ┌──────┴──────┐  ┌─────┴──────┐  ┌────┴──────┐
    │  Client A   │  │  Client B  │  │  Client C │
    │ (Publisher) │  │(Subscriber)│  │  (Both)   │
    └─────────────┘  └────────────┘  └───────────┘
```

**工作流程**:
1. Client 向 Server 单播宣告自身
2. Server 存储信息并计算匹配
3. Server 通知匹配的双方
4. 匹配的 Client 直接 P2P 通信（数据不经过 Server）

**关键点**: Server 只处理**发现流量**，**数据流量**仍然是 P2P

</details>

---

## 五、可靠传输篇

### 5.1 可靠传输机制（中级）

**Q18: 描述 HEARTBEAT 和 ACKNACK 的交互流程**

<details>
<summary>参考答案</summary>

```
Writer                          Reader
  │                               │
  ├── DATA(seq=1) ───────────────▶│
  ├── DATA(seq=2) ───────────────▶│
  ├── DATA(seq=4) ───────────────▶│  [seq=3 丢失]
  │                               │
  ├── HEARTBEAT(first=1,last=4) ─▶│  "我有数据 1-4"
  │                               │
  │                               ├── 检查: 收到 1,2,4，缺 3
  │                               │
  │◀────────────── ACKNACK(base=1,bitmap=1011)── "收到1,2，缺3"
  │                               │    bit 0=1: 收到 seq=1
  │                               │    bit 1=1: 收到 seq=2
  │                               │    bit 2=0: 缺失 seq=3
  │                               │    bit 3=1: 收到 seq=4
  │                               │
  ├── DATA(seq=3) [重传] ────────▶│
  │                               │
  │                               ├── 插入 seq=3，现在连续
  │                               │
  │◀────────────── ACKNACK(base=5)─────────────── "全部收到"
```

**关键点**:
- HEARTBEAT: Writer → Reader，声明数据范围
- ACKNACK: Reader → Writer，确认/请求重传
- Bitmap: 高效确认大量序列号

</details>

**Q19: 什么是 NACK 抑制 (NACK Suppression)？**

<details>
<summary>参考答案</summary>

**问题**: Reader 频繁发送 NACK 导致重传风暴

**解决方案**: 延迟响应
```cpp
// Reader 收到 HEARTBEAT 后不立即回复 ACKNACK
// 等待 100ms (NACK_RESP_DELAY)

class NackResponseDelay : public TimedEvent {
    void event() override {
        // 收集期间所有丢包
        // 批量发送一个 ACKNACK
    }
};
```

**优势**:
- 多个分片丢失时，合并为一个请求
- 多个 Reader 同时丢包时，合并重传
- 减少网络负载

</details>

### 5.2 分片传输（中级）

**Q20: 大数据如何传输？分片机制是怎样的？**

<details>
<summary>参考答案</summary>

**分片机制**:
```
大数据样本 (1MB)
├─ Frag 0 (64KB) ──► DATA_FRAG(start=0, num=1, data=...)
├─ Frag 1 (64KB) ──► DATA_FRAG(start=1, num=1, data=...)
├─ ...
└─ Frag 15 (剩余) ─► DATA_FRAG(start=15, num=1, data=...)
```

**关键参数**:
- `maxMessageSize`: 最大消息大小 (~64KB for UDP)
- `fragmentSize`: 分片大小
- `fragmentStartingNum`: 分片序号

**可靠分片**:
- 每个分片独立确认
- 丢失的分片单独重传
- 所有分片到齐后重组

</details>

---

## 六、性能优化篇

### 6.1 内存管理（中级）

**Q21: Fast-DDS 的内存池机制是怎样的？**

<details>
<summary>参考答案</summary>

**CacheChangePool**:
```cpp
class CacheChangePool {
    std::vector<CacheChange_t*> pool_;     // 可用单元
    std::vector<CacheChange_t*> all_changes_; // 所有单元
    size_t current_pool_size_;
    size_t max_pool_size_;
    bool allow_growing_;
};
```

**分配策略**:
| 策略 | 配置 | 适用场景 |
|------|------|---------|
| 固定池 | `pool_size=N`, `allow_growing=false` | 嵌入式 |
| 可增长池 | `pool_size=N`, `max_pool_size=M` | 通用 |
| 动态分配 | `pool_size=0` | 调试 |

**优势**: O(1) 分配，避免 malloc 延迟和碎片

</details>

**Q22: 如何优化同机进程间通信？**

<details>
<summary>参考答案</summary>

**方案: 共享内存 (SHM)**

```xml
<transportDescriptor>
    <type>SHM</type>
    <segmentSize>10485760</segmentSize>  <!-- 10MB -->
</transportDescriptor>
```

**优势**:
- **零拷贝**: 数据直接写入共享内存，无需序列化/反序列化
- **低延迟**: ~0.5-2μs (vs UDP ~10-50μs)
- **高吞吐**: 内存速度

**限制**: 仅限单机

</details>

### 6.2 线程优化（高级）

**Q23: 如何配置线程数以优化性能？**

<details>
<summary>参考答案</summary>

**线程组成**:
```
总线程 = 1(定时器) + N(异步发送) + M(传输) + 1(发现)

默认: N = CPU核心数, M = 1(UDP)
```

**配置**:
```cpp
// 异步发送线程数
qos.publish_mode().async_thread_count = 8;

// 接收缓冲区
qos.transport().listen_socket_buffer_size = 1048576;
```

**CPU 亲和性**:
```cpp
// 绑定接收线程到 CPU 0
set_thread_affinity(receive_thread, 0);

// 设置实时优先级
set_realtime_priority(event_thread, 80);
```

</details>

---

## 七、安全与部署篇

### 7.1 DDS-Security（中级）

**Q24: DDS-Security 提供哪些安全机制？**

<details>
<summary>参考答案</summary>

**五层安全**:

| 层 | 功能 | 实现 |
|---|------|------|
| **认证** | 身份验证 | X.509 证书 + PKI |
| **访问控制** | 权限管理 | Governance + Permissions XML |
| **加密** | 数据传输加密 | AES-128/256-GCM |
| **消息完整性** | 防篡改 | GMAC 签名 |
| **日志** | 审计追踪 | 安全事件记录 |

**Governance**: 定义 Domain 级安全策略  
**Permissions**: 定义 Participant 级访问权限

</details>

### 7.2 部署问题（中级）

**Q25: 跨网段/VPN 通信失败如何排查？**

<details>
<summary>参考答案</summary>

**排查步骤**:
```bash
# 1. 检查 Domain ID
echo $ROS_DOMAIN_ID

# 2. 检查网络连通性
ping <remote_host>

# 3. 检查多播 (Simple Discovery)
socat UDP4-RECVFROM:7400,ip-add-membership=239.255.0.1:0.0.0.0 -

# 4. 检查防火墙
sudo iptables -L | grep 7400
```

**解决方案**:
1. **使用 Discovery Server**: 单播代替组播
2. **使用 TCP**: 穿透 NAT
3. **配置初始对等点**: 显式指定 IP

</details>

---

## 八、ROS2 集成篇

### 8.1 RMW 层（中级）

**Q26: 如何在运行时切换 DDS 实现？**

<details>
<summary>参考答案</summary>

```bash
# 设置环境变量
export RMW_IMPLEMENTATION=rmw_fastrtps_cpp    # Fast-DDS
export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp  # CycloneDDS
export RMW_IMPLEMENTATION=rmw_connext_cpp     # RTI Connext

# 验证
ros2 doctor --report | grep RMW

# 单次运行指定
ros2 run pkg node --ros-args --rmw-implementation rmw_fastrtps_cpp
```

**对比**:
| 实现 | 特点 |
|------|------|
| Fast-DDS | 功能最完整，默认 |
| CycloneDDS | 性能最好，低延迟 |
| RTI Connext | 商业支持 |

</details>

### 8.2 QoS 配置（中级）

**Q27: ROS2 QoS 如何映射到 DDS？**

<details>
<summary>参考答案</summary>

```cpp
// ROS2 QoS
rclcpp::QoS qos(10);  // History depth
qos.reliable();
qos.durability_volatile();
qos.deadline(rclcpp::Duration::from_seconds(1.0));

// 映射到 DDS:
// - History: KeepLast(10)
// - Reliability: RELIABLE
// - Durability: VOLATILE
// - Deadline: 1s
```

**常见配置**:
```cpp
// 传感器数据
rclcpp::SensorDataQoS();  // BEST_EFFORT, VOLATILE, KEEP_LAST(5)

// 参数服务
rclcpp::ParametersQoS();  // RELIABLE, VOLATILE

// 服务调用
rclcpp::ServicesQoS();    // RELIABLE, VOLATILE
```

</details>

---

## 九、场景设计与实战篇

### 9.1 系统设计题（高级）

**Q28: 设计一个自动驾驶车辆的 DDS 通信系统**

<details>
<summary>参考答案</summary>

**场景需求**:
- 传感器: 激光雷达、摄像头、毫米波雷达 (高频率)
- 决策: 路径规划、行为决策
- 控制: 横向/纵向控制 (实时性)
- 安全: 故障检测、紧急制动

**设计方案**:

```
Domain 0 (感知层)
├── /lidar/points    (BEST_EFFORT, VOLATILE, KEEP_LAST(1))
├── /camera/image    (BEST_EFFORT, VOLATILE, KEEP_LAST(1))
└── /radar/tracks    (BEST_EFFORT, VOLATILE, KEEP_LAST(1))

Domain 1 (决策层)
├── /perception/objects  (RELIABLE, TRANSIENT_LOCAL)
├── /planning/path       (RELIABLE, TRANSIENT_LOCAL)
└── /planning/trajectory (RELIABLE, TRANSIENT_LOCAL, DEADLINE(100ms))

Domain 2 (控制层)
├── /control/cmd        (RELIABLE, TRANSIENT_LOCAL, DEADLINE(20ms))
└── /vehicle/state      (RELIABLE, VOLATILE)

Domain 3 (监控层)
├── /system/heartbeat   (RELIABLE, LIVELINESS(AUTOMATIC, 1s))
└── /diagnostics        (RELIABLE, KEEP_ALL)
```

**理由**:
- **感知层**: BEST_EFFORT，最新数据最重要，允许丢帧
- **决策层**: TRANSIENT_LOCAL，新节点启动可获取历史
- **控制层**: 硬实时要求，Deadline 监控
- **监控层**: 可靠性优先，全量记录

</details>

### 9.2 故障排查（高级）

**Q29: 系统出现消息延迟，如何排查？**

<details>
<summary>参考答案</summary>

**排查步骤**:

```
1. 确认问题层
   ├─ 应用层: 处理逻辑耗时? (打印时间戳)
   ├─ ROS2层: QoS 不匹配? (ros2 topic info)
   ├─ DDS层: 发现延迟? (Wireshark 抓包)
   ├─ 传输层: 网络拥塞? (iftop, tcpdump)
   └─ 系统层: CPU/内存? (top, htop)

2. 检查 QoS 配置
   - Writer/Reader 是否匹配?
   - History 深度是否足够?
   - Reliability 设置是否合理?

3. 网络分析
   - 检查丢包率 (ifconfig)
   - 检查延迟 (ping)
   - Wireshark 抓包分析 RTPS 消息

4. 性能分析
   - 启用 DDS 统计模块
   - 监控 HistoryCache 使用率
   - 检查线程 CPU 占用
```

**常见原因**:
- QoS 不匹配导致无法连接
- KEEP_ALL + 无 ResourceLimits 导致内存满
- 网络拥塞，分片丢失频繁重传
- 回调函数阻塞事件循环

</details>

---

## 十、手撕代码篇

### 10.1 DDS 基础代码（中级）

**Q30: 实现一个简单的 DDS Pub/Sub（Fast-DDS API）**

<details>
<summary>参考答案</summary>

```cpp
// ==================== Publisher ====================
#include <fastdds/dds/domain/DomainParticipantFactory.hpp>
#include <fastdds/dds/domain/DomainParticipant.hpp>
#include <fastdds/dds/publisher/Publisher.hpp>
#include <fastdds/dds/publisher/DataWriter.hpp>
#include <fastdds/dds/publisher/DataWriterListener.hpp>
#include <fastdds/dds/topic/Topic.hpp>

using namespace eprosima::fastdds::dds;

class PubListener : public DataWriterListener {
public:
    void on_publication_matched(DataWriter* writer,
                                const PublicationMatchedStatus& info) override {
        if (info.current_count_change == 1) {
            std::cout << "Publisher matched" << std::endl;
        }
    }
};

int main() {
    // 1. 创建 Participant
    DomainParticipant* participant = 
        DomainParticipantFactory::get_instance()->create_participant(0, 
                                                                     PARTICIPANT_QOS_DEFAULT);
    
    // 2. 注册类型
    TypeSupport type_support(new StringPubSubType());
    type_support.register_type(participant);
    
    // 3. 创建 Topic
    Topic* topic = participant->create_topic("HelloTopic", 
                                             type_support.get_type_name(), 
                                             TOPIC_QOS_DEFAULT);
    
    // 4. 创建 Publisher
    Publisher* publisher = participant->create_publisher(PUBLISHER_QOS_DEFAULT, nullptr);
    
    // 5. 创建 DataWriter
    PubListener listener;
    DataWriter* writer = publisher->create_datawriter(topic, 
                                                      DATAWRITER_QOS_DEFAULT, 
                                                      &listener);
    
    // 6. 发布消息
    std::string msg = "Hello DDS!";
    writer->write(&msg);
    
    // 清理
    participant->delete_contained_entities();
    DomainParticipantFactory::get_instance()->delete_participant(participant);
    return 0;
}
```

**关键点**:
- 类型注册必须在使用前完成
- QoS 默认是 BEST_EFFORT，需要可靠时显式配置
- 注意资源释放顺序

</details>

### 10.2 线程安全代码（高级）

**Q31: 实现一个线程安全的 DDS 消息队列**

<details>
<summary>参考答案</summary>

```cpp
#include <queue>
#include <mutex>
#include <condition_variable>
#include <memory>

template<typename T>
class ThreadSafeDDSQueue {
public:
    struct DDSMessage {
        T data;
        int64_t sequence_number;
        std::chrono::steady_clock::time_point timestamp;
    };
    
    // 生产者: DDS 回调线程调用
    void push(const T& data, int64_t seq_num) {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            queue_.push({data, seq_num, std::chrono::steady_clock::now()});
        }
        cv_.notify_one();
    }
    
    // 消费者: 应用处理线程调用
    bool pop(T& data, int64_t& seq_num, std::chrono::milliseconds timeout) {
        std::unique_lock<std::mutex> lock(mutex_);
        
        if (!cv_.wait_for(lock, timeout, [this] { return !queue_.empty(); })) {
            return false;  // 超时
        }
        
        auto msg = queue_.front();
        queue_.pop();
        
        data = msg.data;
        seq_num = msg.sequence_number;
        return true;
    }
    
    size_t size() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return queue_.size();
    }
    
private:
    std::queue<DDSMessage> queue_;
    mutable std::mutex mutex_;
    std::condition_variable cv_;
};

// 使用示例
ThreadSafeDDSQueue<std::vector<uint8_t>> message_queue;

// DDS 回调 (在 DDS 线程中)
void on_data_available(DataReader* reader) {
    std::vector<uint8_t> data;
    reader->take_next_sample(&data);
    message_queue.push(data, reader->get_last_sequence_number());
}

// 处理线程
void processing_thread() {
    while (running_) {
        std::vector<uint8_t> data;
        int64_t seq_num;
        
        if (message_queue.pop(data, seq_num, std::chrono::milliseconds(100))) {
            process_message(data, seq_num);
        }
    }
}
```

**设计要点**:
- 使用 `condition_variable` 实现高效等待
- 记录序列号用于顺序检查和丢包检测
- 添加时间戳用于延迟分析
- 超时机制避免永久阻塞

</details>

### 10.3 性能测试代码（高级）

**Q32: 编写一个 DDS 延迟测试工具**

<details>
<summary>参考答案</summary>

```cpp
#include <chrono>
#include <vector>
#include <statistics>

class DDSLatencyTester {
public:
    struct TestResult {
        double avg_latency_us;
        double min_latency_us;
        double max_latency_us;
        double p99_latency_us;
        double throughput_mbps;
    };
    
    // 测试参数
    struct Config {
        int message_size = 1024;           // 消息大小
        int message_count = 10000;         // 测试消息数
        int warmup_count = 1000;           // 预热消息数
        std::chrono::milliseconds interval{1};  // 发送间隔
    };
    
    TestResult run_test(const Config& config) {
        std::vector<double> latencies;
        latencies.reserve(config.message_count);
        
        // 创建 Publisher 和 Subscriber
        auto publisher = create_publisher();
        auto subscriber = create_subscriber(
            [&latencies](const TestMessage& msg) {
                auto recv_time = std::chrono::high_resolution_clock::now();
                auto send_time = std::chrono::nanoseconds(msg.timestamp_ns);
                
                double latency_us = 
                    std::chrono::duration_cast<std::chrono::microseconds>(
                        recv_time - send_time).count();
                
                latencies.push_back(latency_us);
            });
        
        // 预热
        for (int i = 0; i < config.warmup_count; ++i) {
            send_message(publisher, config.message_size);
            std::this_thread::sleep_for(config.interval);
        }
        latencies.clear();
        
        // 正式测试
        auto start_time = std::chrono::high_resolution_clock::now();
        
        for (int i = 0; i < config.message_count; ++i) {
            send_message(publisher, config.message_size);
            std::this_thread::sleep_for(config.interval);
        }
        
        // 等待所有消息接收
        wait_for_messages(config.message_count, std::chrono::seconds(30));
        
        auto end_time = std::chrono::high_resolution_clock::now();
        
        // 计算结果
        return calculate_result(latencies, config, start_time, end_time);
    }
    
private:
    struct TestMessage {
        uint64_t timestamp_ns;
        uint32_t sequence_num;
        std::vector<uint8_t> payload;
    };
    
    void send_message(Publisher* pub, int size) {
        TestMessage msg;
        msg.timestamp_ns = std::chrono::high_resolution_clock::now().time_since_epoch().count();
        msg.sequence_num = sequence_++;
        msg.payload.resize(size - sizeof(msg.timestamp_ns) - sizeof(msg.sequence_num));
        
        pub->write(&msg);
    }
    
    TestResult calculate_result(const std::vector<double>& latencies,
                               const Config& config,
                               TimePoint start, TimePoint end) {
        TestResult result;
        
        if (latencies.empty()) return result;
        
        // 排序计算百分位
        auto sorted = latencies;
        std::sort(sorted.begin(), sorted.end());
        
        result.min_latency_us = sorted.front();
        result.max_latency_us = sorted.back();
        result.avg_latency_us = std::accumulate(sorted.begin(), sorted.end(), 0.0) / sorted.size();
        
        size_t p99_idx = static_cast<size_t>(sorted.size() * 0.99);
        result.p99_latency_us = sorted[p99_idx];
        
        // 吞吐量
        auto duration = std::chrono::duration_cast<std::chrono::seconds>(end - start).count();
        double total_bits = static_cast<double>(config.message_count * config.message_size * 8);
        result.throughput_mbps = (total_bits / duration) / 1e6;
        
        return result;
    }
    
    std::atomic<uint32_t> sequence_{0};
};

// 使用
int main() {
    DDSLatencyTester tester;
    DDSLatencyTester::Config config;
    config.message_size = 1024;
    config.message_count = 10000;
    
    auto result = tester.run_test(config);
    
    std::cout << "=== DDS Latency Test Results ===" << std::endl;
    std::cout << "Average: " << result.avg_latency_us << " μs" << std::endl;
    std::cout << "Min:     " << result.min_latency_us << " μs" << std::endl;
    std::cout << "Max:     " << result.max_latency_us << " μs" << std::endl;
    std::cout << "P99:     " << result.p99_latency_us << " μs" << std::endl;
    std::cout << "Throughput: " << result.throughput_mbps << " Mbps" << std::endl;
    
    return 0;
}
```

**测试要点**:
- 预热阶段消除冷启动影响
- 时间戳嵌入消息计算端到端延迟
- 百分位数 (P99) 反映尾部延迟
- 吞吐量独立计算验证带宽

</details>

---

## 附录：面试 checklist

### 面试前准备

- [ ] 理解 DDS 核心概念 (Domain/Participant/Topic/Pub/Sub)
- [ ] 熟悉 RTPS 协议 (HEARTBEAT/ACKNACK/DATA)
- [ ] 掌握主要 QoS 策略 (Reliability/Durability/History/Deadline)
- [ ] 了解发现机制 (SPDP/SEDP/Discovery Server)
- [ ] 了解线程模型和内存管理
- [ ] 准备 ROS2 集成经验
- [ ] 准备性能优化案例

### 高频考点

1. **QoS 兼容性** (必考)
2. **可靠传输机制** (HEARTBEAT/ACKNACK)
3. **发现协议** (SPDP/SEDP 流程)
4. **线程安全** (回调设计)
5. **性能优化** (SHM/线程数/批处理)

### 加分项

- DDS-Security 配置经验
- Discovery Server 大规模部署
- ROS2 实际项目经验
- Wireshark RTPS 分析能力
- 自定义传输层开发

---

*文档版本: 1.0*  
*最后更新: 2026-03-13*  
*祝面试顺利！*
