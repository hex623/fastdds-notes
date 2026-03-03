# Fast-DDS 传输层 (Transport) 实现详解

## 1. 概述

Fast-DDS 传输层负责 RTPS 消息在网络中的实际收发。它提供了一个可扩展的架构，支持多种底层传输协议，包括 UDPv4、UDPv6、TCPv4、TCPv6 以及共享内存 (SHM) 传输。本章将深入分析传输层的架构设计、核心接口实现以及各种传输协议的特点和配置方法。

---

## 2. 传输层架构

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Fast-DDS 传输层架构                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐  │
│   │                    TransportInterface (抽象接口)                     │  │
│   │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌─────────────┐ │  │
│   │  │  OpenInput   │ │ OpenOutput   │ │    Send      │ │   Receive   │ │  │
│   │  │   Channel    │ │   Channel    │ │              │ │             │ │  │
│   │  └──────────────┘ └──────────────┘ └──────────────┘ └─────────────┘ │  │
│   └─────────────────────────────────────────────────────────────────────┘  │
│                              ▲                                              │
│           ┌──────────────────┼──────────────────┐                          │
│           │                  │                  │                          │
│   ┌───────┴───────┐  ┌───────┴───────┐  ┌───────┴───────┐                  │
│   │ UDPTransport  │  │ TCPTransport  │  │  SharedMem    │                  │
│   │  Interface    │  │  Interface    │  │   Transport   │                  │
│   └───────┬───────┘  └───────┬───────┘  └───────┬───────┘                  │
│           │                  │                  │                          │
│      ┌────┴────┐        ┌────┴────┐            │                          │
│      │         │        │         │            │                          │
│   ┌──┴──┐   ┌──┴──┐  ┌──┴──┐   ┌──┴──┐    ┌───┴────┐                     │
│   │UDPv4│   │UDPv6│  │TCPv4│   │TCPv6│    │  SHM   │                     │
│   └─────┘   └─────┘  └─────┘   └─────┘    └────────┘                     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 核心组件说明

| 组件 | 说明 |
|------|------|
| `TransportInterface` | 所有传输层的抽象基类，定义统一接口 |
| `UDPTransportInterface` | UDP 传输的抽象基类，实现 UDP 通用逻辑 |
| `TCPTransportInterface` | TCP 传输的抽象基类，实现 TCP 通用逻辑 |
| `SharedMemTransport` | 共享内存传输实现，用于本机高性能通信 |
| `UDPv4Transport` / `UDPv6Transport` | UDP 传输的具体实现 |
| `TCPv4Transport` / `TCPv6Transport` | TCP 传输的具体实现 |

---

## 3. TransportInterface 设计

### 3.1 核心接口定义

`TransportInterface` 是所有传输层的抽象基类，定义了传输层必须实现的核心方法：

```cpp
class TransportInterface {
public:
    // 初始化传输层
    virtual bool init(const PropertyPolicy* properties = nullptr, 
                      const uint32_t& max_msg_size_no_frag = 0) = 0;
    
    // 输入通道管理
    virtual bool OpenInputChannel(const Locator&, TransportReceiverInterface*, uint32_t) = 0;
    virtual bool CloseInputChannel(const Locator&) = 0;
    virtual bool IsInputChannelOpen(const Locator&) const = 0;
    
    // 输出通道管理
    virtual bool OpenOutputChannel(SendResourceList& sender_resource_list, const Locator&) = 0;
    
    // Locator 相关操作
    virtual bool IsLocatorSupported(const Locator&) const = 0;
    virtual Locator RemoteToMainLocal(const Locator& remote) const = 0;
    virtual bool is_local_locator(const Locator& locator) const = 0;
    
    // 发送和接收
    virtual uint32_t max_recv_buffer_size() const = 0;
    
    // 关闭和清理
    virtual void shutdown() {}
};
```

### 3.2 关键常量定义

```cpp
// 默认最大消息大小 (65KB - 36字节 UDP 头)
constexpr uint32_t s_maximumMessageSize = 65500;

// 默认初始 peers 范围
constexpr uint32_t s_maximumInitialPeersRange = 4;

// 默认地址
static const std::string s_IPv4AddressAny = "0.0.0.0";
static const std::string s_IPv6AddressAny = "::";
```

