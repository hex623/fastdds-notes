# 11 传输层与性能优化

**记录时间**: 2026-03-03  
**学习时长**: 约 1.5 小时  
**前置知识**: 01-10 基础笔记

---

## 1. 传输层全景

### 三种传输方式对比

| 传输方式 | 延迟 | 吞吐量 | 跨机器 | 可靠性 | 适用场景 |
|---------|------|--------|--------|--------|---------|
| **UDPv4** | 低 | 中高 | ✅ | 尽力而为 | 默认，局域网 |
| **TCPv4** | 中 | 高 | ✅ | 可靠 | 跨网段、NAT |
| **SHM** | **极低** | **极高** | ❌ | 可靠 | **同一机器（首选）** |

---

## 2. Locator - 网络地址标识

```cpp
// Locator 统一标识网络地址
struct Locator_t
{
    int32_t kind;           // 传输类型
    uint32_t port;          // 端口
    octet address[16];      // IP地址
};

// Locator 类型
#define LOCATOR_KIND_UDPv4  0x00000001
#define LOCATOR_KIND_TCPv4  0x00000004
#define LOCATOR_KIND_SHM    0x00000080

// 示例
Locator_t udp_locator;
udp_locator.kind = LOCATOR_KIND_UDPv4;
udp_locator.port = 7410;
IPLocator::setIPv4(udp_locator, "192.168.1.100");
```

---

## 3. UDPv4 传输（默认）

### 特点

- **无连接**：不需要建立连接，直接发送
- **尽力而为**：不保证送达，不保证顺序
- **低延迟**：无连接开销
- **可靠性通过 RTPS 实现**：ACKNACK + 重传

### 源码实现

```cpp
class UDPv4Transport : public TransportInterface
{
public:
    bool send(const octet* data, uint32_t size, 
              const Locator_t& remote_locator)
    {
        auto socket = get_socket_for_locator(remote_locator);
        
        struct sockaddr_in dest_addr;
        dest_addr.sin_family = AF_INET;
        dest_addr.sin_port = htons(remote_locator.port);
        memcpy(&dest_addr.sin_addr, remote_locator.address, 4);
        
        ssize_t sent = ::sendto(socket, data, size, 0,
                                (struct sockaddr*)&dest_addr, 
                                sizeof(dest_addr));
        
        return sent == size;
    }
    
    void receive_loop()
    {
        while (running_)
        {
            fd_set readfds;
            FD_ZERO(&readfds);
            FD_SET(socket_, &readfds);
            
            struct timeval timeout{0, 100000};
            select(socket_ + 1, &readfds, nullptr, nullptr, &timeout);
            
            if (FD_ISSET(socket_, &readfds))
            {
                octet buffer[65535];
                struct sockaddr_in src_addr;
                socklen_t addr_len = sizeof(src_addr);
                
                ssize_t received = ::recvfrom(socket_, buffer, sizeof(buffer), 0,
                                              (struct sockaddr*)&src_addr, 
                                              &addr_len);
                
                if (received > 0)
                {
                    process_rtps_message(buffer, received, src_addr);
                }
            }
        }
    }
};
```

### UDP 包大小限制

```cpp
#define UDP_MAX_PAYLOAD 65507  // 65535 - 20(IP头) - 8(UDP头)

// 配置
TransportDescriptor udp_desc;
udp_desc.maxMessageSize = 65507;
udp_desc.sendBufferSize = 1048576;      // 1MB
udp_desc.receiveBufferSize = 1048576;   // 1MB
```

---

## 4. TCPv4 传输

### 特点

- **面向连接**：需要建立 TCP 连接
- **可靠传输**：内核保证送达和顺序
- **适合跨网段**：支持 NAT、防火墙

### 使用场景

- 跨子网通信
- 需要 NAT 穿透
- 大数据传输（>64KB，避免 UDP 分片）

### 配置

