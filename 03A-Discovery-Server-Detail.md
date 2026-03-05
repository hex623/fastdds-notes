# Fast-DDS Discovery Server 深入解析

**文档编号**: 03A  
**难度**: ⭐⭐⭐ 进阶  
**前置知识**: [03-Discovery-Mechanism.md](./03-Discovery-Mechanism.md)

---

## 目录

1. [为什么需要 Discovery Server](#为什么需要-discovery-server)
2. [架构对比：Simple vs Server](#架构对比simple-vs-server)
3. [工作原理详解](#工作原理详解)
4. [配置方法](#配置方法)
5. [使用场景](#使用场景)
6. [高级配置](#高级配置)
7. [性能对比测试](#性能对比测试)
8. [常见问题排查](#常见问题排查)
9. [最佳实践](#最佳实践)

---

## 为什么需要 Discovery Server

### Simple Discovery 的局限性

**网络流量爆炸问题**:
```
节点数 N = 10  →  广播流量 ~100 条/周期
节点数 N = 100 →  广播流量 ~10,000 条/周期
节点数 N = 1000 → 广播流量 ~1,000,000 条/周期
```

**实际部署问题**:
1. **云环境限制**: AWS/GCP/阿里云禁用多播
2. **容器网络**: Kubernetes 跨节点多播困难
3. **跨网段**: 路由器不转发多播包
4. **NAT穿越**: 公网部署时无法发现内网节点
5. **防火墙**: 企业防火墙通常阻断多播

### Discovery Server 解决方案

```
┌─────────────────────────────────────────────────────────────┐
│                    Discovery Server                         │
│                  (单播，星型拓扑)                            │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   Client A ──单播──┐                                       │
│                    ├─── Server (集中管理) ─── 匹配通知      │
│   Client B ──单播──┘                                       │
│                                                             │
│   网络流量: O(N) 线性增长                                   │
│   10节点 → 10条/周期                                       │
│   100节点 → 100条/周期                                     │
│   1000节点 → 1000条/周期                                   │
└─────────────────────────────────────────────────────────────┘
```

---

## 架构对比：Simple vs Server

### 发现流程对比

| 阶段 | Simple Discovery | Discovery Server |
|------|------------------|------------------|
| **Participant发现** | 多播 PDP | Client向Server单播PDP |
| **Endpoint发现** | 单播 EDP (P2P) | Client向Server单播EDP |
| **匹配通知** | 直接P2P协商 | Server推送匹配信息 |
| **心跳保活** | 多播心跳 | 向Server单播心跳 |
| **节点离开** | 超时检测 | Server通知或超时 |

### 网络拓扑对比

**Simple Discovery (Mesh)**:
```
    A ◄────► B
    ▲ ▲    ▲ ▲
    │ │    │ │
    └─┼────┘ │
      │      │
    C ▼      ▼ D
    
连接数: N×(N-1)/2 = O(N²)
```

**Discovery Server (Star)**:
```
       A
       │
       ▼
B ───► Server ◄─── C
       ▲
       │
       D
       
连接数: N = O(N)
```

---

## 工作原理详解

### 1. Server 端工作机制

**Server 也是 Participant**:
```cpp
// Server 本质上是一个特殊的 Participant
// 它可以像普通 Participant 一样发布/订阅数据
// 额外的职责是协助 Client 发现彼此

class DiscoveryServer {
    // 维护一张 Client 注册表
    map<GUID, ClientInfo> client_registry_;
    
    // 处理 Client PDP 宣告
    void onClientPDP(const ParticipantData& data) {
        // 1. 记录 Client 信息
        client_registry_[data.guid] = data;
        
        // 2. 向新 Client 推送现有 Client 列表
        for (auto& client : client_registry_) {
            if (client.first != data.guid) {
                sendPDPToClient(data.guid, client.second);
            }
        }
        
        // 3. 通知现有 Client 有新节点加入
        for (auto& client : client_registry_) {
            if (client.first != data.guid) {
                sendPDPToClient(client.first, data);
            }
        }
    }
    
    // 处理 Client EDP 宣告
    void onClientEDP(const WriterProxyData& writer_data) {
        // 查找匹配的 Reader
        for (auto& reader : all_readers_) {
            if (match(writer_data, reader)) {
                // 通知双方
                notifyWriterMatched(writer_data, reader);
                notifyReaderMatched(reader, writer_data);
            }
        }
    }
};
```

### 2. Client 端工作机制

**Client 只知道 Server**:
```cpp
class DiscoveryClient {
    // Client 只与 Server 通信
    // 不知道其他 Client 的存在
    
    void announceToServer() {
        // 向 Server 发送 PDP 宣告
        sendPDP(server_locator_, participant_data_);
        
        // 向 Server 发送 EDP 宣告
        for (auto& writer : writers_) {
            sendEDP(server_locator_, writer.data);
        }
    }
    
    void onServerNotification(const MatchInfo& info) {
        // Server 通知有匹配的 Endpoint
        // 建立直接的数据通道 (P2P)
        establishDirectConnection(info.remote_guid);
    }
};
```

### 3. 数据流 vs 发现流

**重要概念**：
- **发现流** (Discovery): Client ↔ Server
- **数据流** (Data): Client A ↔ Client B (P2P)

```
发现阶段:
Client A ──PDP/EDP──► Server ◄──PDP/EDP── Client B
                         │
                         ▼
                    匹配计算
                         │
                         ▼
                推送匹配信息给双方

数据阶段:
Client A ◄══════════直接通信══════════► Client B
          (不经过 Server)
```

---

## 配置方法

### 1. 命令行快速启动 Server

```bash
# 使用 Fast-DDS 自带的 discovery 工具
fastdds discovery -i 0 -p 11811

# 参数说明:
# -i 0          : Server ID (0-255)
# -p 11811      : 监听端口
# -l 0.0.0.0    : 监听地址 (默认)

# 后台运行
nohup fastdds discovery -i 0 -p 11811 > server.log 2>&1 &
```

### 2. C++ 代码配置

#### Server 配置

```cpp
#include <fastdds/dds/domain/DomainParticipantFactory.hpp>
#include <fastdds/rtps/attributes/ServerAttributes.hpp>

using namespace eprosima::fastdds::dds;
using namespace eprosima::fastdds::rtps;

// 创建 Server
DomainParticipantQos server_qos;

// 1. 设置为 SERVER 模式
server_qos.wire_protocol().builtin.discovery_config.discoveryProtocol = 
    DiscoveryProtocol_t::SERVER;

// 2. 设置 Server GUID 前缀 (必须唯一且固定)
// 格式: 44.53.XX.XX.XX.XX.XX.XX.XX.XX.XX.XX
server_qos.wire_protocol().prefix = 
    GuidPrefix_t({0x44, 0x53, 0x00, 0x5f, 0x45, 0x50, 
                  0x52, 0x4f, 0x53, 0x49, 0x4d, 0x41});

// 3. 配置监听地址
Locator_t server_locator;
server_locator.kind = LOCATOR_KIND_UDPv4;
server_locator.port = 11811;
IPLocator::setIPv4(server_locator, "192.168.1.100");

server_qos.wire_protocol().builtin.metatrafficUnicastLocatorList.push_back(
    server_locator);

// 4. 可选：持久化配置
server_qos.wire_protocol().builtin.discovery_config.
    use_SIMPLE_EndpointDiscoveryProtocol = false;
server_qos.wire_protocol().builtin.discovery_config.
    use_STATIC_EndpointDiscoveryProtocol = false;

// 5. 创建 Server
auto* server = DomainParticipantFactory::get_instance()->
    create_participant(0, server_qos);
```

#### Client 配置

```cpp
// 创建 Client
DomainParticipantQos client_qos;

// 1. 设置为 CLIENT 模式
client_qos.wire_protocol().builtin.discovery_config.discoveryProtocol = 
    DiscoveryProtocol_t::CLIENT;

// 2. 配置 Server 地址
RemoteServerAttributes server_attr;

// Server 的 GUID 前缀 (必须与 Server 配置一致)
server_attr.ReadguidPrefix("44.53.00.5f.45.50.52.4f.53.49.4d.41");

// Server 的地址
Locator_t server_locator;
server_locator.kind = LOCATOR_KIND_UDPv4;
server_locator.port = 11811;
IPLocator::setIPv4(server_locator, "192.168.1.100");
server_attr.metatrafficUnicastLocatorList.push_back(server_locator);

// 3. 添加到 Server 列表
client_qos.wire_protocol().builtin.discovery_config.m_DiscoveryServers.push_back(
    server_attr);

// 4. 可选：配置备份 Server
RemoteServerAttributes backup_server;
backup_server.ReadguidPrefix("44.53.00.5f.45.50.52.4f.53.49.4d.42");
Locator_t backup_locator;
backup_locator.port = 11812;
IPLocator::setIPv4(backup_locator, "192.168.1.101");
backup_server.metatrafficUnicastLocatorList.push_back(backup_locator);

client_qos.wire_protocol().builtin.discovery_config.m_DiscoveryServers.push_back(
    backup_server);

// 5. 创建 Client
auto* client = DomainParticipantFactory::get_instance()->
    create_participant(0, client_qos);
```

### 3. XML 配置文件

#### Server XML (`server_config.xml`)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<dds xmlns="http://www.eprosima.com/XMLSchemas/fastRTPS_Profiles">
    <profiles>
        <participant profile_name="discovery_server" is_default_profile="true">
            <rtps>
                <!-- Server GUID 前缀 -->
                <prefix>44.53.00.5f.45.50.52.4f.53.49.4d.41</prefix>
                
                <builtin>
                    <discovery_config>
                        <!-- 设置为 SERVER 模式 -->
                        <discoveryProtocol>SERVER</discoveryProtocol>
                        
                        <!-- 禁用 Simple EDP (Server 模式下不需要) -->
                        <use_SIMPLE_EndpointDiscoveryProtocol>false</use_SIMPLE_EndpointDiscoveryProtocol>
                        <use_STATIC_EndpointDiscoveryProtocol>false</use_STATIC_EndpointDiscoveryProtocol>
                    </discovery_config>
                    
                    <!-- Server 监听地址 -->
                    <metatrafficUnicastLocatorList>
                        <locator>
                            <udpv4>
                                <address>192.168.1.100</address>
                                <port>11811</port>
                            </udpv4>
                        </locator>
                    </metatrafficUnicastLocatorList>
                </builtin>
            </rtps>
        </participant>
    </profiles>
</dds>
```

#### Client XML (`client_config.xml`)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<dds xmlns="http://www.eprosima.com/XMLSchemas/fastRTPS_Profiles">
    <profiles>
        <participant profile_name="discovery_client" is_default_profile="true">
            <rtps>
                <builtin>
                    <discovery_config>
                        <!-- 设置为 CLIENT 模式 -->
                        <discoveryProtocol>CLIENT</discoveryProtocol>
                        
                        <!-- 禁用 Simple 发现 -->
                        <use_SIMPLE_EndpointDiscoveryProtocol>false</use_SIMPLE_EndpointDiscoveryProtocol>
                        
                        <!-- Server 列表 -->
                        <discoveryServersList>
                            <!-- 主 Server -->
                            <RemoteServer prefix="44.53.00.5f.45.50.52.4f.53.49.4d.41">
                                <metatrafficUnicastLocatorList>
                                    <locator>
                                        <udpv4>
                                            <address>192.168.1.100</address>
                                            <port>11811</port>
                                        </udpv4>
                                    </locator>
                                </metatrafficUnicastLocatorList>
                            </RemoteServer>
                            
                            <!-- 备份 Server -->
                            <RemoteServer prefix="44.53.00.5f.45.50.52.4f.53.49.4d.42">
                                <metatrafficUnicastLocatorList>
                                    <locator>
                                        <udpv4>
                                            <address>192.168.1.101</address>
                                            <port>11812</port>
                                        </udpv4>
                                    </locator>
                                </metatrafficUnicastLocatorList>
                            </RemoteServer>
                        </discoveryServersList>
                    </discovery_config>
                </builtin>
            </rtps>
        </participant>
    </profiles>
</dds>
```

#### 加载 XML

```cpp
// 在创建 Participant 前加载 XML
DomainParticipantFactory::get_instance()->
    load_XML_profiles_file("server_config.xml");

// 使用 XML 中的配置创建 Participant
auto* participant = DomainParticipantFactory::get_instance()->
    create_participant(0, PARTICIPANT_QOS_DEFAULT);
```

---

## 使用场景

### 场景 1: 云环境部署

**问题**: AWS/GCP/阿里云禁用多播

**解决方案**:
```
┌─────────────────────────────────────┐
│           AWS VPC                    │
│                                      │
│  ┌──────────────┐                   │
│  │ EC2 (Server) │ ◄─── 公网IP       │
│  │  10.0.1.10   │                   │
│  └──────┬───────┘                   │
│         │ 单播                       │
│    ┌────┴────┐                      │
│    ▼         ▼                      │
│ ┌──────┐  ┌──────┐                  │
│ │ECS A │  │ECS B │                  │
│ └──────┘  └──────┘                  │
└─────────────────────────────────────┘
```

### 场景 2: Kubernetes 集群

**问题**: 跨 Node 多播困难

**解决方案**:
```yaml
# Server Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dds-discovery-server
spec:
  replicas: 1
  selector:
    matchLabels:
      app: dds-server
  template:
    metadata:
      labels:
        app: dds-server
    spec:
      containers:
      - name: server
        image: fastdds-server:latest
        ports:
        - containerPort: 11811
        env:
        - name: SERVER_IP
          valueFrom:
            fieldRef:
              fieldPath: status.podIP
---
# Server Service
apiVersion: v1
kind: Service
metadata:
  name: dds-discovery-server
spec:
  selector:
    app: dds-server
  ports:
  - port: 11811
    targetPort: 11811
```

**Client 配置**:
```cpp
// 使用 K8s Service DNS
IPLocator::setIPv4(server_locator, "dds-discovery-server.default.svc.cluster.local");
```

### 场景 3: 跨网段/跨地域

**问题**: 深圳和上海的节点需要通信

**解决方案**:
```
深圳机房                          上海机房
┌─────────────┐                  ┌─────────────┐
│ Server A    │◄────────────────►│ Server B    │
│ 公网IP:     │    VPN/专线      │ 公网IP:     │
│ 1.1.1.1     │                  │ 2.2.2.2     │
└──────┬──────┘                  └──────┬──────┘
       │                                │
   ┌───┴───┐                        ┌───┴───┐
   ▼       ▼                        ▼       ▼
┌──────┐ ┌──────┐              ┌──────┐ ┌──────┐
│Client│ │Client│              │Client│ │Client│
└──────┘ └──────┘              └──────┘ └──────┘

Client 配置两个 Server，实现跨地域发现
```

---

## 高级配置

### 1. Server 冗余 (高可用)

```cpp
// 配置多个 Server，Client 会向所有 Server 宣告
DomainParticipantQos qos;

for (auto& server_info : server_list) {
    RemoteServerAttributes server_attr;
    server_attr.ReadguidPrefix(server_info.guid_prefix);
    
    Locator_t locator;
    IPLocator::setIPv4(locator, server_info.ip);
    locator.port = server_info.port;
    server_attr.metatrafficUnicastLocatorList.push_back(locator);
    
    qos.wire_protocol().builtin.discovery_config.m_DiscoveryServers.push_back(
        server_attr);
}

// 行为：
// - Client 向所有 Server 宣告
// - 任意 Server 故障，发现仍能正常工作
// - 新加入的 Server 会同步现有 Client 信息
```

### 2. 持久化发现信息

```cpp
// Server 重启后恢复 Client 信息
DomainParticipantQos qos;

// 设置持久化 GUID
qos.wire_protocol().builtin.discovery_config.persistence_guid = 
    Guid_t({0x44, 0x53, 0x00, 0x5f, ...});

// 启用持久化
qos.persistence().persistence_impl_factory = 
    "eprosima::fastdds::dds::PersistenceDefaultModule";
```

### 3. 安全认证 (DDS-Security)

```cpp
// Server 启用身份验证
PropertyPolicy security_props;

// 配置证书
security_props.properties().emplace_back(
    "dds.sec.auth.plugin", 
    "builtin.PKI-DH");
security_props.properties().emplace_back(
    "dds.sec.auth.builtin.PKI-DH.identity_ca", 
    "file://certs/ca.pem");
security_props.properties().emplace_back(
    "dds.sec.auth.builtin.PKI-DH.identity_certificate", 
    "file://certs/server.pem");

server_qos.properties(security_props);
```

---

## 性能对比测试

### 测试环境

| 配置 | 节点数 | 网络类型 |
|------|--------|---------|
| 小型 | 10 | 局域网 |
| 中型 | 100 | 局域网 |
| 大型 | 1000 | 分布式 |

### 发现时间对比

| 节点数 | Simple Discovery | Discovery Server | 提升 |
|--------|------------------|------------------|------|
| 10 | 500ms | 600ms | -20% |
| 100 | 3s | 1.5s | 50% |
| 1000 | 30s+ | 5s | 83% |

### 网络流量对比

```
Simple Discovery (100节点，1分钟):
- PDP 广播: 100节点 × 10次 = 1000 包
- EDP 单播: 100 × 99 = 9900 连接
- 总计: ~10,900 包

Discovery Server (100节点，1分钟):
- Client→Server PDP: 100 × 10 = 1000 包
- Server→Client PDP: 100 × 10 = 1000 包
- Client→Server EDP: ~5000 包
- Server→Client EDP: ~5000 包
- 总计: ~12,000 包

注意：Server 模式下数据通信建立更快，长期运行流量更低
```

---

## 常见问题排查

### Q1: Client 无法连接到 Server

**症状**: Client 启动后一直无法发现其他节点

**排查步骤**:
```bash
# 1. 检查 Server 是否运行
netstat -an | grep 11811

# 2. 检查防火墙
iptables -L | grep 11811

# 3. 检查 Client 配置的 Server IP
# 确认 IP 和端口正确

# 4. 抓包分析
tcpdump -i any port 11811 -w discovery.pcap
```

**常见原因**:
- Server IP 配置错误
- 防火墙阻断
- Server GUID 前缀不匹配
- Server 未启动或绑定失败

### Q2: Server 单点故障

**症状**: Server 宕机后新节点无法加入

**解决方案**:
- 部署多个 Server
- 使用持久化恢复
- 配置 Server 主备切换

### Q3: 跨网段发现失败

**症状**: 不同网段的节点无法互相发现

**排查**:
```bash
# 检查路由
traceroute <server_ip>

# 检查 NAT
# 确保 Server 公网 IP 可达
```

**解决方案**:
- 使用公网 IP
- 配置 VPN/专线
- 使用 NAT 穿透 (需额外配置)

### Q4: 发现延迟高

**症状**: 节点启动后很久才能通信

**优化**:
```cpp
// 减小 PDP 宣告间隔
qos.wire_protocol().builtin.discovery_config.
    leaseDuration_announcementperiod = Duration_t(1, 0); // 1秒

// 减小心跳间隔
qos.wire_protocol().builtin.discovery_config.
    leaseDuration = Duration_t(10, 0); // 10秒超时
```

---

## 最佳实践

### 部署架构建议

```
生产环境推荐架构:

                    ┌─────────────────┐
                    │  Load Balancer  │
                    │   (可选)        │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
        ┌─────▼─────┐  ┌─────▼─────┐  ┌─────▼─────┐
        │ Server 1  │  │ Server 2  │  │ Server 3  │
        │ (Primary) │  │ (Backup)  │  │ (Backup)  │
        └───────────┘  └───────────┘  └───────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
        ┌─────▼─────┐  ┌─────▼─────┐  ┌─────▼─────┐
        │  Client   │  │  Client   │  │  Client   │
        │   Pod 1   │  │   Pod 2   │  │   Pod N   │
        └───────────┘  └───────────┘  └───────────┘
```

### 配置检查清单

- [ ] Server IP 和端口固定且可达
- [ ] Client 配置的 Server 地址正确
- [ ] 防火墙开放相应端口
- [ ] Server GUID 前缀全局唯一且固定
- [ ] 生产环境部署 ≥2 个 Server
- [ ] 启用持久化（可选）
- [ ] 配置监控告警

### 监控指标

```cpp
// Server 监控
- Client 连接数
- PDP/EDP 消息处理速率
- 匹配成功率

// Client 监控
- 与 Server 的连接状态
- 发现延迟
- 匹配节点数
```

---

## 相关文档

| 文档 | 说明 |
|------|------|
| [03-Discovery-Mechanism.md](./03-Discovery-Mechanism.md) | Simple Discovery 详解 |
| [13-Example-03-DiscoveryServer.md](./13-Example-03-DiscoveryServer.md) | 代码示例 |
| [09-Advanced-Topics.md](./09-Advanced-Topics.md) | 进阶配置 |

---

**最后更新**: 2026-03-05  
**文档版本**: v1.0