### 3.3 Locator 与 Channel 映射

传输层建立了 Locator（定位器）与 Channel（通道）之间的映射关系：

```
Locator (逻辑地址)          Channel (物理通道)
     │                            │
     ├─ IP 地址 ─────────────────┤
     ├─ 端口 ────────────────────┤
     └─ Kind (UDP/TCP/SHM) ─────┘
```

在 UDP 中，一个端口对应一个 Channel；在 TCP 中，一个连接对应一个 Channel；在 SHM 中，一个共享内存端口对应一个 Channel。

---

## 4. UDPTransport 实现详解

### 4.1 UDP 架构特点

```
┌─────────────────────────────────────────────────────────────┐
│                    UDPTransportInterface                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   ┌─────────────────┐        ┌─────────────────────────┐   │
│   │   Input Sockets │        │   Output Sockets        │   │
│   │   (监听端口)     │        │   (发送端口)             │   │
│   │                 │        │                         │   │
│   │  • Port 7400    │        │  • 0.0.0.0:random       │   │
│   │  • Port 7401    │        │  • Interface-specific   │   │
│   │  • Multicast    │        │                         │   │
│   └─────────────────┘        └─────────────────────────┘   │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │                ASIO io_context                       │   │
│   │         (异步 I/O 事件循环)                          │   │
│   └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 UDP 关键特性

| 特性 | 说明 |
|------|------|
| **无连接** | UDP 是无连接协议，发送前不需要建立连接 |
| **多播支持** | 天然支持多播通信，适合 DDS 的发现机制 |
| **端口复用** | 通过 `SO_REUSEADDR` 支持多个进程监听同一端口 |
| **非阻塞发送** | 可配置 `non_blocking_send` 避免发送阻塞 |

### 4.3 UDPv4Transport 核心实现

```cpp
class UDPv4Transport : public UDPTransportInterface {
public:
    // 打开输入通道：监听指定端口，加入多播组
    bool OpenInputChannel(const Locator&, TransportReceiverInterface*, uint32_t) override;
    
    // 创建和绑定输入 Socket
    eProsimaUDPSocket OpenAndBindInputSocket(const std::string& sIp, 
                                              uint16_t port, 
                                              bool is_multicast);
    
    // 生成端点
    asio::ip::udp::endpoint generate_endpoint(uint16_t port) override;
    asio::ip::udp::endpoint generate_endpoint(const Locator& loc, uint16_t port) override;
    
protected:
    UDPv4TransportDescriptor configuration_;
    std::vector<asio::ip::address_v4> interface_whitelist_;  // 接口白名单
};
```

### 4.4 UDP 配置参数

```cpp
struct UDPTransportDescriptor : public SocketTransportDescriptor {
    uint16_t m_output_udp_socket;  // 源端口（0 表示随机）
    bool non_blocking_send = false; // 是否使用非阻塞发送
};
```

### 4.5 UDP 数据发送流程

```
1. 应用层调用 write()
        │
        ▼
2. OpenOutputChannel() - 打开输出通道
        │
        ▼
3. send() - 通过 ASIO 发送数据报
        │
        ▼
4. 底层 Socket send_to() - 发送到目标地址
```

---

## 5. TCPTransport 特点与配置

### 5.1 TCP 架构特点

```
┌─────────────────────────────────────────────────────────────────┐
│                     TCPTransportInterface                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌──────────────────┐      ┌──────────────────────────────┐   │
│   │   Acceptor       │      │   Channel Resources          │   │
│   │   (监听连接)      │      │   (已建立的连接)              │   │
│   │                  │      │                              │   │
│   │  • 监听端口 7400  │─────▶│  • Channel 1 (192.168.1.10)  │   │
│   │  • 监听端口 7401  │      │  • Channel 2 (192.168.1.11)  │   │
│   └──────────────────┘      │  • ...                       │   │
│                             └──────────────────────────────┘   │
│                                                                  │
│   ┌──────────────────────────────────────────────────────────┐  │
│   │              RTCP Message Manager (RTCP 协议管理)          │  │
│   │     • Keep-alive 检测                                     │  │
│   │     • Logical Port 协商                                   │  │
│   │     • CRC 校验                                            │  │
│   └──────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 TCP 关键特性