```cpp
// 启用 TCP 传输
TCPv4TransportDescriptor tcp_desc;
tcp_desc.set_WAN_address("公网IP");
tcp_desc.add_listener_port(56542);

DomainParticipantQos qos;
qos.transport().user_transports.push_back(
    std::make_shared<TCPv4TransportDescriptor>(tcp_desc));
qos.transport().use_builtin_transports = false;
```

---

## 5. SHM（共享内存）传输 ⭐

### 为什么 SHM 最快？

| 操作 | UDP/TCP | SHM |
|------|---------|-----|
| 发送数据 | 系统调用 + 内核拷贝 + 网卡 | **memcpy 到共享内存** |
| 接收数据 | 网卡中断 + 内核拷贝 + 系统调用 | **memcpy 从共享内存** |
| 延迟 | 10-100 μs | **0.1-1 μs** |
| 吞吐量 | 1-10 Gbps | **10-100 Gbps** |

**快 100-1000 倍！**

### 实现原理

```
进程A (Writer)                共享内存                进程B (Reader)
    |                              |                         |
    |-- 1. 写入数据 --------------->|                         |
    |    memcpy(共享内存)          |                         |
    |                              |<-- 2. 读取数据 ---------|
    |                              |    memcpy(共享内存)     |
    |-- 3. 通知（信号/信号量）----->|                         |
                                   |<-- 4. 收到通知 ---------|
```

### 源码实现

```cpp
class SharedMemTransport : public TransportInterface
{
public:
    bool init()
    {
        using namespace boost::interprocess;
        
        // 创建共享内存
        shared_memory_object shm(create_only, "fastdds_shm", read_write);
        shm.truncate(100 * 1024 * 1024);  // 100MB
        
        region_ = mapped_region(shm, read_write);
        
        // 构造无锁队列
        void* addr = region_.get_address();
        queue_ = new (addr) lockfree::spsc_queue<ShmPacket, 
                         lockfree::capacity<1024>>();
        
        return true;
    }
    
    bool send(const octet* data, uint32_t size, 
              const Locator_t& remote_locator)
    {
        ShmPacket packet;
        packet.size = size;
        packet.data = allocate_from_pool(size);
        
        memcpy(packet.data, data, size);
        
        while (!queue_->push(packet))
        {
            std::this_thread::yield();
        }
        
        notify_receiver();
        return true;
    }
};
```

### 配置 SHM 传输

```cpp
// Fast-DDS 会自动检测：同一机器用 SHM，不同机器用 UDP/TCP
DomainParticipantQos qos;
qos.transport().use_builtin_transports = true;

// 或者显式配置（优先级顺序）
auto shm_transport = std::make_shared<SharedMemTransportDescriptor>();
shm_transport->segment_size(2 * 1024 * 1024);  // 2MB 段大小

auto udp_transport = std::make_shared<UDPv4TransportDescriptor>();

qos.transport().user_transports.push_back(shm_transport);  // 优先 SHM
qos.transport().user_transports.push_back(udp_transport);  // 备选 UDP
```

### SHM 注意事项

```cpp
// 1. 只能用于同一机器
// 2. 共享内存大小限制
shm_desc.segment_size(100 * 1024 * 1024);  // 100MB

// 3. 清理残留
// 如果进程崩溃，共享内存可能残留
// 需要手动清理：/dev/shm/fastdds_*

// 4. 权限
// 确保运行用户有 /dev/shm 的读写权限
```

---

## 6. 传输层选择策略

### 自动选择（推荐）

```cpp
// Fast-DDS 默认行为（智能选择）
DomainParticipantQos qos;
qos.transport().use_builtin_transports = true;

// 逻辑：
// 1. 检查目标地址是否是本地地址
// 2. 如果是，使用 SHM
// 3. 如果不是，使用 UDP
// 4. 如果配置了 TCP 且需要 NAT 穿透，使用 TCP
```

### 显式配置场景

