# Wireshark 分析 DDS 报文实战指南

> 📌 **代码来源说明**：本文中的内容基于 Wireshark 官方文档和 Fast-DDS 实际网络抓包分析。

---

## 目录
1. [准备工作](#1-准备工作)
2. [捕获 DDS 流量](#2-捕获-dds-流量)
3. [Wireshark 显示过滤器](#3-wireshark-显示过滤器)
4. [RTPS 报文结构分析](#4-rtps-报文结构分析)
5. [常见报文类型详解](#5-常见报文类型详解)
6. [实战案例分析](#6-实战案例分析)
7. [故障排查技巧](#7-故障排查技巧)
8. [高级技巧](#8-高级技巧)

---

## 1. 准备工作

### 1.1 安装 Wireshark

```bash
# macOS
brew install --cask wireshark

# Ubuntu/Debian
sudo apt-get install wireshark

# Windows
# 下载安装包: https://www.wireshark.org/download.html
```

### 1.2 验证 RTPS 协议支持

Wireshark 内置支持 RTPS 协议（DDS 的底层协议）：

1. 打开 Wireshark
2. 点击 **Help → About Wireshark → Protocols**
3. 搜索 "RTPS"，确认已启用

### 1.3 设置捕获权限

```bash
# macOS/Linux 需要设置权限以捕获网络流量
# 方法1: 使用 sudo
sudo wireshark

# 方法2: 将用户加入 wireshark 组 (Linux)
sudo usermod -a -G wireshark $USER
# 然后重新登录
```

---

## 2. 捕获 DDS 流量

### 2.1 确定 DDS 使用的端口

```
DDS 默认端口计算:
- Domain ID 0: 
  - Discovery: 7400 (用于 SPDP/SEDP 发现)
  - User Data: 7410 (用于实际数据传输)
  - 7411 (备用)

- Domain ID X:
  - Discovery: 7400 + X*2
  - User Data: 7410 + X*10
  - 7411 + X*10

示例:
- Domain 0: 7400, 7410, 7411
- Domain 1: 7402, 7420, 7421
- Domain 5: 7410, 7460, 7461
```

### 2.2 开始捕获

**步骤 1: 选择网络接口**
```
Wireshark 启动界面:
- 如果是本机测试: 选择 "Loopback: lo0" 或 "Loopback"
- 如果是网络通信: 选择对应的网卡 (eth0, en0, etc.)
```

**步骤 2: 设置捕获过滤器**

在捕获前设置过滤器，只捕获 DDS 相关流量：

```
捕获过滤器 (Capture Filter):
udp portrange 7400-7500

或者指定具体端口:
udp port 7400 or udp port 7410 or udp port 7411

如果是特定 Domain ID (例如 Domain 5):
udp port 7410 or udp port 7460 or udp port 7461
```

**步骤 3: 运行 DDS 程序**

```bash
# 启动 DDS 发布者
cd ~/Fast-DDS/build/examples/cpp/dds/HelloWorldExample
cpp/bin/HelloWorldExample publisher

# 在另一个终端启动订阅者
cpp/bin/HelloWorldExample subscriber
```

**步骤 4: 停止捕获**

当收集到足够数据后，点击红色停止按钮。

---

## 3. Wireshark 显示过滤器

捕获完成后，使用显示过滤器分析特定类型的报文：

### 3.1 基础过滤器

```
# 只显示 RTPS 报文
rtps

# 显示特定 Domain 的报文 (Domain 0)
rtps.domain_id == 0

# 显示特定类型的报文
rtps.sm.id == 0x15    # DATA 报文
rtps.sm.id == 0x07    # HEARTBEAT 报文
rtps.sm.id == 0x06    # ACKNACK 报文
rtps.sm.id == 0x08    # GAP 报文
rtps.sm.id == 0x09    # INFO_TS 报文
```

### 3.2 高级过滤器

```
# 显示特定 Participant 的报文
rtps.participant_guid == "0x00010000000000000000000000000001"

# 显示特定 Writer 的报文
rtps.writer_guid == "0x00010000000000000000000000000001.0x000001c2"

# 显示序列号范围
rtps.sequence_number > 10 && rtps.sequence_number < 100

# 显示特定主题的报文
rtps.topic_name contains "HelloWorld"

# 组合条件
rtps && rtps.sm.id == 0x15 && rtps.sequence_number > 5
```

### 3.3 常用过滤器速查表

| 过滤器 | 说明 |
|--------|------|
| `rtps` | 所有 RTPS 报文 |
| `rtps.sm.id == 0x15` | DATA 子消息 |
| `rtps.sm.id == 0x07` | HEARTBEAT 子消息 |
| `rtps.sm.id == 0x06` | ACKNACK 子消息 |
| `rtps.sm.id == 0x08` | GAP 子消息 |
| `rtps.sm.id == 0x01` | INFO_TS (时间戳) |
| `rtps.sm.id == 0x0d` | INFO_DST (目标信息) |
| `rtps.sm.id == 0x0e` | INFO_SRC (源信息) |

---

## 4. RTPS 报文结构分析

### 4.1 RTPS 报文整体结构

```
RTPS Packet (UDP Payload)
├─ RTPS Header (20 bytes)
│  ├─ Magic: "RTPS" (4 bytes)
│  ├─ Protocol Version: 2.2 (2 bytes)
│  ├─ Vendor ID: eProsima (2 bytes)
│  └─ GUID Prefix: Participant GUID (12 bytes)
│
└─ Submessages (可变长度)
   ├─ Submessage 1
   │  ├─ Submessage Header (4 bytes)
   │  │  ├─ Submessage ID (1 byte)
   │  │  ├─ Flags (1 byte)
   │  │  └─ Octets to next header (2 bytes)
   │  └─ Submessage Body (可变)
   ├─ Submessage 2
   └─ ...
```

### 4.2 Wireshark 中的报文解析

在 Wireshark 中点击一个 RTPS 报文，查看 Packet Details：

```
Frame 100: 250 bytes on wire (2000 bits)
├─ Ethernet II
├─ Internet Protocol Version 4
├─ User Datagram Protocol (UDP)
│  ├─ Source Port: 7410
│  └─ Destination Port: 7410
└─ Real-Time Publish Subscribe Protocol (RTPS)
   ├─ Header
   │  ├─ magic: RTPS
   │  ├─ version: 2.2
   │  ├─ vendorId: eProsima (0x010F)
   │  └─ guidPrefix: 00010000.00000000.00000000.00000101
   └─ Submessages
      ├─ INFO_TS (InfoTimestamp)
      ├─ DATA (Data)
      └─ HEARTBEAT (Heartbeat)
```

---

## 5. 常见报文类型详解

### 5.1 DATA 报文 (0x15)

**作用**: 传输实际数据

**Wireshark 显示**:
```
Real-Time Publish Subscribe Protocol
└─ Submessage: DATA (0x15)
   ├─ Flags: 0x05 (InlineQoS, Data)
   ├─ Octets to next header: 100
   ├─ Extra flags: 0x0000
   ├─ Octets to inline QoS: 28
   ├─ Reader ID: 0x00000000 (Unknown)
   ├─ Writer ID: 0x000001c2
   ├─ Writer Seq Number: 5
   ├─ Serialized Data
   │  ├─ encapsulation kind: CDR_LE (0x0001)
   │  └─ data: 48656c6c6f20576f726c64... ("Hello World")
```

**关键字段**:
- **Writer ID**: 标识发送数据的 Writer
- **Writer Seq Number**: 序列号，用于排序和去重
- **Serialized Data**: 序列化后的数据负载

### 5.2 HEARTBEAT 报文 (0x07)

**作用**: Writer 告知 Reader 当前可用的序列号范围

**Wireshark 显示**:
```
Real-Time Publish Subscribe Protocol
└─ Submessage: HEARTBEAT (0x07)
   ├─ Flags: 0x03 (Final, Liveliness)
   ├─ Reader ID: 0x00000000 (Unknown)
   ├─ Writer ID: 0x000001c2
   ├─ First Seq Number: 1
   ├─ Last Seq Number: 10
   └─ Count: 5
```

**关键字段**:
- **First Seq Number**: 最早可用的序列号
- **Last Seq Number**: 最新可用的序列号
- **Count**: HEARTBEAT 计数器，单调递增

**含义**: "我有序列号 1 到 10 的数据，请确认收到了哪些"

### 5.3 ACKNACK 报文 (0x06)

**作用**: Reader 确认收到数据或请求重传

**Wireshark 显示**:
```
Real-Time Publish Subscribe Protocol
└─ Submessage: ACKNACK (0x06)
   ├─ Flags: 0x03 (Final, Liveliness)
   ├─ Reader ID: 0x000001c3
   ├─ Writer ID: 0x000001c2
   ├─ Reader SN State
   │  ├─ bitmapBase: 11
   │  ├─ numBits: 32
   │  └─ bitmap: 0x00000000 (bits: 000...)
   └─ Count: 3
```

**关键字段**:
- **bitmapBase**: 位图基准序列号
- **bitmap**: 位图表示哪些序列号已收到/缺失

**位图解读**:
```
bitmapBase = 11
bitmap = 0x00000007 (二进制: 000...0111)

表示:
- 序列号 11: bit 0 = 1 → 已收到
- 序列号 12: bit 1 = 1 → 已收到
- 序列号 13: bit 2 = 1 → 已收到
- 序列号 14+: bit 3+ = 0 → 未收到/未知
```

### 5.4 GAP 报文 (0x08)

**作用**: 通知 Reader 某些序列号的数据不可用（已丢弃）

**Wireshark 显示**:
```
Real-Time Publish Subscribe Protocol
└─ Submessage: GAP (0x08)
   ├─ Reader ID: 0x000001c3
   ├─ Writer ID: 0x000001c2
   ├─ Gap Start: 15
   └─ Gap End: 20
```

**含义**: "序列号 15-20 的数据已被我丢弃，不用再请求了"

### 5.5 INFO_TS 报文 (0x09)

**作用**: 提供时间戳信息

**Wireshark 显示**:
```
Real-Time Publish Subscribe Protocol
└─ Submessage: INFO_TS (0x09)
   ├─ Flags: 0x01 (Timestamp)
   └─ Timestamp: Mar 12, 2025 10:30:15.123456789 CST
```

---

## 6. 实战案例分析

### 6.1 案例 1: 正常数据传输

**场景**: Publisher 发送 5 条消息

**Wireshark 捕获**:
```
Frame 100: DATA #1, Seq=1
Frame 101: HEARTBEAT (First=1, Last=1)
Frame 102: ACKNACK (bitmapBase=2, bitmap=0)

Frame 103: DATA #2, Seq=2
Frame 104: HEARTBEAT (First=1, Last=2)
Frame 105: ACKNACK (bitmapBase=3, bitmap=0)

...直到 Seq=5
```

**分析**:
- 每次发送 DATA 后，Writer 发送 HEARTBEAT
- Reader 回复 ACKNACK 确认已收到所有数据
- bitmapBase=3 表示 Reader 期待序列号 3

### 6.2 案例 2: 丢包与重传

**场景**: 网络丢包，Reader 未收到 Seq=3

**Wireshark 捕获**:
```
Frame 200: DATA #1, Seq=1
Frame 201: DATA #2, Seq=2
Frame 202: DATA #4, Seq=4  (Seq=3 丢失!)
Frame 203: HEARTBEAT (First=1, Last=4)
Frame 204: ACKNACK (bitmapBase=1, bitmap=0x00000005)
```

**位图分析**:
```
bitmapBase=1
bitmap=0x00000005 (二进制: ...0101)

bit 0 (Seq=1): 1 → 已收到
bit 1 (Seq=2): 0 → 未收到 (错误! 应该是1)
bit 2 (Seq=3): 1 → 未收到
bit 3 (Seq=4): 0 → 已收到

实际上:
bitmap=0x05 = 000...0101
bit0=1: Seq=1 收到
bit1=0: Seq=2 缺失
bit2=1: Seq=3 收到 (?? 可能是之前收到的)

等等，让我重新分析:
如果 Seq=3 丢失，Reader 只收到了 1,2,4
ACKNACK 应该是:
bitmapBase=1
bitmap=0x0D (1101):
bit0=1: Seq=1 收到
bit1=0: Seq=2 收到
bit2=1: Seq=3 缺失
bit3=1: Seq=4 收到
```

**重传过程**:
```
Frame 205: DATA #3, Seq=3 (重传)
Frame 206: HEARTBEAT (First=1, Last=4)
Frame 207: ACKNACK (bitmapBase=5, bitmap=0)
```

### 6.3 案例 3: 发现过程 (SPDP/SEDP)

**场景**: 新节点加入网络

**Wireshark 过滤器**:
```
rtps && udp.port == 7400
```

**捕获内容**:
```
Frame 300: SPDP 宣告 (DATA(p))
- Writer GUID: 0x000100... (内置 SPDP Writer)
- Data: Participant 信息

Frame 301: SEDP 宣告 (DATA(w))
- Writer GUID: 0x000100... (内置 SEDP Writer)
- Data: WriterProxyData

Frame 302: SEDP 宣告 (DATA(r))
- Reader GUID: 0x000100... (内置 SEDP Reader)
- Data: ReaderProxyData

Frame 303: 匹配完成，开始传输用户数据
```

---

## 7. 故障排查技巧

### 7.1 问题: 无法发现其他节点

**排查步骤**:
1. 检查捕获过滤器是否包含 7400 端口
   ```
   udp port 7400
   ```
2. 检查是否有 SPDP 报文 (DATA 子消息，Writer ID 为内置值)
3. 检查 Domain ID 是否一致
4. 检查防火墙是否阻止了 7400 端口

### 7.2 问题: 数据发送但接收不到

**排查步骤**:
1. 过滤 DATA 报文
   ```
   rtps.sm.id == 0x15
   ```
2. 检查 Writer 和 Reader 的 Topic 名称是否一致
3. 检查 QoS 兼容性
4. 查看 ACKNACK 报文，确认 Reader 是否收到

### 7.3 问题: 高延迟

**排查步骤**:
1. 查看 INFO_TS 报文中的时间戳
2. 计算发送和接收的时间差
3. 检查是否有大量重传
   ```
   rtps.sm.id == 0x15 && rtps.sequence_number < 10
   # 如果 Seq=5 出现在 Seq=3 之前，可能是乱序
   ```

### 7.4 问题: 内存溢出

**排查步骤**:
1. 查看 HEARTBEAT 中的 Last Seq Number
2. 如果持续增加但 ACKNACK 没有确认，可能是 Reader 处理不过来
3. 检查是否有 GAP 报文 (Writer 丢弃数据)

---

## 8. 高级技巧

### 8.1 导出特定报文

```
File → Export Specified Packets
- 选择 "Selected packets only"
- 选择 "Displayed packets only" (应用过滤器后)
```

### 8.2 分析吞吐量

```
Statistics → IO Graph
- 添加过滤器: rtps.sm.id == 0x15 (仅 DATA 报文)
- Y Axis: Packets/s 或 Bytes/s
```

### 8.3 统计报文类型

```
Statistics → Protocol Hierarchy
- 查看 RTPS 子协议的分布
```

### 8.4 命令行抓包 (tcpdump)

```bash
# 抓包并保存
sudo tcpdump -i any -w dds_capture.pcap 'udp portrange 7400-7500'

# 抓包同时显示简要信息
sudo tcpdump -i any -n 'udp port 7400' -v

# 只抓 1000 个包
sudo tcpdump -i any -c 1000 -w dds_capture.pcap 'udp port 7400'
```

### 8.5 读取 pcap 文件分析

```bash
# 使用 tshark (Wireshark 命令行版)
tshark -r dds_capture.pcap -Y "rtps.sm.id == 0x15" -T fields \
  -e frame.number -e rtps.sequence_number -e rtps.writer_guid

# 统计各类报文数量
tshark -r dds_capture.pcap -Y rtps -T fields -e rtps.sm.id | sort | uniq -c
```

---

## 9. 快速参考卡片

### 常用过滤器速查

```
# 基础
rtps                                    # 所有 RTPS
rtps.domain_id == 0                     # Domain 0
rtps.sm.id == 0x15                      # DATA
rtps.sm.id == 0x07                      # HEARTBEAT
rtps.sm.id == 0x06                      # ACKNACK

# 进阶
rtps.writer_guid == "..."               # 特定 Writer
rtps.sequence_number > 10               # 序列号范围
rtps.topic_name contains "Hello"        # 主题名称
```

### 端口速查

| Domain ID | Discovery | User Data | User Data 2 |
|-----------|-----------|-----------|-------------|
| 0         | 7400      | 7410      | 7411        |
| 1         | 7402      | 7420      | 7421        |
| 5         | 7410      | 7460      | 7461        |

---

**文章编写时间**: 2026-03-12  
**基于**: Wireshark 4.x + Fast-DDS v2.14.x  
**作者**: 旭旭助手 🐾