| 特性 | 说明 |
|------|------|
| **面向连接** | 需要建立 TCP 连接后才能通信 |
| **可靠性** | 内置重传机制，保证数据可靠到达 |
| **大消息支持** | 支持大于 64KB 的消息传输 |
| **NAT 穿透** | 支持 WAN 地址配置，可用于跨 NAT 通信 |
| **TLS 安全** | 支持 TLS/SSL 加密传输 |

### 5.3 TCP 连接管理

TCP 传输使用 **逻辑端口 (Logical Port)** 机制来管理多路复用：

```
Physical Connection (TCP Socket)
         │
         ├─ Logical Port 7400 ──▶ DomainParticipant 1
         ├─ Logical Port 7401 ──▶ DomainParticipant 2
         ├─ Logical Port 7402 ──▶ DomainParticipant 3
         └─ ...
```

### 5.4 TCP 配置参数详解

```cpp
struct TCPTransportDescriptor : public SocketTransportDescriptor {
    // 监听端口列表
    std::vector<uint16_t> listening_ports;
    
    // Keep-alive 配置
    uint32_t keep_alive_frequency_ms;      // Keep-alive 发送频率
    uint32_t keep_alive_timeout_ms;        // 连接超时时间
    
    // Logical Port 配置
    uint16_t max_logical_port;             // 最大逻辑端口
    uint16_t logical_port_range;           // 逻辑端口范围
    uint16_t logical_port_increment;       // 逻辑端口增量
    
    // TCP 选项
    bool enable_tcp_nodelay;               // 启用 TCP_NODELAY
    bool calculate_crc;                    // 计算 CRC
    bool check_crc;                        // 检查 CRC
    bool non_blocking_send;                // 非阻塞发送
    
    // TLS 配置
    bool apply_security;                   // 启用 TLS
    TLSConfig tls_config;                  // TLS 详细配置
};
```

### 5.5 TCPv4 WAN 支持

TCPv4 支持配置 WAN 地址用于 NAT 穿透：

```cpp
struct TCPv4TransportDescriptor : public TCPTransportDescriptor {
    fastdds::rtps::octet wan_addr[4];  // 公网 IP 地址
    
    // 设置 WAN 地址
    void set_WAN_address(const std::string& in_address) {
        // 解析 IP 字符串 (如 "203.0.113.1")
    }
    
    std::string get_WAN_address() {
        // 返回格式: "203.0.113.1"
    }
};
```

### 5.6 TCP TLS 配置

```cpp
struct TLSConfig {
    std::string password;                  // 私钥密码
    std::string private_key_file;          // 私钥文件路径
    std::string rsa_private_key_file;      // RSA 私钥文件路径
    std::string cert_chain_file;           // 证书链文件
    std::string tmp_dh_file;               // DH 参数文件
    std::string verify_file;               // CA 证书文件
    
    uint32_t options;                      // SSL 选项 (TLSOptions 枚举)
    uint8_t verify_mode;                   // 验证模式 (TLSVerifyMode 枚举)
    TLSHandShakeRole handshake_role;       // 握手角色 (CLIENT/SERVER/DEFAULT)
    
    enum TLSOptions {
        NONE = 0,
        DEFAULT_WORKAROUNDS = 1 << 0,
        NO_COMPRESSION = 1 << 1,
        NO_SSLV2 = 1 << 2,
        NO_SSLV3 = 1 << 3,
        NO_TLSV1 = 1 << 4,
        NO_TLSV1_1 = 1 << 5,
        NO_TLSV1_2 = 1 << 6,
        NO_TLSV1_3 = 1 << 7,
        SINGLE_DH_USE = 1 << 8
    };
    
    enum TLSVerifyMode {
        UNUSED = 0,
        VERIFY_NONE = 1 << 0,
        VERIFY_PEER = 1 << 1,
        VERIFY_FAIL_IF_NO_PEER_CERT = 1 << 2,
        VERIFY_CLIENT_ONCE = 1 << 3
    };
};
```

---

## 6. 共享内存 (SHM) 传输优化

### 6.1 SHM 架构特点

