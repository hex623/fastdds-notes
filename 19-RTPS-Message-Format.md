# RTPS 协议消息格式详解

## 目录
1. [RTPS 协议概述](#1-rtps-协议概述)
2. [RTPS Header 结构](#2-rtps-header-结构)
3. [SubMessage 通用结构](#3-submessage-通用结构)
4. [DATA SubMessage](#4-data-submessage)
5. [HEARTBEAT SubMessage](#5-heartbeat-submessage)
6. [ACKNACK SubMessage](#6-acknack-submessage)
7. [GAP SubMessage](#7-gap-submessage)
8. [其他 SubMessage 类型](#8-其他-submessage-类型)
9. [Wireshark 抓包分析](#9-wireshark-抓包分析)
10. [实战：手动解析 RTPS 包](#10-实战手动解析-rtps-包)

---

## 1. RTPS 协议概述

### 1.1 RTPS 在协议栈中的位置

```
┌─────────────────────────────────────────────────────────────────┐
│                      协议栈层次                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  应用层                                                          │
│  ├── DDS API (DataWriter/DataReader)                            │
│  └── 用户业务逻辑                                                │
│                                                                  │
│  RTPS 层  ←── 本文重点                                          │
│  ├── RTPS Header (12 bytes)                                     │
│  ├── SubMessage 1                                               │
│  ├── SubMessage 2                                               │
│  └── ...                                                        │
│                                                                  │
│  传输层                                                          │
│  ├── UDP (默认，端口 7400+)                                     │
│  ├── TCP (可选)                                                 │
│  └── SHM (共享内存)                                              │
│                                                                  │
│  网络层                                                          │
│  └── IP (IPv4/IPv6)                                             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 RTPS 消息基本结构

```
┌─────────────────────────────────────────────────────────────────┐
│                     RTPS Message 结构                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────────┐                    │
│  │         RTPS Header (12 bytes)          │                    │
│  │  ┌─────────┬─────────┬──────────────┐  │                    │
│  │  │ Magic   │Version  │Vendor ID     │  │                    │
│  │  │ (4B)    │ (2B)    │ (2B)         │  │                    │
│  │  ├─────────┴─────────┴──────────────┤  │                    │
│  │  │      GUID Prefix (8 bytes)        │  │                    │
│  │  └───────────────────────────────────┘  │                    │
│  └─────────────────────────────────────────┘                    │
│                              │                                   │
│                              ▼                                   │
│  ┌─────────────────────────────────────────┐                    │
│  │      SubMessage 1 (变长)               │                    │
│  │  ┌─────────┬─────────┬──────────────┐  │                    │
│  │  │Header   │Flags    │Content       │  │                    │
│  │  │(1B)     │(1B)     │(变长)        │  │                    │
│  │  └─────────┴─────────┴──────────────┘  │                    │
│  └─────────────────────────────────────────┘                    │
│                              │                                   │
│                              ▼                                   │
│  ┌─────────────────────────────────────────┐                    │
│  │      SubMessage 2 (变长)               │                    │
│  │         ...                            │                    │
│  └─────────────────────────────────────────┘                    │
│                              │                                   │
│                              ▼                                   │
│  ┌─────────────────────────────────────────┐                    │
│  │      SubMessage N (变长)               │                    │
│  └─────────────────────────────────────────┘                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. RTPS Header 结构

### 2.1 Header 字段详解

```cpp
// RTPS Header - 固定 12 字节

struct RTPSHeader {
    // 偏移 0-3: 协议标识 (Magic Number)
    char magic[4];           // "RTPS" (0x52 0x54 0x50 0x53)

    // 偏移 4-5: 协议版本
    uint8_t major;           // 主版本 (2 for RTPS 2.x)
    uint8_t minor;           // 次版本 (1 for RTPS 2.1)

    // 偏移 6-7: 厂商 ID
    uint8_t vendorId[2];     // eProsima = 0x01 0x5F

    // 偏移 8-15: GUID Prefix (前 8 字节)
    uint8_t guidPrefix[8];   // 参与者 GUID 的前 8 字节
};

// 总大小: 4 + 2 + 2 + 8 = 16? 
// 注意: 实际 RTPS 2.2 后 Header 是 12 字节:
// - magic (4)
// - version (2) 
// - vendor (2)
// - guidPrefix (4) ← 这里只有 4 字节！
```

**Wireshark 显示示例**:
```
Real-Time Publish Subscribe Protocol
    RTPS Header
        Magic: RTPS
        Protocol Version: 2.1
        Vendor ID: eProsima Fast-RTPS (0x015f)
        GUID Prefix: 01.0f.03.00
```

### 2.2 Vendor ID 列表

| Vendor ID | 厂商 | 说明 |
|-----------|------|------|
| 0x0000 | 未指定 | - |
| 0x0101 | RTI | Connext DDS |
| 0x015f | eProsima | Fast-DDS |
| 0x013f | ADLINK | OpenSplice |
| 0x0140 | PrismTech | Vortex DDS |

### 2.3 GUID Prefix

```
GUID (Globally Unique Identifier) = 16 bytes

┌─────────────────────────────────────────────────────────────────┐
│                     GUID 结构 (16 bytes)                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Header.guidPrefix (4 bytes)                                     │
│  ├── 参与者在网络中的唯一标识前缀                                │
│  └── 同一个参与者的所有实体共享相同前缀                          │
│                                                                  │
│  Entity ID (4 bytes)                                             │
│  ├── 实体特定标识 (Writer/Reader)                                │
│  └── 组合后形成完整的 12-byte GUID?                              │
│                                                                  │
│  注意: RTPS 2.x 中实际是:                                        │
│  GUID = guidPrefix (12 bytes) + EntityId (4 bytes) = 16 bytes    │
│  Header 中只有前 4 字节，完整 prefix 在后续获取                   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. SubMessage 通用结构

### 3.1 SubMessage Header

每个 SubMessage 都以 4 字节的 Header 开头：

```cpp
struct SubmessageHeader {
    uint8_t submessageId;     // SubMessage 类型标识
    uint8_t flags;            // 标志位
    uint16_t submessageLength; // 内容长度（不含 header）
};
```

### 3.2 SubMessage ID 列表

| ID (Hex) | 名称 | 说明 |
|----------|------|------|
| 0x00 | PAD | 填充 |
| 0x01 | ACKNACK | 确认/否认 |
| 0x06 | HEARTBEAT | 心跳 |
| 0x07 | GAP | 间隙（表示某些序列号不再发送）|
| 0x12 | ACKNACK_BATCH | 批量确认 |
| 0x15 | DATA | 数据（内嵌序列化数据）|
| 0x16 | DATA_FRAG | 数据分片 |
| 0x1A | HEARTBEAT_BATCH | 批量心跳 |

### 3.3 Flags 字段

```
Flags (1 byte):
┌────┬────┬────┬────┬────┬────┬────┬────┐
│ E  │    │    │    │    │    │    │ F  │
└────┴────┴────┴────┴────┴────┴────┴────┘
  │                                        │
  │                                        └── Final Flag
  │                                           (某些消息表示"最终"状态)
  │
  └── Endianness Flag
      1 = 小端序 (Little Endian)
      0 = 大端序 (Big Endian)

注意: 其他位根据 SubMessage 类型有不同含义
```

---

## 4. DATA SubMessage

### 4.1 DATA SubMessage 结构

```cpp
struct DATA_Submessage {
    // === SubMessage Header (4 bytes) ===
    uint8_t submessageId = 0x15;  // DATA
    uint8_t flags;                 // 标志位
    uint16_t submessageLength;     // 后续内容长度

    // === Extra Flags (2 bytes) ===
    uint16_t extraFlags;
    // 位 0: Data present (inline_qos + data)
    // 位 1: Key present (inline_qos + key hash)
    // 位 2: Status info present

    // === Octets to Inline QoS (2 bytes) ===
    uint16_t octetsToInlineQoS;

    // === Reader ID (4 bytes) ===
    EntityId_t readerId;      // 目标 Reader (0 = 所有 Reader)

    // === Writer ID (4 bytes) ===
    EntityId_t writerId;      // 源 Writer

    // === Writer Sequence Number (8 bytes) ===
    int64_t writerSN;         // 序列号 (高32位 + 低32位)

    // === Inline QoS (变长，可选) ===
    // - PID_STATUS_INFO (实例状态)
    // - PID_KEY_HASH (实例 key)
    // - PID_SENTINEL (结束标记)

    // === Serialized Payload (变长，可选) ===
    uint16_t encapsulationId;  // 0x0000 (CDR BE) 或 0x0001 (CDR LE)
    uint16_t encapsulationOptions;
    uint8_t serializedData[];  // CDR 编码的数据
};
```

### 4.2 DATA SubMessage 图示

```
┌─────────────────────────────────────────────────────────────────┐
│                     DATA SubMessage                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Header (4 bytes)                                                │
│  ┌─────────────────────────────────────────┐                    │
│  │ 0x15 │ Flags │ Length (2 bytes)        │                    │
│  └─────────────────────────────────────────┘                    │
│                                                                  │
│  Extra Flags (2 bytes)                                           │
│  ┌─────────────────────────────────────────┐                    │
│  │ Bits: D K S R R R R R                   │                    │
│  │ D=Data present, K=Key present, S=Status │                    │
│  └─────────────────────────────────────────┘                    │
│                                                                  │
│  Octets to Inline QoS (2 bytes)                                  │
│  ┌─────────────────────────────────────────┐                    │
│  │ 从当前位置到 Inline QoS 的字节偏移      │                    │
│  └─────────────────────────────────────────┘                    │
│                                                                  │
│  Reader Entity ID (4 bytes)                                      │
│  ┌─────────────────────────────────────────┐                    │
│  │ 0x00000000 = 所有 Reader (广播)         │                    │
│  │ 0x00XXYYC7 = 特定 Reader                │                    │
│  └─────────────────────────────────────────┘                    │
│                                                                  │
│  Writer Entity ID (4 bytes)                                      │
│  ┌─────────────────────────────────────────┐                    │
│  │ 0x00XXYYC2 = Writer ID                  │                    │
│  └─────────────────────────────────────────┘                    │
│                                                                  │
│  Sequence Number (8 bytes)                                       │
│  ┌─────────────────────────────────────────┐                    │
│  │ high (4 bytes) │ low (4 bytes)          │                    │
│  │ 通常为 0      │ 序列号值 (1, 2, 3...)    │                    │
│  └─────────────────────────────────────────┘                    │
│                                                                  │
│  Inline QoS (变长，可选)                                         │
│  ┌─────────────────────────────────────────┐                    │
│  │ PID_STATUS_INFO (0x0071): 4 bytes       │                    │
│  │   - 实例状态 (REGISTER/DISPOSE/...)      │                    │
│  │ PID_KEY_HASH (0x0070): 16 bytes         │                    │
│  │   - 实例 key hash                        │                    │
│  │ PID_SENTINEL (0x0001): 0 bytes          │                    │
│  │   - QoS 参数结束标记                     │                    │
│  └─────────────────────────────────────────┘                    │
│                                                                  │
│  Serialized Payload (变长，可选)                                 │
│  ┌─────────────────────────────────────────┐                    │
│  │ Encapsulation ID (2 bytes)              │                    │
│  │   0x0000 = CDR Big Endian               │                    │
│  │   0x0001 = CDR Little Endian            │                    │
│  │ Encapsulation Options (2 bytes)         │                    │
│  │ Serialized Data (CDR 编码)              │                    │
│  └─────────────────────────────────────────┘                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 4.3 DATA 消息示例

```
Wireshark 捕获:

Real-Time Publish Subscribe Protocol
    RTPS Header
        Magic: RTPS
        Protocol Version: 2.1
        Vendor ID: eProsima (0x015f)
    Submessage: DATA
        Submessage ID: 0x15 (DATA)
        Flags: 0x05 (Endian: Little, Data present, Inline QoS)
        Octets to inline QoS: 16
        Reader Entity ID: 0x00000000 (unknown)
        Writer Entity ID: 0x000003c2 (SEDPPubWriter)
        Writer Sequence Number: 4
        Inline QoS:
            PID_STATUS_INFO: DISPOSE
            PID_SENTINEL
        Serialized Data:
            Encapsulation ID: 0x0001 (CDR Little Endian)
            Data (42 bytes): ...
```

---

## 5. HEARTBEAT SubMessage

### 5.1 HEARTBEAT 结构

```cpp
struct HEARTBEAT_Submessage {
    // === SubMessage Header (4 bytes) ===
    uint8_t submessageId = 0x06;  // HEARTBEAT
    uint8_t flags;
    uint16_t submessageLength;

    // === Reader ID (4 bytes) ===
    EntityId_t readerId;

    // === Writer ID (4 bytes) ===
    EntityId_t writerId;

    // === First Available SN (8 bytes) ===
    // "我拥有的第一个序列号"
    int64_t firstSN;

    // === Last Available SN (8 bytes) ===
    // "我拥有的最后一个序列号"
    int64_t lastSN;

    // === Count (4 bytes) ===
    // 心跳计数器，用于去重
    uint32_t count;
};
```

### 5.2 HEARTBEAT 语义

```
Writer 发送 HEARTBEAT(firstSN=1, lastSN=10):

"我已经发送了序列号 1 到 10 的所有数据。
 如果你缺了哪些，请回复 ACKNACK 告诉我。"

Reader 收到后的响应：

场景 A: 全部收到
  ACKNACK(bitmap=0, base=11, final=true)
  "1-10 都收到了，继续发 11 及以后吧"

场景 B: 缺失 Seq#5
  ACKNACK(bitmap=10111110111, base=1, final=false)
  "收到了 1-4, 6-10，缺失 5，请重发"
```

### 5.3 HEARTBEAT Flags

```
Flags 字段:
  Bit 0 (E): Endianness (1 = Little Endian)
  Bit 1 (F): Final Flag
      1 = 不要求回复 ACKNACK（Final=true）
      0 = 要求回复 ACKNACK
  Bit 2 (L): Liveliness Flag
      1 = 维持活跃状态（不关联具体数据）
```

---

## 6. ACKNACK SubMessage

### 6.1 ACKNACK 结构

```cpp
struct ACKNACK_Submessage {
    // === SubMessage Header (4 bytes) ===
    uint8_t submessageId = 0x01;  // ACKNACK
    uint8_t flags;
    uint16_t submessageLength;

    // === Reader ID (4 bytes) ===
    EntityId_t readerId;

    // === Writer ID (4 bytes) ===
    EntityId_t writerId;

    // === Reader SN State (变长) ===
    // 位图表示哪些序列号已收到/缺失
    SequenceNumberSet snState;

    // === Count (4 bytes) ===
    uint32_t count;
};
```

### 6.2 SequenceNumberSet（位图）

```cpp
struct SequenceNumberSet {
    int64_t base;           // 基准序列号
    uint32_t numBits;       // 位图中的位数（最大 256）
    uint8_t bitmap[32];     // 256 位 = 32 字节
};

// 位图语义:
// bit[i] = 1: base + i 已收到 (ACK)
// bit[i] = 0: base + i 缺失 (NACK)
```

### 6.3 位图示例

```
场景: Reader 收到 HEARTBEAT(1-10)
实际状态:
  已收到: 1, 2, 3, 4, 6, 7, 8, 9, 10
  缺失: 5

ACKNACK:
  base = 1
  numBits = 10
  bitmap = [0b11101111, 0b10000000, 0x00, ...]
            ││││││││││
            12345678910
                │
                └── 5 是 0，表示缺失

详细:
  Byte 0: 0b11101111 = 0xEF
          bit0=1 (Seq#1 ✓)
          bit1=1 (Seq#2 ✓)
          bit2=1 (Seq#3 ✓)
          bit3=1 (Seq#4 ✓)
          bit4=0 (Seq#5 ✗)
          bit5=1 (Seq#6 ✓)
          bit6=1 (Seq#7 ✓)
          bit7=1 (Seq#8 ✓)

  Byte 1: 0b10000000 = 0x80
          bit0=1 (Seq#9 ✓)
          bit1=1 (Seq#10 ✓)
          ...
```

---

## 7. GAP SubMessage

### 7.1 GAP 结构

```cpp
struct GAP_Submessage {
    // === SubMessage Header (4 bytes) ===
    uint8_t submessageId = 0x07;  // GAP
    uint8_t flags;
    uint16_t submessageLength;

    // === Reader ID (4 bytes) ===
    EntityId_t readerId;

    // === Writer ID (4 bytes) ===
    EntityId_t writerId;

    // === Gap Start SN (8 bytes) ===
    // 间隙开始的序列号
    int64_t gapStart;

    // === Gap List (变长，可选) ===
    // 如果有特定序列号需要标记为不可用
    SequenceNumberSet gapList;
};
```

### 7.2 GAP 语义

```
Writer 发送 GAP(gapStart=5, gapEnd=5):

"序列号 5 不会再发送了，别等了。
 (可能是数据过期被丢弃了)"

Reader 收到 GAP 后的处理:
1. 将 Seq#5 标记为"永久缺失"
2. 不再请求重传 Seq#5
3. 如果应用层要求严格顺序，可能需要处理"空洞"
```

### 7.3 GAP 使用场景

```
场景 1: History QoS = KEEP_LAST(depth=1)

Writer 发送:
  Seq#1: "温度=25°C"
  Seq#2: "温度=26°C"
  Seq#3: "温度=27°C" ← 只保留最新

如果 Reader 错过了 Seq#2，但 Writer 已经用 Seq#3 覆盖了它:
  Writer 发送 GAP(2, 2):
    "Seq#2 已经没有了，直接看 Seq#3 吧"

场景 2: 数据过期

Writer 发送:
  "心跳包需要及时，过期的就不要了"
  如果 Reader 没有及时确认，旧的心跳会被丢弃
  通过 GAP 告知 Reader 别等了
```

---

## 8. 其他 SubMessage 类型

### 8.1 DATA_FRAG（分片数据）

```cpp
// 用于传输大于 UDP MTU 的数据（> 64KB）

struct DATA_FRAG_Submessage {
    uint8_t submessageId = 0x16;
    uint8_t flags;
    uint16_t submessageLength;

    EntityId_t readerId;
    EntityId_t writerId;
    int64_t writerSN;

    // 分片特定字段
    uint32_t fragmentStartingNum;   // 起始分片号
    uint16_t fragmentsInSubmessage; // 本消息包含的分片数
    uint16_t fragmentSize;          // 每个分片大小
    uint32_t sampleSize;            // 原始数据总大小

    // Inline QoS (可选)
    // Serialized Payload Fragments
};
```

### 8.2 PAD（填充）

```cpp
// 用于对齐，无实际内容
struct PAD_Submessage {
    uint8_t submessageId = 0x00;
    uint8_t flags;
    uint16_t submessageLength;  // 通常为 0
};
```

### 8.3 INFO_TS（时间戳）

```cpp
// 为后续 SubMessage 提供时间戳
struct INFO_TS_Submessage {
    uint8_t submessageId = 0x09;
    uint8_t flags;
    uint16_t submessageLength;

    Time_t timestamp;  // NTP 格式时间戳 (8 bytes)
};

// 用法: INFO_TS + DATA
// "以下数据的源时间戳是 XXX"
```

### 8.4 INFO_DST（目标）

```cpp
// 指定后续 SubMessage 的目标参与者
struct INFO_DST_Submessage {
    uint8_t submessageId = 0x0e;
    uint8_t flags;
    uint16_t submessageLength;

    GuidPrefix_t guidPrefix;  // 8 bytes
};

// 用法: INFO_DST + HEARTBEAT
// "以下心跳是给特定参与者的"
```

---

## 9. Wireshark 抓包分析

### 9.1 配置 Wireshark 解析 RTPS

```
1. 安装 Wireshark (3.0+)
2. 确保启用 RTPS 解析器:
   Edit → Preferences → Protocols → RTPS
   - 启用 "Decode RTPS 2.x"
3. 设置 UDP 端口:
   - 默认: 7400-7410
   - 手动添加: Edit → Preferences → Protocols → RTPS
```

### 9.2 典型通信流程抓包

```
发现阶段 (PDP):
────────────────────────────────────────
  1. Participant A 广播 SPDP (Simple Participant Discovery)
     UDP Src: 192.168.1.10:7410 → Dst: 239.255.0.1:7400
     RTPS: DATA(p) - Participant Data

  2. Participant B 接收后回应 SPDP
     UDP Src: 192.168.1.20:7410 → Dst: 239.255.0.1:7400
     RTPS: DATA(p) - Participant Data

  3. 交换 SEDP (Simple Endpoint Discovery)
     RTPS: DATA(w) - Writer Data
     RTPS: DATA(r) - Reader Data

数据传输阶段:
────────────────────────────────────────
  4. Writer 发送数据
     RTPS: DATA (Seq#1)
     RTPS: DATA (Seq#2)

  5. Writer 发送心跳
     RTPS: HEARTBEAT (1-2)

  6. Reader 确认
     RTPS: ACKNACK (ACK到3)

  7. 丢包重传
     RTPS: ACKNACK (NACK#3)
     RTPS: DATA (Seq#3) [重传]
```

### 9.3 分析示例

```
Frame 100: 142 bytes on wire
Ethernet II
Internet Protocol Version 4
User Datagram Protocol
    Src Port: 7410
    Dst Port: 7410
    Length: 108
Real-Time Publish Subscribe Protocol
    RTPS Header
        Magic: RTPS
        Protocol Version: 2.1
        Vendor ID: eProsima (0x015f)
        GUID Prefix: 01.0f.03.00.00.00.00.00
    Submessage: INFO_TS
        Submessage ID: 0x09 (INFO_TS)
        Flags: 0x01 (Endian: Little)
        Octets to next header: 8
        Timestamp: Mar 11, 2025 15:30:25.123456789
    Submessage: DATA
        Submessage ID: 0x15 (DATA)
        Flags: 0x05 (Endian: Little, Inline QoS, Data)
        Octets to inline QoS: 16
        Reader Entity ID: 0x000004c7 (SubReader)
        Writer Entity ID: 0x000003c2 (PubWriter)
        Writer Sequence Number: 42
        Inline QoS:
            PID_STATUS_INFO: 0x00000001 (Key)
            PID_SENTINEL
        Serialized Data:
            Encapsulation: CDR Little Endian (0x0001)
            Data (28 bytes):
                00 00 00 05 48 65 6c 6c 6f 00 ... ("Hello")
```

---

## 10. 实战：手动解析 RTPS 包

### 10.1 使用 tcpdump 捕获

```bash
# 捕获 RTPS 流量
sudo tcpdump -i any udp portrange 7400-7410 -w rtps.pcap

# 实时显示十六进制
sudo tcpdump -i any udp port 7400 -X
```

### 10.2 Python 解析脚本示例

```python
import struct
from dataclasses import dataclass

@dataclass
class RTPSHeader:
    magic: str
    version: tuple
    vendor_id: int
    guid_prefix: bytes

def parse_rtps_header(data: bytes) -> RTPSHeader:
    """解析 RTPS Header (12 bytes)"""
    magic = data[0:4].decode('ascii')
    major = data[4]
    minor = data[5]
    vendor_id = struct.unpack('>H', data[6:8])[0]
    guid_prefix = data[8:16]

    return RTPSHeader(
        magic=magic,
        version=(major, minor),
        vendor_id=vendor_id,
        guid_prefix=guid_prefix
    )

def parse_submessage_header(data: bytes, offset: int):
    """解析 SubMessage Header (4 bytes)"""
    submessage_id = data[offset]
    flags = data[offset + 1]
    length = struct.unpack('<H', data[offset+2:offset+4])[0]

    submessage_types = {
        0x00: 'PAD',
        0x01: 'ACKNACK',
        0x06: 'HEARTBEAT',
        0x07: 'GAP',
        0x15: 'DATA',
        0x16: 'DATA_FRAG',
    }

    return {
        'id': submessage_id,
        'type': submessage_types.get(submessage_id, 'UNKNOWN'),
        'flags': flags,
        'length': length
    }

def parse_data_submessage(data: bytes, offset: int, length: int):
    """解析 DATA SubMessage"""
    # Skip header (4 bytes)
    pos = offset + 4

    extra_flags = struct.unpack('<H', data[pos:pos+2])[0]
    pos += 2

    octets_to_qos = struct.unpack('<H', data[pos:pos+2])[0]
    pos += 2

    reader_id = data[pos:pos+4].hex()
    pos += 4

    writer_id = data[pos:pos+4].hex()
    pos += 4

    seq_num_high = struct.unpack('<I', data[pos:pos+4])[0]
    seq_num_low = struct.unpack('<I', data[pos+4:pos+8])[0]
    seq_num = (seq_num_high << 32) | seq_num_low
    pos += 8

    return {
        'extra_flags': extra_flags,
        'reader_id': reader_id,
        'writer_id': writer_id,
        'sequence_number': seq_num_low,  # 通常高32位为0
    }

# 使用示例
if __name__ == '__main__':
    # 示例 RTPS 包 (十六进制)
    sample_packet = bytes.fromhex(
        '52545053'      # Magic: "RTPS"
        '0201'          # Version: 2.1
        '015f'          # Vendor: eProsima
        '010f030000000000'  # GUID Prefix
        '15'            # SubMessage ID: DATA
        '05'            # Flags
        '2a00'          # Length: 42
        '0000'          # Extra Flags
        '1000'          # Octets to QoS: 16
        '00000000'      # Reader ID
        '000003c2'      # Writer ID
        '00000000'      # Seq High
        '2a000000'      # Seq Low: 42
    )

    header = parse_rtps_header(sample_packet)
    print(f"RTPS Header: {header}")

    submsg = parse_submessage_header(sample_packet, 16)
    print(f"SubMessage: {submsg}")

    if submsg['type'] == 'DATA':
        data_info = parse_data_submessage(sample_packet, 16, submsg['length'])
        print(f"DATA Info: {data_info}")
```

### 10.3 常用分析命令

```bash
# 统计 RTPS 包数量
tshark -r rtps.pcap -Y "rtps" | wc -l

# 提取所有 HEARTBEAT
tshark -r rtps.pcap -Y "rtps.sm.id == 0x06" -V

# 提取特定 Writer 的数据
tshark -r rtps.pcap -Y "rtps.writerEntityId == 0x000003c2"

# 显示 RTPS 包统计
tshark -r rtps.pcap -q -z io,phs

# 导出 RTPS 数据到 JSON
tshark -r rtps.pcap -T json -Y "rtps" > rtps.json
```

---

## 总结

```
┌─────────────────────────────────────────────────────────────────┐
│                    RTPS 协议消息格式总结                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  RTPS Header (12 bytes)                                         │
│  ├── Magic: "RTPS" (4 bytes)                                    │
│  ├── Version: 2.x (2 bytes)                                     │
│  ├── Vendor ID (2 bytes)                                        │
│  └── GUID Prefix (4 bytes)                                      │
│                                                                  │
│  SubMessage 通用结构 (4 + N bytes)                              │
│  ├── ID: 消息类型 (DATA/HEARTBEAT/ACKNACK/GAP)                  │
│  ├── Flags: 字节序 + 特定标志                                   │
│  └── Length: 内容长度                                           │
│                                                                  │
│  核心 SubMessage                                                 │
│  ├── DATA: 传输实际数据 + Inline QoS                            │
│  ├── HEARTBEAT: 声明可用序列号范围                              │
│  ├── ACKNACK: 位图确认/请求重传                                 │
│  └── GAP: 声明某些序列号不再可用                                │
│                                                                  │
│  调试工具                                                        │
│  ├── Wireshark: 图形化解析                                      │
│  ├── tcpdump: 命令行捕获                                        │
│  └── 自定义脚本: 程序化分析                                     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

*文档版本: 1.0*  
*基于 RTPS 2.2 规范*
