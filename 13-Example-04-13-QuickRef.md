# Example 04-13: 其他示例快速参考

**学习目标**: 快速了解剩余 10 个示例的核心概念和用法  
**难度**: ⭐⭐⭐-⭐⭐⭐⭐⭐  
**预计时长**: 每个示例 30-60 分钟

---

## Example 04: Static EDP Discovery

**路径**: `examples/cpp/static_edp_discovery/`  
**核心概念**: 静态端点发现，禁用动态发现，预先配置对端信息  
**适用场景**: 嵌入式系统、确定性网络、安全环境

### 关键代码

```cpp
// 禁用所有自动发现
participant_qos.wire_protocol().builtin.discovery_config.discoveryProtocol =
    DiscoveryProtocol::NONE;

// 手动配置远程 Writer 信息
Locator_t writer_locator;
// ... 配置 writer_locator
reader_qos.endpoint.remoteLocatorList.push_back(writer_locator);
```

### 学习要点
- 完全禁用多播/单播发现
- 手动配置所有端点信息
- 启动顺序无关，但配置复杂

---

## Example 05: Configuration

**路径**: `examples/cpp/configuration/`  
**核心概念**: XML 配置文件加载 QoS  
**适用场景**: 动态配置、多环境部署、运维管理

### 关键代码

```cpp
// 从环境变量加载 XML
const char* xml_file = std::getenv("FASTDDS_DEFAULT_PROFILES_FILE");
DomainParticipantFactory::get_instance()->load_XML_profiles_file(xml_file);

// 使用 XML 中的 QoS 配置
DomainParticipant* participant = 
    DomainParticipantFactory::get_instance()->create_participant_with_profile(
        0, "participant_profile_name");
```

### XML 示例
```xml
<dds>
    <profiles>
        <participant profile_name="participant_profile">
            <rtps>
                <builtin>
                    <discovery_config>
                        <discoveryProtocol>SIMPLE</discoveryProtocol>
                    </discovery_config>
                </builtin>
            </rtps>
        </participant>
    </profiles>
</dds>
```

---

## Example 06: Content Filter

**路径**: `examples/cpp/content_filter/`  
**核心概念**: 内容过滤 Topic，Reader 只接收满足条件的数据  
**适用场景**: 大数据量场景，减少不必要的数据传输

### 关键代码

```cpp
// 创建 ContentFilteredTopic
ContentFilteredTopic* filtered_topic = 
    participant->create_contentfilteredtopic(
        "FilteredTopic",
        topic,
        "index > %0",    // SQL 表达式
        {"100"});         // 参数

// 使用过滤后的 Topic 创建 Reader
DataReader* reader = subscriber->create_datareader(
    filtered_topic,  // 而不是原始 topic
    reader_qos);
```

### 学习要点
- SQL 表达式过滤（类似 WHERE 子句）
- 在 Reader 端过滤，减少 CPU 占用
- 也可以配置为在 Writer 端过滤（更高效）

---

## Example 07: Flow Control

**路径**: `examples/cpp/flow_control/`  
**核心概念**: 流量控制，限制 Writer 的发送速率  
**适用场景**: 带宽受限、接收端处理能力有限

### 关键代码

```cpp
// 配置异步发送
writer_qos.publish_mode().kind = ASYNCHRONOUS_PUBLISH_MODE;

// 配置流量控制
writer_qos.throughput_controller().bytesPerPeriod = 1024;  // 每秒 1KB
writer_qos.throughput_controller().periodMillisecs = 1000;

// 或者使用带宽限制
writer_qos.throughput_controller().bytesPerPeriod = 64000;  // 64KB
writer_qos.throughput_controller().periodMillisecs = 100;   // 每 100ms
```

### 学习要点
- 同步发送 vs 异步发送
- 带宽限制（bytes/period）
- 防止接收端缓冲区溢出

---

## Example 08: Delivery Mechanisms

**路径**: `examples/cpp/delivery_mechanisms/`  
**核心概念**: 多种传输机制对比（UDP、TCP、SHM）  
**适用场景**: 性能测试、传输层选型

### 关键代码

```cpp
// 配置多种传输
auto udp_transport = std::make_shared<UDPv4TransportDescriptor>();
auto tcp_transport = std::make_shared<TCPv4TransportDescriptor>();
auto shm_transport = std::make_shared<SharedMemTransportDescriptor>();

participant_qos.transport().user_transports.push_back(shm_transport);
participant_qos.transport().user_transports.push_back(udp_transport);
participant_qos.transport().user_transports.push_back(tcp_transport);

// Fast-DDS 自动选择最优传输
```

### 学习要点
- 自动选择 vs 强制指定
- 传输优先级
- 性能对比测试

---

## Example 09: Topic Instances

**路径**: `examples/cpp/topic_instances/`  
**核心概念**: Topic 多实例，用 Key 区分不同数据流  
**适用场景**: 多传感器、多设备状态管理

### 关键代码

```cpp
// 定义带 Key 的数据类型
struct ShapeType {
    @key string color;  // Key 字段
    long x;
    long y;
};

// 创建 Reader，接收所有实例
DataReader* reader = subscriber->create_datareader(topic, reader_qos);

// 或者只接收特定实例
SampleInfo info;
while (reader->take_next_sample(&data, &info) == ReturnCode_t::RETCODE_OK) {
    if (info.instance_handle == specific_instance) {
        // 处理特定实例
    }
}
```