```
┌─────────────────────────────────────────────────────────────────┐
│                    SharedMemTransport                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                  Shared Memory Segment                     │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌───────────┐  │  │
│  │  │   Segment 1     │  │   Segment 2     │  │    ...    │  │  │
│  │  │  (512KB-64MB)   │  │  (512KB-64MB)   │  │           │  │  │
│  │  │                 │  │                 │  │           │  │  │
│  │  │ ┌─────────────┐ │  │ ┌─────────────┐ │  │ ┌───────┐ │  │  │
│  │  │ │   Buffer 1  │ │  │ │   Buffer 1  │ │  │ │  ...  │ │  │  │
│  │  │ ├─────────────┤ │  │ ├─────────────┤ │  │ ├───────┤ │  │  │
│  │  │ │   Buffer 2  │ │  │ │   Buffer 2  │ │  │ │  ...  │ │  │  │
│  │  │ └─────────────┘ │  │ └─────────────┘ │  │ └───────┘ │  │  │
│  │  └─────────────────┘  └─────────────────┘  └───────────┘  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌──────────────────┐      ┌──────────────────┐                 │
│  │   Input Ports    │      │   Output Ports   │                 │
│  │  (监听端口)       │      │  (发送端口)       │                 │
│  │                  │      │                  │                 │
│  │  • Port 0        │      │  • Dynamic open  │                 │
│  │  • Port 1        │      │  • On send       │                 │
│  └──────────────────┘      └──────────────────┘                 │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 SHM 核心优势

| 优势 | 说明 |
|------|------|
| **零拷贝** | 消息直接写入共享内存，无需内核态/用户态拷贝 |
| **极低延迟** | 比 UDP/TCP 快 10-100 倍，微秒级延迟 |
| **高吞吐** | 适合大消息传输，可达 GB/s 级别 |
| **CPU 友好** | 减少系统调用和中断处理开销 |

### 6.3 SHM 端口机制

```
┌──────────────────────────────────────────────────────────────┐
│                    Shared Memory Port                         │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │              Port Queue (环形缓冲区)                     │  │
│  │                                                         │  │
│  │   ┌─────┐   ┌─────┐   ┌─────┐   ┌─────┐   ┌─────┐     │  │
│  │   │ Msg │ → │ Msg │ → │ Msg │ → │ Msg │ → │ Msg │     │  │
│  │   │  1  │   │  2  │   │  3  │   │  4  │   │  5  │     │  │
│  │   └─────┘   └─────┘   └─────┘   └─────┘   └─────┘     │  │
│  │                                                         │  │
│  │  • 容量: port_queue_capacity (默认 512 消息)            │  │
│  │  • 机制: 多生产者单消费者 (MPSC)                        │  │
│  │  • 阻塞: 可配置超时等待                                  │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │              Segment Reference                         │  │
│  │                                                         │  │
│  │  消息体存储在 Shared Memory Segment 中，Port 只保存      │  │
│  │  指向实际数据的引用 (BufferDescriptor)                   │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

### 6.4 SHM 配置参数

```cpp
struct SharedMemTransportDescriptor : public PortBasedTransportDescriptor {
    static constexpr uint32_t shm_default_segment_size = 0;           // 默认段大小
    static constexpr uint32_t shm_default_port_queue_capacity = 512;  // 默认端口队列容量
    static constexpr uint32_t shm_default_healthy_check_timeout_ms = 1000; // 健康检查超时
    static constexpr uint32_t shm_implicit_segment_size = 512 * 1024; // 隐式段大小 (512KB)
    
    // 配置方法
    void segment_size(uint32_t segment_size);        // 设置段大小
    void max_message_size(uint32_t max_message_size); // 设置最大消息大小
    void port_queue_capacity(uint32_t capacity);     // 设置端口队列容量
    void healthy_check_timeout_ms(uint32_t timeout); // 设置健康检查超时
    void rtps_dump_file(const std::string& path);    // 设置协议转储文件
};
```

### 6.5 SHM 健康检查机制

共享内存传输实现了健康检查机制来处理进程崩溃：

```cpp
// 健康检查超时配置 (默认 1000ms)
uint32_t healthy_check_timeout_ms_ = 1000;

// 健康检查流程:
// 1. 发送方写入消息后，等待接收方确认
// 2. 接收方处理完消息后，释放共享缓冲区
// 3. 如果发送方在超时时间内未收到确认，触发健康检查
// 4. 检测到对端进程崩溃后，清理相关资源
```

