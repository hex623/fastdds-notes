# Example 03: Discovery Server - 集中式发现

**示例路径**: `Fast-DDS/examples/cpp/discovery_server/`  
**学习目标**: 掌握 Discovery Server 模式，理解 Client/Server 架构  
**难度**: ⭐⭐ 进阶  
**预计时长**: 45分钟

---

## 🎯 学习目标

1. 理解 Discovery Server 的工作原理
2. 掌握 Server、Client 角色的配置
3. 理解 PDP、EDP 在 Server 模式下的变化
4. 学习多 Server 冗余配置

---

## 📚 Discovery Server 回顾

### 为什么需要 Discovery Server？

**Simple Discovery（去中心化）的问题**:
- 每个 Participant 发送多播宣告
- 网络流量 O(N²)，随节点数平方增长
- 跨网段、NAT 困难

**Discovery Server（集中式）的优势**:
- Client 向 Server 单播宣告
- 网络流量 O(N)，线性增长
- 支持跨网段、NAT、防火墙

---

## 📁 源码结构

```
discovery_server/
├── CMakeLists.txt
├── README.md
├── Application.hpp             # 应用基类
├── ServerApp.hpp/cpp           # Discovery Server 实现
├── ClientPublisherApp.hpp/cpp  # Client Publisher
├── ClientSubscriberApp.hpp     # Client Subscriber
├── Helpers.hpp                 # 辅助函数
└── HelloWorld.*                # 数据类型
```

---

## 🔍 核心源码分析

### 1. Server 端实现

```cpp
bool ServerApp::init()
{
    // Step 1: 配置为 SERVER 模式
    DomainParticipantQos participant_qos;
    
    // 🔴 关键：设置为 SERVER 角色
    participant_qos.wire_protocol().builtin.discovery_config.discoveryProtocol =
        DiscoveryProtocol::SERVER;
    
    // Step 2: 配置监听端口
    // Server 监听端口，Client 连接到这个端口
    participant_qos.wire_protocol().port.portBase = 56540;
    
    // 或者显式配置 Locator
    Locator_t server_locator;
    server_locator.kind = LOCATOR_KIND_UDPv4;
    server_locator.port = 56542;
    IPLocator::setIPv4(server_locator, "192.168.1.100");
    
    participant_qos.wire_protocol().builtin.metatrafficUnicastLocatorList.push_back(
        server_locator);
    
    // Step 3: 创建 Server Participant
    participant_ = DomainParticipantFactory::get_instance()->create_participant(
        0, participant_qos);
    
    // 创建 Publisher 和 DataWriter（同普通示例）
    // ...
    
    return true;
}
```

**学习要点**:
- Server 也是一个普通的 Participant，但角色是 SERVER
- Server 监听特定端口，等待 Client 连接
- Server 可以有 Publisher/Subscriber，参与数据通信

---

### 2. Client 端实现

```cpp
bool ClientPublisherApp::init()
{
    // Step 1: 配置为 CLIENT 模式
    DomainParticipantQos participant_qos;
    
    // 🔴 关键：设置为 CLIENT 角色
    participant_qos.wire_protocol().builtin.discovery_config.discoveryProtocol =
        DiscoveryProtocol::CLIENT;
    
    // Step 2: 配置 Server 地址列表
    // Client 需要知道所有 Server 的地址
    RemoteServerAttributes server_attr;
    server_attr.ReadguidPrefix("44.53.00.5f.45.50.52.4f.53.49.4d.41");
    
    // 配置 Server 的 Locator
    Locator_t server_locator;
    server_locator.kind = LOCATOR_KIND_UDPv4;
    server_locator.port = 56542;
    IPLocator::setIPv4(server_locator, "192.168.1.100");
    server_attr.metatrafficUnicastLocatorList.push_back(server_locator);
    
    participant_qos.wire_protocol().builtin.discovery_config.m_DiscoveryServers.push_back(
        server_attr);
    
    // 可以配置多个 Server 实现冗余
    RemoteServerAttributes server2_attr;
    // ... 配置第二个 Server
    participant_qos.wire_protocol().builtin.discovery_config.m_DiscoveryServers.push_back(
        server2_attr);
    
    // Step 3: 创建 Client Participant
    participant_ = DomainParticipantFactory::get_instance()->create_participant(
        0, participant_qos);
    
    // 创建 Publisher 和 DataWriter（同普通示例）
    // ...
    
    return true;
}
```

