# Fast-DDS 性能优化指南

## 目录
1. [概述](#概述)
2. [性能关键参数](#性能关键参数)
3. [内存优化](#内存优化)
4. [网络优化](#网络优化)
5. [QoS 性能权衡](#qos-性能权衡)
6. [监控指标](#监控指标)
7. [性能测试方法](#性能测试方法)
8. [总结](#总结)

---

## 概述

Fast-DDS 作为 DDS（Data Distribution Service）规范的高性能实现，在实时通信、机器人、自动驾驶等场景中广泛应用。性能优化是部署 Fast-DDS 系统的关键环节，涉及缓冲区配置、线程调度、内存管理、网络传输等多个层面。

本文档总结 Fast-DDS 性能优化的核心要点，帮助开发者在实际项目中实现低延迟、高吞吐的通信效果。

---

## 性能关键参数

### 1. 缓冲区大小配置

缓冲区大小直接影响数据传输效率和内存占用，需要根据应用场景进行权衡。

#### 发送缓冲区配置

```xml
<!-- Fast-DDS XML 配置示例 -->
<participant profile_name="high_throughput">
    <rtps>
        <sendSocketBufferSize>1048576</sendSocketBufferSize>  <!-- 1MB -->
        <listenSocketBufferSize>1048576</listenSocketBufferSize>
        <builtin>
            <metatrafficUnicastLocatorList>
                <locator>
                    <udpv4>
                        <port>7412</port>
                    </udpv4>
                </locator>
            </metatrafficUnicastLocatorList>
        </builtin>
    </rtps>
</participant>
```

#### 历史缓存配置

```cpp
// 代码配置示例
DataWriterQos writer_qos;
writer_qos.history().kind = KEEP_LAST_HISTORY_QOS;
writer_qos.history().depth = 100;  // 根据需求调整
writer_qos.resource_limits().max_samples = 500;
writer_qos.resource_limits().max_instances = 10;
writer_qos.resource_limits().max_samples_per_instance = 50;
```

**优化建议：**
- 高吞吐场景：增大缓冲区（4MB-16MB）
- 低延迟场景：保持适中缓冲区（1MB-4MB）
- 内存受限场景：减小缓冲区，配合流控策略

### 2. 线程配置

Fast-DDS 使用多线程架构处理不同任务，合理配置线程数量和优先级至关重要。

```xml
<participant profile_name="optimized_threads">
    <rtps>
        <!-- 事件线程配置 -->
        <async_thread>
            <scheduling_policy>FIFO</scheduling_policy>
            <priority>60</priority>
        </async_thread>
        
        <!-- 发送线程配置 -->
        <send_thread>
            <scheduling_policy>FIFO</scheduling_policy>
            <priority>55</priority>
        </send_thread>
        
        <!-- 接收线程配置 -->
        <recv_thread>
            <scheduling_policy>FIFO</scheduling_policy>
            <priority>55</priority>
        </recv_thread>
    </rtps>
</participant>
```

**关键线程说明：**

| 线程类型 | 功能 | 优化建议 |
|---------|------|---------|
| Event Thread | 处理定时事件、心跳 | 提高优先级，减少延迟 |
| Async Write Thread | 异步数据写入 | 高吞吐场景启用 |
| Reception Thread | 接收网络数据 | 多网卡场景配置多个 |
| Keep-alive Thread | 维护连接状态 | 默认配置即可 |

---

## 内存优化

### 1. 内存预分配

预分配内存可以避免运行时动态分配的开销，减少内存碎片。

```cpp
// DataWriter 内存预分配
DataWriterQos writer_qos;
writer_qos.resource_limits().allocated_samples = 100;
writer_qos.resource_limits().extra_samples = 20;

// 使用固定大小内存池
writer_qos.resource_limits().max_samples = 120;
writer_qos.resource_limits().max_samples_per_instance = 120;
```

### 2. 内存池配置

Fast-DDS 提供自定义内存池机制，适用于对内存分配敏感的场景。

```cpp
#include <fastdds/dds/core/policy/ResourceLimitsQosPolicy.hpp>

// 配置固定内存池
class CustomMemoryPolicy {
public:
    static constexpr size_t POOL_SIZE = 1024 * 1024 * 10;  // 10MB 内存池
    static constexpr size_t BLOCK_SIZE = 1024;              // 1KB 块大小
};

// 在 QoS 中启用内存池
DataWriterQos pool_qos;
pool_qos.endpoint().history_memory_policy = PREALLOCATED_WITH_REALLOC_MEMORY_MODE;
```

### 3. 内存模式对比

| 内存模式 | 延迟 | 内存占用 | 适用场景 |
|---------|------|---------|---------|
| `PREALLOCATED_MEMORY_MODE` | 最低 | 最高 | 固定消息大小，追求最低延迟 |
| `PREALLOCATED_WITH_REALLOC_MEMORY_MODE` | 低 | 中高 | 消息大小变化较小 |
| `DYNAMIC_RESERVE_MEMORY_MODE` | 较高 | 最低 | 消息大小变化大，内存受限 |
| `DYNAMIC_REUSABLE_MEMORY_MODE` | 中等 | 低 | 平衡性能与内存 |

---

## 网络优化

### 1. 零拷贝传输

零拷贝技术避免数据在用户空间和内核空间之间的多次拷贝，显著降低 CPU 占用和延迟。

```cpp
// 启用共享内存传输（ intra-process 零拷贝）
DomainParticipantQos participant_qos;
participant_qos.transport().use_builtin_transports = false;

// 添加共享内存传输
auto shm_transport = std::make_shared<SharedMemTransportDescriptor>();
shm_transport->segment_size(1024 * 1024 * 64);  // 64MB 共享内存段
shm_transport->max_message_size(65536);
participant_qos.transport().user_transports.push_back(shm_transport);

// 保留 UDP 用于跨进程通信
auto udp_transport = std::make_shared<UDPv4TransportDescriptor>();
participant_qos.transport().user_transports.push_back(udp_transport);
```

### 2. 数据批处理

批处理将多个小数据包合并发送，减少网络开销，提高吞吐。

```cpp
DataWriterQos batch_qos;

// 启用批处理
batch_qos.publish_mode().kind = ASYNCHRONOUS_PUBLISH_MODE;
batch_qos.reliable_writer_qos().times.batching_duration = eprosima::fastdds::dds::Time_t(0, 10000000);  // 10ms

// 批处理触发条件
batch_qos.reliable_writer_qos().times.batch_separation_delay = eprosima::fastdds::dds::Time_t(0, 5000000);  // 5ms

// 最大批处理大小
batch_qos.resource_limits().max_samples = 50;  // 每批最多 50 个样本
```

### 3. 网络接口优化

```xml
<transport_descriptors>
    <transport_descriptor>
        <transport_id>udp_optimized</transport_id>
        <type>UDPv4</type>
        <sendBufferSize>2097152</sendBufferSize>
        <receiveBufferSize>2097152</receiveBufferSize>
        <non_blocking_send>true</non_blocking_send>
        <maxMessageSize>65500</maxMessageSize>
        <maxInitialPeersRange>4</maxInitialPeersRange>
    </transport_descriptor>
</transport_descriptors>
```

---

## QoS 性能权衡

QoS（Quality of Service）策略的选择直接影响性能和功能平衡。

### 1. 可靠性 vs 延迟

```cpp
// 低延迟优先（BEST_EFFORT）
DataReaderQos low_latency_qos;
low_latency_qos.reliability().kind = BEST_EFFORT_RELIABILITY_QOS;

// 高可靠优先（RELIABLE）
DataReaderQos reliable_qos;
reliable_qos.reliability().kind = RELIABLE_RELIABILITY_QOS;
reliable_qos.reliable_reader_qos().times.heartbeat_response_delay = eprosima::fastdds::dds::Time_t(0, 5000000);  // 5ms
```

### 2. 持久性配置

```cpp
// 高性能模式（VOLATILE）
DataWriterQos volatile_qos;
volatile_qos.durability().kind = VOLATILE_DURABILITY_QOS;

// 持久化模式（PERSISTENT）- 影响性能
DataWriterQos persistent_qos;
persistent_qos.durability().kind = PERSISTENT_DURABILITY_QOS;
persistent_qos.durability_service().history_kind = KEEP_LAST_HISTORY_QOS;
persistent_qos.durability_service().history_depth = 10;
```

### 3. QoS 性能对比表

| QoS 策略 | 性能影响 | 建议 |
|---------|---------|------|
| `RELIABLE` vs `BEST_EFFORT` | 可靠性增加 20-30% 开销 | 关键数据用 RELIABLE，实时数据用 BEST_EFFORT |
| `TRANSIENT_LOCAL` | 增加内存占用 | 避免大历史深度 |
| `EXCLUSIVE_OWNERSHIP` | 增加复杂度 | 多发布者场景使用 |
| `TIME_BASED_FILTER` | 减少 CPU/网络 | 高频率数据订阅时使用 |

---

## 监控指标

### 1. 延迟（Latency）

```cpp
// 使用 Fast-DDS 内置统计模块
dds::domain::DomainParticipant::enable_statistics_datawriter(
    dds::statistics::statistics_topic_names::SUBSCRIPTION_THROUGHPUT_TOPIC,
    statistics_qos);

// 自定义延迟测量
class LatencyMonitor {
    std::chrono::high_resolution_clock::time_point start_time_;
    
public:
    void on_send() {
        start_time_ = std::chrono::high_resolution_clock::now();
    }
    
    void on_receive() {
        auto end_time = std::chrono::high_resolution_clock::now();
        auto latency = std::chrono::duration_cast<std::chrono::microseconds>(end_time - start_time_);
        printf("Latency: %ld μs\n", latency.count());
    }
};
```

**延迟目标参考：**
- 普通场景：< 10ms
- 实时场景：< 1ms
- 硬实时场景：< 100μs

### 2. 吞吐量（Throughput）

```bash
# 使用 Fast-DDS 性能测试工具
ros2 run performance_test performance_test -c FastDDS --rate 1000 --max-runtime 60
```

**监控命令：**

```bash
# Linux 系统级监控
iftop -i eth0                    # 网络带宽监控
pidstat -p $(pgrep fastdds) 1    # 进程 CPU/内存
watch -n 1 'cat /proc/net/snmp | grep Udp'  # UDP 统计
```

### 3. 丢包率（Packet Loss）

```cpp
// 通过序列号统计丢包
class PacketLossMonitor {
    uint32_t expected_seq_ = 0;
    uint32_t lost_packets_ = 0;
    uint32_t total_packets_ = 0;
    
public:
    void on_packet_received(uint32_t seq_num) {
        total_packets_++;
        if (seq_num > expected_seq_) {
            lost_packets_ += (seq_num - expected_seq_);
        }
        expected_seq_ = seq_num + 1;
    }
    
    double get_loss_rate() const {
        return total_packets_ > 0 ? 
            (static_cast<double>(lost_packets_) / total_packets_) * 100.0 : 0.0;
    }
};
```

**丢包率指标：**
- 优秀：< 0.01%
- 良好：< 0.1%
- 需优化：> 1%

---

## 性能测试方法

### 1. 基准测试工具

```bash
# 安装性能测试工具
git clone https://github.com/eProsima/Fast-DDS.git
cd Fast-DDS/test/performance/throughput
cmake -B build && cmake --build build

# 运行吞吐量测试
./build/throughput_test --samples=100000 --data_size=1024 --export_csv=results.csv
```

### 2. 延迟测试配置

```cpp
// 延迟测试程序框架
#include <fastdds/dds/domain/DomainParticipantFactory.hpp>
#include <chrono>

class LatencyTest {
    static constexpr int SAMPLES = 10000;
    static constexpr int DATA_SIZE = 1024;
    
public:
    void run_test() {
        std::vector<double> latencies;
        latencies.reserve(SAMPLES);
        
        for (int i = 0; i < SAMPLES; ++i) {
            auto start = std::chrono::steady_clock::now();
            send_data(DATA_SIZE);
            wait_for_response();
            auto end = std::chrono::steady_clock::now();
            
            double latency_us = std::chrono::duration<double, std::micro>(end - start).count();
            latencies.push_back(latency_us);
        }
        
        analyze_results(latencies);
    }
    
private:
    void analyze_results(const std::vector<double>& latencies) {
        double sum = std::accumulate(latencies.begin(), latencies.end(), 0.0);
        double mean = sum / latencies.size();
        
        double sq_sum = std::inner_product(latencies.begin(), latencies.end(), 
                                           latencies.begin(), 0.0);
        double std_dev = std::sqrt(sq_sum / latencies.size() - mean * mean);
        
        auto [min_it, max_it] = std::minmax_element(latencies.begin(), latencies.end());
        
        printf("Latency Statistics:\n");
        printf("  Mean: %.2f μs\n", mean);
        printf("  Min:  %.2f μs\n", *min_it);
        printf("  Max:  %.2f μs\n", *max_it);
        printf("  Std:  %.2f μs\n", std_dev);
    }
};
```

### 3. 性能调优检查清单

```markdown
## 部署前检查项

### 系统级
- [ ] 网络缓冲区已优化 (`net.core.rmem_max`, `net.core.wmem_max`)
- [ ] 实时内核或低延迟内核已启用
- [ ] CPU 频率调节器设置为 `performance`
- [ ] NUMA 亲和性已配置（多 CPU 系统）

### Fast-DDS 配置
- [ ] 缓冲区大小根据消息大小调整
- [ ] 线程优先级已设置（实时场景）
- [ ] 内存模式根据场景选择
- [ ] QoS 策略权衡性能与功能
- [ ] 批处理已启用（小消息高吞吐场景）

### 应用级
- [ ] 发布/订阅端负载均衡
- [ ] 避免内存频繁分配/释放
- [ ] 数据序列化优化
- [ ] 回调函数执行时间最小化
```

---

## 总结

Fast-DDS 性能优化需要系统性的方法，从硬件、操作系统、网络到应用层全方位考虑。关键要点：

1. **内存优化**：使用预分配和内存池，选择适合的内存模式
2. **网络优化**：启用零拷贝、批处理，调整缓冲区大小
3. **线程优化**：合理配置线程数量和优先级
4. **QoS 权衡**：根据场景选择合适的可靠性级别
5. **持续监控**：建立延迟、吞吐、丢包等关键指标的监控体系

性能优化是一个持续迭代的过程，建议在实际部署环境中进行充分的性能测试，根据监控数据持续调优。

---

## 参考资源

- [Fast-DDS 官方文档](https://fast-dds.docs.eprosima.com/)
- [DDS 规范 - OMG](https://www.omg.org/spec/DDS/)
- [Fast-DDS GitHub](https://github.com/eProsima/Fast-DDS)
- [ROS2 DDS 调优指南](https://docs.ros.org/en/rolling/How-To-Guides/DDS-Tuning.html)

---

*文档版本：v1.0*  
*最后更新：2024年*