---

## 7. 代码示例：配置不同传输层

### 7.1 配置 UDPv4 传输

```cpp
#include <fastdds/dds/domain/DomainParticipantFactory.hpp>
#include <fastdds/rtps/transport/UDPv4TransportDescriptor.hpp>

using namespace eprosima::fastdds::rtps;

// 创建 UDPv4 传输描述符
auto udp_transport = std::make_shared<UDPv4TransportDescriptor>();

// 配置发送缓冲区大小 (字节)
udp_transport->sendBufferSize = 65536;     // 64KB
udp_transport->receiveBufferSize = 524288;  // 512KB

// 配置输出 UDP Socket 源端口 (0 表示随机)
udp_transport->m_output_udp_socket = 0;

// 启用非阻塞发送 (高频写入场景推荐)
udp_transport->non_blocking_send = true;

// 配置接口白名单 (可选，限制允许的网络接口)
udp_transport->interfaceWhiteList.push_back("192.168.1.100");
udp_transport->interfaceWhiteList.push_back("127.0.0.1");

// 禁用多播 (纯单播场景)
udp_transport->TTL = 1;  // 生存时间

// 创建 Participant QoS
eprosima::fastdds::dds::DomainParticipantQos pqos;
pqos.transport().user_transports.push_back(udp_transport);
pqos.transport().use_builtin_transports = false;  // 禁用默认传输

// 创建 Participant
auto participant = eprosima::fastdds::dds::DomainParticipantFactory::get_instance()
    ->create_participant(0, pqos);
```

### 7.2 配置 TCPv4 传输

```cpp
#include <fastdds/rtps/transport/TCPv4TransportDescriptor.hpp>

// 创建 TCPv4 传输描述符
auto tcp_transport = std::make_shared<TCPv4TransportDescriptor>();

// 配置监听端口
tcp_transport->add_listener_port(5100);
tcp_transport->add_listener_port(5101);

// 配置 WAN 地址 (用于 NAT 穿越)
tcp_transport->set_WAN_address("203.0.113.1");

// 配置 Keep-alive
tcp_transport->keep_alive_frequency_ms = 5000;   // 5 秒发送一次 keep-alive
tcp_transport->keep_alive_timeout_ms = 15000;    // 15 秒超时断开

// 配置 Logical Port
tcp_transport->max_logical_port = 100;           // 最大逻辑端口数
tcp_transport->logical_port_range = 20;          // 每次尝试范围
tcp_transport->logical_port_increment = 2;       // 端口增量

// 启用 TCP_NODELAY (减少延迟)
tcp_transport->enable_tcp_nodelay = true;

// 启用 CRC 校验
tcp_transport->calculate_crc = true;
tcp_transport->check_crc = true;

// 配置非阻塞发送
tcp_transport->non_blocking_send = true;

// 配置 TLS (可选)
tcp_transport->apply_security = true;
tcp_transport->tls_config.password = "password";
tcp_transport->tls_config.cert_chain_file = "server.crt";
tcp_transport->tls_config.private_key_file = "server.key";
tcp_transport->tls_config.verify_file = "ca.crt";
tcp_transport->tls_config.verify_mode = TCPTransportDescriptor::TLSConfig::VERIFY_PEER;
tcp_transport->tls_config.add_option(
    TCPTransportDescriptor::TLSConfig::TLSOptions::NO_TLSV1);

// 创建 Participant QoS
eprosima::fastdds::dds::DomainParticipantQos pqos;
pqos.transport().user_transports.push_back(tcp_transport);
pqos.transport().use_builtin_transports = false;

// 配置初始 Peers (TCP 需要显式指定)
Locator_t initial_peer;
initial_peer.kind = LOCATOR_KIND_TCPv4;
IPLocator::setIPv4(initial_peer, "192.168.1.100");
IPLocator::setPhysicalPort(initial_peer, 5100);
IPLocator::setLogicalPort(initial_peer, 7400);
pqos.wire_protocol().builtin.initialPeersList.push_back(initial_peer);
```

### 7.3 配置共享内存传输