**学习要点**:
- Client 不知道其他 Client 的存在，只与 Server 通信
- 可以配置多个 Server，Client 会向所有 Server 宣告
- Server 的 GUID Prefix 需要预先知道（从日志或配置获取）

---

### 3. 发现流程对比

**Simple Discovery**:
```
Publisher --多播宣告--> 所有 Participant
                    --多播宣告--> Subscriber
                    <--匹配成功--
Publisher <--------直接通信--------> Subscriber
```

**Discovery Server**:
```
Publisher (Client) ----单播宣告---> Server
                                   Server --推送匹配信息--> Subscriber (Client)
                                   Server <--宣告-- Subscriber (Client)
                                   Server --推送匹配信息--> Publisher (Client)
Publisher (Client) <--------------直接通信--------------> Subscriber (Client)

注意：数据通信仍然是 P2P，只有发现经过 Server
```

---

## 🚀 运行示例

### 编译

```bash
cd ~/Documents/GitHub/Fast-DDS/examples/cpp/discovery_server
mkdir build && cd build
cmake ..
make -j$(nproc)
```

### 运行

需要 3 个终端：

```bash
# 终端 1：启动 Server
./discovery_server server

# 终端 2：启动 Subscriber Client
./discovery_server subscriber

# 终端 3：启动 Publisher Client
./discovery_server publisher
```

### 预期输出

**Server**:
```
Server running. Please press Ctrl+C to stop the Server at any time.
Server matched with Publisher.
Server matched with Subscriber.
```

**Subscriber**:
```
Subscriber running. Please press Ctrl+C to stop the Subscriber at any time.
Subscriber matched.
Message: 'Hello world' with index: '1' RECEIVED
...
```

**注意**: 如果先启动 Client，再启动 Server，Client 会在 Server 启动后自动连接

---

## 🧪 实验任务

### 实验 1：多 Server 冗余

启动两个 Server，配置 Client 连接两个 Server：

```cpp
// 配置两个 Server
RemoteServerAttributes server1, server2;
// ... 配置 server1 端口 56542
// ... 配置 server2 端口 56543

participant_qos.wire_protocol().builtin.discovery_config.m_DiscoveryServers.push_back(server1);
participant_qos.wire_protocol().builtin.discovery_config.m_DiscoveryServers.push_back(server2);
```

**测试**: 
1. 启动 Server1、Server2
2. 启动 Client
3. 停止 Server1，观察 Client 是否仍能发现其他节点

**结论**: Client 可以从任意一个 Server 获取匹配信息

### 实验 2：跨网段通信

配置 Server 和 Client 在不同网段，通过路由器转发：

```cpp
// Server 配置公网 IP
Locator_t server_locator;
IPLocator::setIPv4(server_locator, "公网IP");

// Client 配置 Server 的公网 IP
RemoteServerAttributes server_attr;
// ... 使用公网IP
```

**观察**: 即使 Client 和 Server 在不同网段，发现仍能正常工作

---

## 📚 与笔记关联

| 本示例概念 | 对应笔记 |
|-----------|---------|
| Discovery Protocol | [03 发现机制](./03-Discovery-Mechanism.md#discovery-server模式) |
| PDP/EDP | [03 发现机制](./03-Discovery-Mechanism.md#pdp-client实现) |
| Server 冗余 | [09 进阶主题](./09-Advanced-Topics.md#server-冗余配置) |
| 心跳保活 | [09 进阶主题](./09-Advanced-Topics.md#server-与-client-的心跳保活机制) |

---

## ✅ 学习检查清单

- [ ] 理解 Discovery Server 与 Simple Discovery 的区别
- [ ] 掌握 Server 端配置方法
- [ ] 掌握 Client 端配置方法
- [ ] 理解数据通信仍然是 P2P
- [ ] 成功运行 3 个节点的示例
- [ ] 完成多 Server 冗余实验

---

_下一个示例：[Static EDP Discovery](./13-Example-04-StaticEDP.md)_