```cpp
// 场景 1：强制使用 SHM（嵌入式系统，确定性要求）
DomainParticipantQos qos;
qos.transport().user_transports.push_back(
    std::make_shared<SharedMemTransportDescriptor>());
qos.transport().use_builtin_transports = false;

// 场景 2：强制使用 TCP（跨防火墙）
DomainParticipantQos qos;
auto tcp = std::make_shared<TCPv4TransportDescriptor>();
tcp->add_listener_port(56542);
qos.transport().user_transports.push_back(tcp);
qos.transport().use_builtin_transports = false;

// 场景 3：混合使用（SHM 优先，TCP 备用）
DomainParticipantQos qos;
qos.transport().user_transports.push_back(
    std::make_shared<SharedMemTransportDescriptor>());
qos.transport().user_transports.push_back(
    std::make_shared<TCPv4TransportDescriptor>());
```

---

## 7. 性能优化实战

### 优化 1：Socket 缓冲区大小

```cpp
// 增大缓冲区，减少丢包
UDPv4TransportDescriptor udp_desc;
udp_desc.sendBufferSize = 16 * 1024 * 1024;    // 16MB
udp_desc.receiveBufferSize = 16 * 1024 * 1024; // 16MB

// 系统级设置（Linux）
// sudo sysctl -w net.core.rmem_max=16777216
// sudo sysctl -w net.core.wmem_max=16777216
```

### 优化 2：零拷贝发送

```cpp
// 对于大数据，避免拷贝
class ZeroCopyWriter
{
public:
    void write_large_data(void* data, size_t size)
    {
        if (size > 64000)
        {
            send_as_fragments(data, size);
        }
        else
        {
            writer_->write(data);
        }
    }
};
```

### 优化 3：批处理（Batching）

```cpp
// 合并多个小样本一起发送
DataWriterQos qos;
qos.publish_mode().kind = ASYNCHRONOUS;
qos.reliable_writer_qos().times.batch_max_data_size = 64000;
qos.reliable_writer_qos().times.batch_max_delay = {0, 10000000};  // 10ms
```

### 优化 4：CPU 亲和性

```cpp
void set_thread_affinity(int cpu_core)
{
    cpu_set_t cpuset;
    CPU_ZERO(&cpuset);
    CPU_SET(cpu_core, &cpuset);
    pthread_setaffinity_np(pthread_self(), sizeof(cpu_set_t), &cpuset);
}

void receive_loop()
{
    set_thread_affinity(2);  // 绑定到 CPU 2
    // ...
}
```

---

## 8. 性能测试方法

### 延迟测试

```cpp
// 发送端
auto start = std::chrono::high_resolution_clock::now();
writer->write(&msg);

// 接收端
void on_data_available(DataReader* reader)
{
    auto end = std::chrono::high_resolution_clock::now();
    reader->take_next_sample(&msg, &info);
    
    auto latency = std::chrono::duration_cast<std::chrono::microseconds>(
        end - msg.timestamp);
    
    std::cout << "Latency: " << latency.count() << " us" << std::endl;
}
```

### 吞吐量测试

```cpp
std::atomic<uint64_t> bytes_sent{0};

void send_thread()
{
    while (running_)
    {
        writer->write(&large_msg);
        bytes_sent += sizeof(large_msg);
    }
}

void stats_thread()
{
    while (running_)
    {
        sleep(1);
        std::cout << "Throughput: " << bytes_sent / (1024*1024) << " MB/s" << std::endl;
        bytes_sent = 0;
    }
}
```

### 对比结果（典型值）

| 传输方式 | 延迟（us） | 吞吐量（MB/s） |
|---------|-----------|---------------|
| SHM | 0.5-2 | 5000+ |
| UDP（本地） | 10-50 | 1000 |
| UDP（局域网） | 100-500 | 100 |
| TCP（局域网） | 200-1000 | 80 |

---

## 参考链接

- [01 RTPS源码分析](./01-RTPS-Source-Analysis.md)
- [09 进阶主题](./09-Advanced-Topics.md)
- [10 监听与回调](./10-Listener-WaitSet.md)
- Fast-DDS 官方文档: https://fast-dds.docs.eprosima.com/
