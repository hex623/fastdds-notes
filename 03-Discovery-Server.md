# 03 - Discovery Server 详解

**来源**: 2026-03-03 深度讲解, 2026-03-05 笔记补充  
**整理时间**: 2026-03-17  
**字数**: 17,817 字（原文档）

---

## 为什么需要 Discovery Server

### Simple Discovery 的局限性
- **网络流量**: O(N²) 增长，大规模网络拥塞
- **组播依赖**: 部分网络（云/K8s）不支持组播
- **跨网段**: 无法跨子网发现
- **启动时间**: 节点多时发现延迟大

### 流量对比
| 节点数 | Simple 流量 | Server 流量 | 节省 |
|--------|-------------|-------------|------|
| 10 | 90 条 | 20 条 | 78% |
| 100 | 9,900 条 | 200 条 | 98% |
| 1000 | 999,000 条 | 2,000 条 | 99.8% |

---

## 架构对比

### Simple Discovery
```
A ←→ B
↓ ↘ ↓
C ←→ D

全连接组播发现，每对节点直接交换信息
```

### Discovery Server
```
    Server
   /   |   \
  A    B    C   [发现流: Client ↔ Server]
   \   |   /
    ← P2P →     [数据流: Client A ↔ Client B]

发现流量集中到 Server，数据流仍保持 P2P
```

---

## 工作原理

### 数据流 vs 发现流分离

| 流量类型 | 路径 | 是否经过 Server |
|----------|------|-----------------|
| 发现流量 | Client ↔ Server | ✅ 是 |
| 数据流量 | Client A ↔ Client B | ❌ 否 |

### Client → Server 通信
```
Client A (Writer) ──单播──► Server ──┐
                                     ├── 匹配计算
Client B (Reader) ──单播──► Server ──┘
                                     ↓
                              推送匹配结果给双方
```

---

## 配置方法

### 1. 命令行启动 Server
```bash
fast-discovery-server -l 127.0.0.1 -p 11811
```

### 2. C++ 代码配置 Client
```cpp
// Client 端配置
DomainParticipantQos qos;
qos.wire_protocol().builtin.discovery_config.discoveryProtocol = 
    DiscoveryProtocol_t::CLIENT;

// 指定 Server 地址
Locator_t server_locator;
server_locator.kind = LOCATOR_KIND_UDPv4;
server_locator.port = 11811;
IPLocator::setIPv4(server_locator, "127.0.0.1");

qos.wire_protocol().builtin.discovery_config.m_DiscoveryServers.push_back(server_locator);
```

### 3. XML 配置
```xml
<participant profile_name="client_profile">
    <rtps>
        <builtin>
            <discovery_config>
                <discoveryProtocol>CLIENT</discoveryProtocol>
                <discoveryServersList>
                    <RemoteServer prefix="44.53.00.5f.45.50.52.4f.53.49.4d.41">
                        <metatrafficUnicastLocatorList>
                            <locator>
                                <udpv4>
                                    <address>127.0.0.1</address>
                                    <port>11811</port>
                                </udpv4>
                            </locator>
                        </metatrafficUnicastLocatorList>
                    </RemoteServer>
                </discoveryServersList>
            </discovery_config>
        </builtin>
    </rtps>
</participant>
```

---

## 高级配置

### Server 冗余（高可用）
```cpp
// 配置多个 Server
qos.wire_protocol().builtin.discovery_config.m_DiscoveryServers.push_back(server1);
qos.wire_protocol().builtin.discovery_config.m_DiscoveryServers.push_back(server2);
qos.wire_protocol().builtin.discovery_config.m_DiscoveryServers.push_back(server3);
```

**机制**:
- Client 向所有 Server 宣告
- 任意 Server 可推送匹配
- 部分 Server 故障不影响发现

### Server 持久化
- 定期将发现数据库保存到磁盘（JSON）
- 重启后加载持久化数据
- 标记为"待验证"，等待 Client 重新宣告确认
- 清理未重新宣告的条目

### 心跳保活
| 方向 | 周期 | 租约 | 作用 |
|------|------|------|------|
| Client → Server | 3s | 20s | 宣告存在 |
| Server → Client | 响应中 | 10s | 确认 Server 存活 |

---

## 使用场景

| 场景 | 原因 |
|------|------|
| 云环境 | 不支持组播 |
| Kubernetes | 网络隔离，组播受限 |
| 跨网段 | 单播可路由 |
| 大规模系统 | O(N²) → O(N) |
| 安全敏感 | Server 可做认证中心 |

---

## 最佳实践

1. **生产环境** 至少配置 2 个 Server 冗余
2. **Server 位置** 选择网络中心节点
3. **持久化** 开启 Server 持久化实现秒级恢复
4. **监控** 监控 Server 负载和 Client 连接数

---

_整理自 2026-03-05 Discovery Server 深度笔记_