```cpp
#include <fastdds/rtps/transport/shared_mem/SharedMemTransportDescriptor.hpp>

// 创建 SHM 传输描述符
auto shm_transport = std::make_shared<SharedMemTransportDescriptor>();

// 配置共享内存段大小
shm_transport->segment_size(1024 * 1024);  // 1MB

// 配置端口队列容量
shm_transport->port_queue_capacity(1024);   // 1024 条消息

// 配置健康检查超时
shm_transport->healthy_check_timeout_ms(2000);  // 2 秒

// 配置最大消息大小
shm_transport->max_message_size(65536);  // 64KB

// 配置协议转储 (调试用)
shm_transport->rtps_dump_file("/tmp/fastdds_shm_dump.log");

// 创建 Participant QoS
eprosima::fastdds::dds::DomainParticipantQos pqos;
pqos.transport().user_transports.push_back(shm_transport);
pqos.transport().use_builtin_transports = false;
```

### 7.4 混合传输配置

```cpp
// 同时配置 SHM + UDP，实现同机高速 + 跨机通信
auto shm_transport = std::make_shared<SharedMemTransportDescriptor>();
auto udp_transport = std::make_shared<UDPv4TransportDescriptor>();

eprosima::fastdds::dds::DomainParticipantQos pqos;
pqos.transport().user_transports.push_back(shm_transport);  // 优先使用 SHM
pqos.transport().user_transports.push_back(udp_transport);  // 跨机使用 UDP
pqqos.transport().use_builtin_transports = false;

// Fast-DDS 会自动选择最优传输:
// - 同机通信: 使用 SHM (延迟最低)
// - 跨机通信: 使用 UDP (网络可达)
```

### 7.5 大型数据传输配置 (LARGE_DATA)

```cpp
// 使用 SHM + TCP 模式传输大消息 (如视频流、点云)
auto shm_transport = std::make_shared<SharedMemTransportDescriptor>();
shm_transport->segment_size(64 * 1024 * 1024);  // 64MB 段大小
shm_transport->max_message_size(16 * 1024 * 1024);  // 支持 16MB 消息

auto tcp_transport = std::make_shared<TCPv4TransportDescriptor>();
tcp_transport->add_listener_port(5100);
tcp_transport->enable_tcp_nodelay = true;
tcp_transport->sendBufferSize = 16 * 1024 * 1024;  // 16MB 发送缓冲
tcp_transport->receiveBufferSize = 16 * 1024 * 1024;  // 16MB 接收缓冲

eprosima::fastdds::dds::DomainParticipantQos pqos;
pqos.transport().user_transports.push_back(shm_transport);
pqos.transport().user_transports.push_back(tcp_transport);
pqos.transport().use_builtin_transports = false;
```

---

## 8. 传输层选择建议

### 8.1 场景对比

| 场景 | 推荐传输 | 原因 |
|------|----------|------|
| 同机通信 | SHM | 零拷贝，最低延迟 |
| 局域网通信 | UDPv4 | 简单高效，支持多播 |
| 跨网段/NAT | TCPv4 | 支持 WAN 地址，NAT 穿透 |
| 互联网传输 | TCPv4 + TLS | 安全可靠，防火墙友好 |
| 大消息传输 | SHM + TCP | 大缓冲区，零拷贝 |
| 高安全要求 | TCP + TLS | 加密传输，证书认证 |

### 8.2 性能对比

```
延迟对比 (同机通信):
SHM      < 1 μs
UDP      ~10-50 μs
TCP      ~50-100 μs

吞吐量对比:
SHM      > 10 GB/s
UDP      ~1-3 GB/s
TCP      ~1-2 GB/s
```

---

## 9. 总结

Fast-DDS 传输层提供了灵活可扩展的架构，支持多种底层传输协议：

1. **TransportInterface** 定义了统一的抽象接口，便于扩展新的传输类型
2. **UDP 传输** 简单高效，适合局域网多播场景
3. **TCP 传输** 可靠稳定，支持大消息和 NAT 穿透
4. **共享内存传输** 提供零拷贝高性能，是同机通信的最佳选择

在实际应用中，可以根据部署环境和性能需求选择合适的传输协议，也可以组合多种传输实现最优的通信效果。
