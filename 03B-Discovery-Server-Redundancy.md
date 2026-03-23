# Fast-DDS Discovery Server 双 Server 冗余架构原理

**文档编号**: 03B  
**难度**: ⭐⭐⭐⭐ 高级  
**前置知识**: [03A-Discovery-Server-Detail.md](./03A-Discovery-Server-Detail.md)

---

## 目录

1. [为什么需要双 Server 冗余](#为什么需要双-server-冗余)
2. [两种冗余架构](#两种冗余架构)
3. [Client 多归属架构详解](#client-多归属架构详解)
4. [原理解析](#原理解析)
5. [配置实现](#配置实现)
6. [故障场景分析](#故障场景分析)
7. [性能与资源分析](#性能与资源分析)

---

## 为什么需要双 Server 冗余

### 单 Server 的风险

```
单 Server 故障场景：
┌─────────────────┐
│     Server      │◄── 宕机/网络中断
│   (单点故障)     │
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌───────┐ ┌───────┐
│ClientA│ │ClientB│ ◄── 无法发现新节点
└───────┘ └───────┘     已有连接可能维持，但新节点加入失败
```

**关键问题**:
1. 新启动的 Client 无法注册
2. 现有 Client 无法发现新 Topic
3. 网络分区后无法恢复
4. Server 维护需要停机

### 双 Server 解决的问题

| 问题 | 单 Server 风险 | 双 Server 解决 |
|------|---------------|---------------|
| **单点故障** | Server 宕机，整个系统无法发现新节点 | 任意一个 Server 可用，系统正常工作 |
| **网络分区** | 部分 Client 与 Server 断开即隔离 | Client 可连接任一 Server |
| **维护窗口** | 升级 Server 需停服 | 可滚动升级，零停机 |

---

## 两种冗余架构

### 架构 A：Client 多归属（Fast-DDS 实现）

```
┌─────────────────────────────────────────────┐
│                                             │
│    ┌─────────┐         ┌─────────┐         │
│    │ Server1 │         │ Server2 │         │
│    │(主)      │         │(备)      │         │
│    │ 独立运行 │         │ 独立运行 │         │
│    └────┬────┘         └────┬────┘         │
│         │                   │               │
│         └─────────┬─────────┘               │
│                   │                         │
│              ┌────┴────┐                    │
│              │ Client  │                    │
│              │         │                    │
│              │ • 维护两个 │                  │
│              │   Server  │                  │
│              │   连接句柄 │                  │
│              │           │                  │
│              │ • 优先连S1 │                  │
│              │ • S1故障   │                  │
│              │   切S2     │                  │
│              │           │                  │
│              │ • 同时向   │                  │
│              │   两者宣告   │                  │
│              │   (可选)     │                  │
│              └─────────┘                    │
│                                             │
│  特点：Server 之间不通信，Client 自己处理冗余   │
│  优势：简单，无 Server 间同步问题              │
│  劣势：Client 逻辑稍复杂                      │
└─────────────────────────────────────────────┘
```

### 架构 B：Server 共享状态（理论模型）

```
┌─────────────────────────────────────────────┐
│                                             │
│    ┌─────────┐◄─────────►┌─────────┐       │
│    │ Server1 │   状态同步  │ Server2 │       │
│    │         │◄─────────►│         │       │
│    │ 共享发现 │            │ 共享发现 │       │
│    │ 数据库   │            │ 数据库   │       │
│    └────┬────┘            └────┬────┘       │
│         │                      │            │
│    ┌────┴────┐            ┌────┴────┐       │
│    │ ClientA │            │ ClientB │       │
│    │ 只连S1   │            │ 只连S2   │       │
│    └─────────┘            └─────────┘       │
│                                             │
│  同步机制：                                  │
│  • 文件共享 (NFS)                           │
│  • 数据库复制                               │
│  • Raft/Paxos 共识                          │
│                                             │
│  Fast-DDS 2.3+ 支持备份文件，但非实时同步     │
└─────────────────────────────────────────────┘
```

---

## Client 多归属架构详解

### 发现数据库结构

```
Server 维护的发现数据库 (Discovery Database)
┌────────────────────────────────────────────────────┐
│                                                    │
│  ┌─────────────────┐  ┌─────────────────┐         │
│  │   Participants  │  │    Topics       │         │
│  │  (参与者列表)    │  │   (主题列表)     │         │
│  │                  │  │                  │         │
│  │  • P1: GUID_01   │  │  • /topic/A      │         │
│  │  • P2: GUID_02   │  │  • /topic/B      │         │
│  │  • P3: GUID_03   │  │                  │         │
│  └─────────────────┘  └─────────────────┘         │
│                                                    │
│  ┌─────────────────┐  ┌─────────────────┐         │
│  │    Writers      │  │    Readers      │         │
│  │   (写入者)       │  │   (读取者)       │         │
│  │                  │  │                  │         │
│  │  • W1: P1/topic/A│  │  • R1: P2/topic/A│         │
│  │  • W2: P3/topic/B│  │  • R2: P3/topic/B│         │
│  │                  │  │                  │         │
│  │  包含: QoS配置   │  │  包含: QoS配置   │         │
│  │      定位器信息  │  │      定位器信息  │         │
│  └─────────────────┘  └─────────────────┘         │
│                                                    │
│  关键：Server 是发现信息的"路由器"                   │
└────────────────────────────────────────────────────┘
```

### Client-Server 通信流程

```
┌─────────┐                              ┌─────────┐
│ Client  │                              │ Server  │
└────┬────┘                              └────┬────┘
     │                                         │
     │  1. PDP 宣告 (Participant Data)         │
     │ ──────► │                               │
     │         │  "我是 Client，GUID=0x1234"    │
     │                                         │
     │         │  2. Server 记录 Client 信息    │
     │         │  添加到 Participants 列表       │
     │                                         │
     │  3. 返回其他 Participant 信息            │
     │ ◄────── │                               │
     │         │  "已知的其他节点：..."         │
     │                                         │
     │  4. SEDP 宣告 (Endpoints Data)          │
     │ ──────► │                               │
     │         │  "我有 Writer: /topic/A"       │
     │                                         │
     │         │  5. Server 匹配 Writer/Reader  │
     │         │  更新 Topics/Writers/Readers   │
     │                                         │
     │  6. 通知匹配的 Reader 端                 │
     │         │────► 转发给相关 Client         │
     │                                         │
     │  7. 周期性保活 (KeepAlive)               │
     │ «══════»                                │
     │    每 5-10 秒一次                        │
     │                                         │
```

---

## 原理解析

### 心跳检测状态机

```
┌────────────────────────────────────────────────┐
│           Client 的心跳检测状态机               │
│                                                │
│     ┌─────────┐                                │
│     │  INIT   │◄────────────────────┐          │
│     │ 初始化  │                      │          │
│     └────┬────┘                      │          │
│          │ 尝试连接 Server1           │          │
│          ▼                          │          │
│     ┌─────────┐    超时/失败          │          │
│     │CONNECTING│──────────────────┐  │          │
│     │   S1    │                   │  │          │
│     └────┬────┘                   │  │          │
│          │ 成功                    │  │          │
│          ▼                        │  │          │
│     ┌─────────┐   心跳超时          │  │          │
│  ┌─►│ CONNECTED│─────────────────┐ │  │          │
│  │  │   S1    │                 │ │  │          │
│  │  └────┬────┘                 │ │  │          │
│  │       │ 定期心跳 (5s间隔)      │ │  │          │
│  │       │ «═══════════════════»│ │  │          │
│  │       │                      │ │  │          │
│  │  收到 │                      │ │  │          │
│  │  响应 │◄─────────────────────┘ │  │          │
│  │       │                        │  │          │
│  └───────┘                        │  │          │
│          │ 连续3次超时             │  │          │
│          ▼                        │  │          │
│     ┌─────────┐                   │  │          │
│     │CONNECTING│──────────────────┘  │          │
│     │   S2    │                      │          │
│     └────┬────┘                      │          │
│          │ 成功                       │          │
│          ▼                           │          │
│     ┌─────────┐   S1 恢复时可切回     │          │
│     │ CONNECTED│─────────────────────┘          │
│     │   S2    │                                │
│     └─────────┘                                │
│                                                │
│  关键参数：                                     │
│  • 心跳间隔：5s (clientAnnouncementPeriod)      │
│  • 超时重试：3次                                │
│  • 保活周期：10s (keepAliveDuration)            │
└────────────────────────────────────────────────┘
```

### GUID Prefix 的作用

```
GUID 结构 (16字节)
┌─────────────────────────────────────────────────────────────┐
│  GUID Prefix (12字节)        │ Entity ID (4字节)            │
│  ┌────────────────────────┐  │  ┌────────────────────────┐   │
│  │ Vendor │   Unique ID   │  │  │ Kind │   Instance     │   │
│  │ 2字节   │    10字节     │  │  │ 1字节 │     3字节      │   │
│  └────────────────────────┘  │  └────────────────────────┘   │
│                              │                               │
│  0x44 0x53 0x01 ... 0x41    │  0x00 0x00 0x01 0xC1          │
│  │   │   │                   │   │   │   │   │              │
│  │   │   └─── Server ID      │   │   └───┴───┴── Participant │
│  │   │       (区分不同Server) │   │                          │
│  │   └────── "DS" = Discovery│   └── 0x01 = 参与者            │
│  │           Server 标识      │       0x02 = Writer           │
│  └────────── 厂商特定         │       0x04 = Reader           │
│                             │       0xC1 = 内置Reader        │
└─────────────────────────────────────────────────────────────┘

Server Prefix 生成规则：
- 固定头部：0x44 0x53 (ASCII 'D''S')
- Server ID：0x01, 0x02, 0x03... (区分不同Server)
- 固定尾部：0x5f 0x45 0x50 0x52 0x4f 0x53 0x49 0x4d 0x41 ("_EPROSIMA")
```

### 数据一致性保证

```
┌─────────────────────────────────────────────────────────────┐
│                 发现数据的一致性策略                          │
│                                                             │
│  问题：Client 从两个 Server 收到不同的发现信息怎么办？         │
│                                                             │
│  解决方案：                                                   │
│                                                             │
│  1. 时间戳机制                                               │
│     • 每条发现数据包含时间戳                                  │
│     • 使用较新的数据覆盖旧数据                                │
│                                                             │
│  2. 租约机制 (Lease Duration)                                │
│     • Participant 有有效期（默认130秒）                       │
│     • 超过租约未刷新 = 认为离线                               │
│                                                             │
│  3. 数据合并策略                                             │
│     ┌────────────────────────────────────────────┐           │
│     │  DiscoveryDatabase::add_or_update()        │           │
│     │                                            │           │
│     │  输入: 新数据 (来自 Server A 或 B)          │           │
│     │                                            │           │
│     │  1. 检查 GUID 是否已存在                    │           │
│     │     - 不存在 → 直接添加                     │           │
│     │     - 存在   → 比较时间戳                   │           │
│     │                                            │           │
│     │  2. 时间戳较新？                           │           │
│     │     - 是 → 更新数据                        │           │
│     │     - 否 → 忽略                            │           │
│     │                                            │           │
│     │  3. 触发匹配逻辑                            │           │
│     │     - 检查是否有匹配的 Writer/Reader        │           │
│     │     - 通知本地 Endpoints                    │           │
│     └────────────────────────────────────────────┘           │
│                                                             │
│  4. 最终一致性                                               │
│     • 允许短暂的不一致                                       │
│     • 通过周期性宣告收敛                                     │
│     • 新节点最终会被所有 Client 发现                         │
└─────────────────────────────────────────────────────────────┘
```

---

## 配置实现

### XML 配置

```xml
<?xml version="1.0" encoding="UTF-8"?>
<dds xmlns="http://www.eprosima.com/XMLSchemas/fastRTPS_Profiles">
    <profiles>
        <!-- Client 配置 -->
        <participant profile_name="client_participant">
            <rtps>
                <builtin>
                    <discovery_config>
                        <discoveryProtocol>CLIENT</discoveryProtocol>
                        
                        <!-- 配置两个 Discovery Server -->
                        <discoveryServersList>
                            <!-- Server 1 -->
                            <RemoteServer prefix="44.53.01.5f.45.50.52.4f.53.49.4d.41">
                                <metatrafficUnicastLocatorList>
                                    <locator>
                                        <udpv4>
                                            <address>192.168.1.100</address>
                                            <port>56542</port>
                                        </udpv4>
                                    </locator>
                                </metatrafficUnicastLocatorList>
                            </RemoteServer>
                            
                            <!-- Server 2 -->
                            <RemoteServer prefix="44.53.02.5f.45.50.52.4f.53.49.4d.41">
                                <metatrafficUnicastLocatorList>
                                    <locator>
                                        <udpv4>
                                            <address>192.168.1.101</address>
                                            <port>56542</port>
                                        </udpv4>
                                    </locator>
                                </metatrafficUnicastLocatorList>
                            </RemoteServer>
                        </discoveryServersList>
                        
                        <!-- 客户端重连配置 -->
                        <clientAnnouncementPeriod>
                            <sec>5</sec>
                        </clientAnnouncementPeriod>
                    </discovery_config>
                </builtin>
            </rtps>
        </participant>
    </profiles>
</dds>
```

### C++ 代码配置

```cpp
#include <fastdds/dds/domain/DomainParticipantFactory.hpp>
#include <fastdds/rtps/attributes/ServerAttributes.hpp>

using namespace eprosima::fastdds::dds;
using namespace eprosima::fastdds::rtps;

DomainParticipantQos client_qos;

// 设置为 CLIENT 模式
client_qos.wire_protocol().builtin.discovery_config.discoveryProtocol = 
    DiscoveryProtocol_t::CLIENT;

// 配置 Server 1
RemoteServerAttributes server1;
server1.guidPrefix = GuidPrefix_t({0x44, 0x53, 0x01, 0x5f, 0x45, 0x50, 
                                   0x52, 0x4f, 0x53, 0x49, 0x4d, 0x41});
Locator_t locator1;
IPLocator::setIPv4(locator1, "192.168.1.100");
locator1.port = 56542;
server1.metatrafficUnicastLocatorList.push_back(locator1);
client_qos.wire_protocol().builtin.discovery_config.m_DiscoveryServers.push_back(server1);

// 配置 Server 2
RemoteServerAttributes server2;
server2.guidPrefix = GuidPrefix_t({0x44, 0x53, 0x02, 0x5f, 0x45, 0x50,
                                   0x52, 0x4f, 0x53, 0x49, 0x4d, 0x41});
Locator_t locator2;
IPLocator::setIPv4(locator2, "192.168.1.101");
locator2.port = 56542;
server2.metatrafficUnicastLocatorList.push_back(locator2);
client_qos.wire_protocol().builtin.discovery_config.m_DiscoveryServers.push_back(server2);

// 创建 Participant
auto participant = DomainParticipantFactory::get_instance()->
    create_participant(0, client_qos);
```

### ROS2 环境变量配置

```bash
# 同时指定两个 Server，用分号分隔
export ROS_DISCOVERY_SERVER="192.168.1.100:56542;192.168.1.101:56542"

# 启动 ROS2 节点
ros2 run demo_nodes_cpp talker
```

---

## 故障场景分析

### Server 故障切换完整流程

```
时间轴 ───────────────────────────────────────────────────────►

T0: 正常运行
┌─────────┐         ┌─────────┐         ┌─────────┐
│ Client  │◄───────►│ Server1 │         │ Server2 │
│         │  主连接  │ (Primary)│         │(Standby)│
└─────────┘         └─────────┘         └─────────┘
      │                    ▲                  │
      │                    │                  │
      │              心跳5s │                  │
      │              超时10s│                  │
      │                    │                  │
      └────────────────────┘                  │
      保活连接                                  │
      (定期发送 DATA(p), HEARTBEAT)            │
                                               │
      (同时向S2发送，但S2是备用状态)            │
      └──────────────────────────────────────►│

T1: Server1 故障 (网络中断/宕机)
┌─────────┐         ┌─────────┐         ┌─────────┐
│ Client  │    ✗    │ Server1 │         │ Server2 │
│         │◄──断开──│(Down)   │         │(Standby)│
└─────────┘         └─────────┘         └─────────┘
      │                                      │
      │     心跳超时检测 (约10-15s)           │
      │◄────────────────────────────────────►│
      │     向S1发送3次心跳无响应             │
      │                                      │
      ▼                                      │
  状态变更: PRIMARY_FAILED                   │
  触发: 切换到 Server2                       │
      │                                      │
      │─────────────────────────────────────►│
      │     将S2提升为 PRIMARY               │
      │     增加向S2的发送频率                │
      │                                      │

T2: 切换到 Server2
┌─────────┐         ┌─────────┐         ┌─────────┐
│ Client  │         │ Server1 │         │ Server2 │
│         │         │(Down)   │◄───────►│(Primary)│
└─────────┘         └─────────┘         └─────────┘
      │◄─────────────────────────────────────│
      │         新的主连接                    │
      │                                      │
      • 继续周期性宣告                        │
      • 发现数据库保持一致（已合并S1和S2数据）  │
      • 新节点通过S2注册，能被Client发现        │

T3: Server1 恢复
┌─────────┐         ┌─────────┐         ┌─────────┐
│ Client  │◄───────►│ Server1 │         │ Server2 │
│         │  可选切回 │(Standby)│         │(Primary)│
│         │         │         │         │         │
│         │◄───────►│         │         │         │
│         │  保持现状 │         │         │         │
└─────────┘         └─────────┘         └─────────┘
      │
      • 可配置是否切回 (通常不频繁切换，避免振荡)
      • Server1 恢复后自动同步发现数据
```

### 网络分区场景

```
场景：Client 与 Server1 网络隔离，但与 Server2 连通

正常时：
    Subnet A              Subnet B
┌───────────────┐      ┌───────────────┐
│  Client       │◄────►│  Server1      │
│               │      │  Server2      │
└───────────────┘      └───────────────┘

分区后：
    Subnet A              Subnet B
┌───────────────┐      ┌───────────────┐
│  Client       │  ✗   │  Server1      │
│  (孤立)        │      │  Server2      │
└───────────────┘      └───────────────┘
       │
       ▼
  检测：无法连接 Server1
       │
       ▼
  尝试：连接 Server2 ✓ (通过其他路由可达)
       │
       ▼
  结果：恢复正常发现功能

关键：只要至少一个 Server 可达，Client 就能正常工作
```

---

## 性能与资源分析

### 网络开销对比

| 指标 | 单 Server | 双 Server |
|------|-----------|-----------|
| **发现流量** | N × 5s 心跳 | N × 5s × 2 (向两个Server发送) |
| **发现延迟** | 1-2 RTT | 1-2 RTT (并行发送) |
| **故障切换时间** | N/A (无冗余) | 10-15s (3次心跳超时) |
| **内存占用** | 1个连接句柄 | 2个连接句柄 |
| **CPU 开销** | 低 | 略高 (维护两个连接) |

### 关键参数调优

```xml
<discovery_config>
    <!-- 客户端重试间隔 -->
    <clientAnnouncementPeriod>
        <sec>5</sec>
        <nanosec>0</nanosec>
    </clientAnnouncementPeriod>
    
    <!-- 心跳保活周期 -->
    <keepAliveDuration>
        <sec>10</sec>
    </keepAliveDuration>
    
    <!-- PDP 宣告周期 -->
    <leaseDuration>
        <sec>130</sec>
    </leaseDuration>
    
    <!-- 是否自动重新加载备份 -->
    <ignoreParticipantFlags>NO_FILTER</ignoreParticipantFlags>
</discovery_config>
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `clientAnnouncementPeriod` | 5s | Client 向 Server 宣告自己的间隔 |
| `keepAliveDuration` | 10s | 检测 Server 是否存活的心跳周期 |
| `leaseDuration` | 130s | Participant 租约有效期，超时则移除 |

### 最佳实践建议

```
1. 心跳间隔调优
   ┌──────────────────────────────────────┐
   │  局域网内: 5s 正常 / 15s 故障检测    │
   │  广域网:   10s 正常 / 30s 故障检测   │
   │  高可用场景: 3s 正常 / 9s 故障检测   │
   └──────────────────────────────────────┘

2. Server 部署位置
   ┌──────────────────────────────────────┐
   │  同一机房: 两个 Server 不同机架      │
   │  跨机房:   每个可用区一个 Server     │
   │  跨地域:   考虑延迟，可能需要更多     │
   └──────────────────────────────────────┘

3. 避免脑裂
   ┌──────────────────────────────────────┐
   │  • 两个 Server 需要能互相通信        │
   │  • 或使用共享存储保持状态一致         │
   │  • Client 优先使用延迟最低的 Server   │
   └──────────────────────────────────────┘
```

---

## 总结

```
┌─────────────────────────────────────────────────────────────┐
│                    双 Server 核心要点                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. 冗余原理                                                 │
│     • Client 同时维护多个 Server 连接                        │
│     • 主 Server 故障时自动切换到备用                         │
│     • 发现数据通过时间戳机制保持一致                          │
│                                                             │
│  2. 故障检测                                                 │
│     • 基于心跳超时 (默认10-15s)                              │
│     • 连续3次无响应判定故障                                  │
│     • 自动重连和状态恢复                                     │
│                                                             │
│  3. 数据一致性                                               │
│     • 最终一致性模型                                         │
│     • 时间戳优先策略                                         │
│     • 租约过期清理                                           │
│                                                             │
│  4. 适用场景                                                 │
│     • 生产环境高可用要求                                     │
│     • 跨网络部署                                             │
│     • 关键任务系统                                           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

**最后更新**: 2026-03-23  
**文档版本**: v1.0