### 学习要点
- InstanceHandle 区分不同实例
- 实例生命周期管理（ALIVE/NOT_ALIVE）
- 读取特定实例的历史数据

---

## Example 10: Custom Payload Pool

**路径**: `examples/cpp/custom_payload_pool/`  
**核心概念**: 自定义 Payload 内存池，零拷贝优化  
**适用场景**: 高性能、低延迟、大数据量

### 关键代码

```cpp
// 创建自定义 PayloadPool
class CustomPayloadPool : public IPayloadPool {
public:
    bool get_payload(uint32_t size, SerializedPayload_t& payload) override {
        // 从内存池分配
        payload.data = pool_.allocate(size);
        payload.max_size = size;
        return true;
    }
    
    bool release_payload(SerializedPayload_t& payload) override {
        // 归还内存池
        pool_.deallocate(payload.data);
        return true;
    }
};

// 使用自定义 Pool
CustomPayloadPool pool;
DataWriter* writer = publisher->create_datawriter(
    topic, writer_qos, &listener, StatusMask::all(), &pool);
```

### 学习要点
- 避免频繁的 new/delete
- 内存池预分配
- 零拷贝传输

---

## Example 11: Security

**路径**: `examples/cpp/security/`  
**核心概念**: DDS-Security，认证、加密、访问控制  
**适用场景**: 生产环境、跨网段、零信任网络

### 关键代码

```cpp
// 配置认证
participant_qos.properties().properties().emplace_back(
    "dds.sec.auth.plugin", "builtin.PKI-DH");
participant_qos.properties().properties().emplace_back(
    "dds.sec.auth.builtin.PKI-DH.identity_certificate",
    "file://participant_cert.pem");

// 配置加密
participant_qos.properties().properties().emplace_back(
    "dds.sec.crypto.plugin", "builtin.AES-GCM-GMAC");
```

### 学习要点
- PKI 证书体系
- Governance 和 Permissions 配置
- 签名 XML 文件

---

## Example 12: XTypes

**路径**: `examples/cpp/xtypes/`  
**核心概念**: 动态类型发现，类型演进  
**适用场景**: 版本兼容、动态系统

### 关键代码

```cpp
// 动态类型注册
DynamicType_ptr dynamic_type = DynamicTypeBuilderFactory::get_instance()->create_struct_builder();
dynamic_type->add_member(0, "id", DynamicTypeBuilderFactory::get_instance()->create_int32_type());
dynamic_type->add_member(1, "name", DynamicTypeBuilderFactory::get_instance()->create_string_type());
dynamic_type->build();

// 使用动态类型创建 Topic
TypeSupport type_support(new DynamicPubSubType(dynamic_type));
type_support.register_type(participant, "DynamicType");
```

### 学习要点
- TypeObject 类型描述
- 类型兼容性检查
- 向后兼容的版本演进

---

## Example 13: Benchmark

**路径**: `examples/cpp/benchmark/`  
**核心概念**: 性能基准测试，吞吐量、延迟测量  
**适用场景**: 性能调优、架构选型

### 关键代码

```cpp
// 配置测试参数
uint32_t payload_size = 1024;      // 1KB payload
uint32_t sample_count = 10000;     // 发送 10000 个样本
bool reliable = true;              // 可靠传输

// 测量吞吐量
auto start = std::chrono::high_resolution_clock::now();
for (uint32_t i = 0; i < sample_count; i++) {
    writer->write(&data);
}
auto end = std::chrono::high_resolution_clock::now();

auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(end - start);
double throughput = (payload_size * sample_count) / (duration.count() / 1000.0) / (1024*1024);
std::cout << "Throughput: " << throughput << " MB/s" << std::endl;
```

### 学习要点
- 吞吐量测试方法
- 延迟测试方法（往返时间）
- 不同 QoS 配置的性能对比

---

## 📊 示例学习路线图

```
Week 1: 基础
├── hello_world (DDS 基础)
├── rtps (RTPS 层)
└── configuration (XML 配置)

Week 2: 发现与连接
├── discovery_server (集中式发现)
├── static_edp_discovery (静态发现)
└── delivery_mechanisms (传输层)

Week 3: 高级特性
├── content_filter (过滤)
├── flow_control (流控)
├── topic_instances (多实例)
└── custom_payload_pool (内存优化)

Week 4: 生产实战
├── security (安全)
├── xtypes (动态类型)
└── benchmark (性能测试)
```

---

## ✅ 完整学习检查清单

- [x] Example 01: hello_world
- [x] Example 02: rtps
- [x] Example 03: discovery_server
- [ ] Example 04: static_edp_discovery
- [ ] Example 05: configuration
- [ ] Example 06: content_filter
- [ ] Example 07: flow_control
- [ ] Example 08: delivery_mechanisms
- [ ] Example 09: topic_instances
- [ ] Example 10: custom_payload_pool
- [ ] Example 11: security
- [ ] Example 12: xtypes
- [ ] Example 13: benchmark

---

_所有 13 个示例已覆盖！建议按路线图逐一学习。_
