# Fast-DDS 调试技巧与工具指南

本文档汇总了 Fast-DDS 开发中常用的调试方法、工具和最佳实践，帮助开发者快速定位和解决通信问题。

---

## 1. 日志系统

### 1.1 LogConsumer 配置

Fast-DDS 使用可扩展的日志系统，支持多种 LogConsumer 实现：

```cpp
#include <fastdds/dds/log/Log.hpp>
#include <fastdds/dds/log/StdoutConsumer.hpp>
#include <fastdds/dds/log/FileConsumer.hpp>

// 标准输出消费者
auto stdout_consumer = std::make_unique<eprosima::fastdds::dds::StdoutConsumer>();
stdout_consumer->stderr_threshold(eprosima::fastdds::dds::Log::Kind::Error);
eprosima::fastdds::dds::Log::RegisterConsumer(std::move(stdout_consumer));

// 文件消费者
auto file_consumer = std::make_unique<eprosima::fastdds::dds::FileConsumer>("fastdds.log");
file_consumer->append(true);  // 追加模式
eprosima::fastdds::dds::Log::RegisterConsumer(std::move(file_consumer));
```

### 1.2 Verbosity 级别设置

Fast-DDS 提供四个日志级别，可按模块和类别过滤：

| 级别 | 枚举值 | 用途 |
|------|--------|------|
| Error | 0 | 严重错误，程序可能无法继续运行 |
| Warning | 1 | 警告信息，需要注意但程序可继续 |
| Info | 2 | 一般信息，记录正常操作 |
| Debug | 3 | 调试信息，详细的执行轨迹 |

**代码设置方式：**

```cpp
// 设置全局日志级别
eprosima::fastdds::dds::Log::SetVerbosity(eprosima::fastdds::dds::Log::Kind::Debug);

// 设置特定类别日志级别
eprosima::fastdds::dds::Log::SetCategoryFilter(std::regex("(SECURITY|TRANSPORTS)"));
eprosima::fastdds::dds::Log::SetVerbosity(eprosima::fastdds::dds::Log::Kind::Info);
```

**XML 配置方式：**

```xml
<log>
    <use_default>FALSE</use_default>
    <consumer>
        <class>StdoutConsumer</class>
    </consumer>
    <consumer>
        <class>FileConsumer</class>
        <property>
            <name>filename</name>
            <value>fastdds.log</value>
        </property>
        <property>
            <name>append</name>
            <value>true</value>
        </property>
    </consumer>
</log>
```

**环境变量方式：**

```bash
# 设置日志级别
export FASTDDS_DEFAULT_LOG_LEVEL=Debug

# 设置类别过滤
export FASTDDS_LOG_FILTER="(RTPS|DISCOVERY)"
```

### 1.3 自定义日志宏

```cpp
// 基础日志宏
logError(CATEGORY, "Error message: " << error_code);
logWarning(CATEGORY, "Warning message");
logInfo(CATEGORY, "Info message");

// 条件日志
logDebug(CATEGORY, "Debug value: " << value);

// 常用类别：RTPS, DISCOVERY, TRANSPORTS, SECURITY, PUBLISHER, SUBSCRIBER
```

---

## 2. 调试宏和编译选项

### 2.1 CMake 调试选项

```bash
# Debug 模式编译
cmake -DCMAKE_BUILD_TYPE=Debug ..

# 启用详细输出
cmake -DCMAKE_VERBOSE_MAKEFILE=ON ..

# 启用 RTPS 调试统计
cmake -DTHIRDPARTY_Asio=ON -DTHIRDPARTY_fastcdr=ON ..
```

### 2.2 预处理器宏定义

| 宏定义 | 功能 | 示例 |
|--------|------|------|
| `EPROSIMA_BUILD` | 启用内部调试功能 | `-DEPROSIMA_BUILD=ON` |
| `HAVE_SECURITY` | 启用安全调试日志 | `-DHAVE_SECURITY=ON` |
| `RTPS_LOG_SCORE_INFO` | 记录 RTPS 评分信息 | 内部调试 |
| `FASTDDS_STATISTICS_BACKEND` | 启用统计后端 | 性能分析 |

### 2.3 运行时断言和检查

```cpp
// 启用断言检查
cmake -DCMAKE_BUILD_TYPE=Debug -DCMAKE_CXX_FLAGS="-D_GLIBCXX_DEBUG"

// 地址 sanitizer（检测内存问题）
cmake -DCMAKE_BUILD_TYPE=Debug -DCMAKE_CXX_FLAGS="-fsanitize=address -fno-omit-frame-pointer"

# 运行时启用
export ASAN_OPTIONS=detect_leaks=1
```

### 2.4 数据一致性检查宏

```cpp
// 在代码中添加调试断点
#define DDS_DEBUG_BREAK() do { \
    if (std::getenv("FASTDDS_DEBUG")) { \
        __builtin_trap(); \
    } \
} while(0)

// 序列化调试
#define DDS_DEBUG_SERIALIZATION(writer, data) \
    logInfo(SERIALIZATION, "Writing " << sizeof(data) << " bytes")
```

---

## 3. Wireshark 分析 DDS/RTPS 包

### 3.1 环境准备

```bash
# macOS 安装 Wireshark
brew install --cask wireshark

# Ubuntu 安装
sudo apt-get install wireshark

# 确保有权限捕获数据包
sudo chmod +x /dev/bpf*
```

### 3.2 捕获 DDS/RTPS 流量

```bash
# 查找网络接口
ifconfig

# 捕获 RTPS 流量（默认端口 7400-7410）
sudo tcpdump -i any -w dds_traffic.pcap 'portrange 7400-7500 or udp[8:4]=0x52545053'

# 使用 Wireshark GUI 过滤
# 显示过滤器: rtps || udp.port == 7400
```

### 3.3 Wireshark 显示过滤器

```
# 基础 RTPS 过滤
rtps

# 特定实体过滤
rtps.sm.rd.entityId == 0x000001c1

# 主题名称过滤
rtps.topic_name contains "HelloWorld"

# GUID 过滤
rtps.guidPrefix == 01:0f:2e:51:00:00:01:00

# 数据子消息过滤
rtps.submessageId == 0x15  # DATA 子消息
rtps.submessageId == 0x16  # DATA_FRAG 子消息
```

### 3.4 常见 RTPS 子消息类型

| 子消息 ID | 名称 | 描述 |
|-----------|------|------|
| 0x01 | PAD | 填充子消息 |
| 0x06 | ACKNACK | 确认/否认子消息 |
| 0x07 | HEARTBEAT | 心跳子消息 |
| 0x08 | GAP | 间隙子消息 |
| 0x12 | INFO_TS | 时间戳信息 |
| 0x15 | DATA | 数据子消息 |
| 0x16 | DATA_FRAG | 分片数据 |
| 0x21 | INFO_DST | 目标信息 |

### 3.5 分析技巧

1. **查看发现过程：**
   ```
   rtps.submessageId == 0x0b || rtps.submessageId == 0x0c
   ```

2. **查看 QoS 协商：**
   ```
   rtps.parameterId == 0x58  # PID_PARTITION
   ```

3. **检查心跳和确认：**
   ```
   rtps.submessageId == 0x07 || rtps.submessageId == 0x06
   ```

---

## 4. Fast-DDS Monitor 使用

### 4.1 安装

```bash
# Ubuntu
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/fastdds-archive-keyring.gpg] \
    http://repo.fast-dds.com/ubuntu $(lsb_release -cs) main" | \
    sudo tee /etc/apt/sources.list.d/fastdds.list
sudo apt-get update
sudo apt-get install fastdds-monitor

# macOS（从源码构建）
git clone https://github.com/eProsima/Fast-DDS-monitor.git
cd Fast-DDS-monitor
mkdir build && cd build
cmake ..
make -j$(nproc)
sudo make install
```

### 4.2 启动和配置

```bash
# 启动 Monitor
fastdds_monitor

# 指定统计后端端口
fastdds_monitor --domain 0 --port 11811
```

### 4.3 代码中启用统计

```cpp
#include <fastdds/dds/domain/DomainParticipantFactory.hpp>
#include <fastdds/dds/statistics/IListeners.hpp>

// 启用统计 Topic
DomainParticipantQos pqos;
pqos.properties().properties().emplace_back(
    "fastdds.statistics", "HISTORY_LATENCY_TOPIC;");
pqos.properties().properties().emplace_back(
    "fastdds.statistics", "NETWORK_LATENCY_TOPIC;");
pqos.properties().properties().emplace_back(
    "fastdds.statistics", "PUBLICATION_THROUGHPUT_TOPIC;");
pqos.properties().properties().emplace_back(
    "fastdds.statistics", "SUBSCRIPTION_THROUGHPUT_TOPIC;");
pqos.properties().properties().emplace_back(
    "fastdds.statistics", "RTPS_SENT_TOPIC;");
pqos.properties().properties().emplace_back(
    "fastdds.statistics", "RTPS_LOST_TOPIC;");
pqos.properties().properties().emplace_back(
    "fastdds.statistics", "HEARTBEAT_COUNT_TOPIC;");
pqos.properties().properties().emplace_back(
    "fastdds.statistics", "ACKNACK_COUNT_TOPIC;");
pqos.properties().properties().emplace_back(
    "fastdds.statistics", "NACKFRAG_COUNT_TOPIC;");
pqos.properties().properties().emplace_back(
    "fastdds.statistics", "GAP_COUNT_TOPIC;");
pqos.properties().properties().emplace_back(
    "fastdds.statistics", "DATA_COUNT_TOPIC;");
pqos.properties().properties().emplace_back(
    "fastdds.statistics", "RESENT_DATA_COUNT_TOPIC;");
pqos.properties().properties().emplace_back(
    "fastdds.statistics", "SAMPLE_DATAS_TOPIC;");

auto participant = DomainParticipantFactory::get_instance()->create_participant(0, pqos);
```

### 4.4 XML 配置启用统计

```xml
<participant profile_name="statistics_enabled">
    <rtps>
        <propertiesPolicy>
            <properties>
                <property>
                    <name>fastdds.statistics</name>
                    <value>HISTORY_LATENCY_TOPIC;NETWORK_LATENCY_TOPIC;PUBLICATION_THROUGHPUT_TOPIC</value>
                </property>
            </properties>
        </propertiesPolicy>
    </rtps>
</participant>
```

### 4.5 Monitor 功能面板

| 面板 | 功能描述 |
|------|----------|
| Domain View | 查看 Domain 内的所有实体 |
| Topic Monitor | 实时监控 Topic 数据流 |
| Latency Graph | 显示端到端延迟图表 |
| Throughput Graph | 显示吞吐量图表 |
| Data Flow | 可视化数据流向 |

---

## 5. 常见问题排查

### 5.1 连接失败问题

#### 症状：发现阶段超时，Participant 无法互相发现

**检查清单：**

```bash
# 1. 检查网络连通性
ping <target_ip>
nc -zv <target_ip> 7410  # RTPS 默认端口

# 2. 检查防火墙设置
sudo iptables -L -n | grep 7400
sudo ufw status

# 3. 检查多网卡绑定
# 在 XML 中指定网络接口
```

**XML 配置指定接口：**

```xml
<transport_descriptors>
    <transport_descriptor>
        <transport_id>udp_transport</transport_id>
        <type>UDPv4</type>
        <interfaceWhiteList>
            <address>192.168.1.100</address>
        </interfaceWhiteList>
    </transport_descriptor>
</transport_descriptors>
```

**日志分析：**

```bash
# 启用发现模块详细日志
export FASTDDS_DEFAULT_LOG_LEVEL=Debug
export FASTDDS_LOG_FILTER="(DISCOVERY|RTPS)"

# 查看发现过程
grep -i "participant discovery" fastdds.log
grep -i "endpoint discovery" fastdds.log
```

### 5.2 数据丢失问题

#### 症状：Subscriber 收不到部分数据，或数据乱序

**原因分析和排查：**

1. **History QoS 深度不足：**

```xml
<topic>
    <historyQos>
        <kind>KEEP_LAST</kind>
        <depth>10</depth>  <!-- 增加深度 -->
    </historyQos>
</topic>
```

2. **Reliability 设置不匹配：**

```cpp
// 确保发布者和订阅者都使用可靠模式
DataWriterQos wqos;
wqos.reliability().kind = RELIABLE_RELIABILITY_QOS;

DataReaderQos rqos;
rqos.reliability().kind = RELIABLE_RELIABILITY_QOS;
```

3. **资源限制不足：**

```xml
<resourceLimitsQos>
    <max_samples>100</max_samples>
    <max_instances>10</max_instances>
    <max_samples_per_instance>10</max_samples_per_instance>
</resourceLimitsQos>
```

**使用统计 Topic 监控丢失：**

```cpp
// 监控 RTPS 丢失
pqos.properties().properties().emplace_back(
    "fastdds.statistics", "RTPS_LOST_TOPIC;");
```

### 5.3 性能问题诊断

**诊断脚本示例：**

```bash
#!/bin/bash
# performance_check.sh

echo "=== Fast-DDS 性能诊断 ==="

# 1. 检查 CPU 和内存
echo "CPU 使用率:"
top -l 1 | grep -E "(CPU usage|fastdds)"

echo -e "\n内存使用:"
ps aux | grep fastdds | grep -v grep

# 2. 检查网络丢包
echo -e "\n网络统计:"
netstat -s | grep -i "packet"

# 3. 检查打开的文件描述符
echo -e "\n文件描述符:"
ls -l /proc/$(pgrep -f fastdds)/fd 2>/dev/null | wc -l

# 4. 检查共享内存段
echo -e "\n共享内存:"
ipcs -m | grep $(whoami)
```

---

## 6. 工具推荐：DDS_RTPS_PCAP_Analyzer

### 6.1 安装

```bash
git clone https://github.com/eProsima/dds-rtps-analyzer.git
cd dds-rtps-analyzer
pip install -r requirements.txt
```

### 6.2 基本使用

```bash
# 分析 PCAP 文件
python3 dds_analyzer.py -i capture.pcap

# 生成详细报告
python3 dds_analyzer.py -i capture.pcap --report report.html

# 过滤特定 Topic
python3 dds_analyzer.py -i capture.pcap --topic-filter "HelloWorld"

# 分析特定时间范围
python3 dds_analyzer.py -i capture.pcap --start "2024-01-01 10:00:00" --end "2024-01-01 10:05:00"
```

### 6.3 分析功能

| 选项 | 功能 |
|------|------|
| `--discover` | 分析发现过程 |
| `--qos` | 分析 QoS 协商 |
| `--latency` | 计算端到端延迟 |
| `--throughput` | 统计吞吐量 |
| `--errors` | 查找协议错误 |

### 6.4 输出示例

```bash
$ python3 dds_analyzer.py -i test.pcap --summary

=== DDS/RTPS 分析摘要 ===
捕获文件: test.pcap
捕获时长: 300.5 秒
Participant 数量: 5
Topic 数量: 3
总数据包: 15,234
RTPS 消息: 12,456
发现消息: 1,234
数据消息: 8,765
心跳消息: 2,345
确认消息: 112

潜在问题:
- 检测到 5 个 GAP 消息（可能丢包）
- Participant GUID_01 的心跳间隔异常
```

---

## 7. 调试最佳实践

### 7.1 开发阶段

1. **启用 Debug 日志** - 开发时始终启用详细日志
2. **使用 Monitor** - 可视化监控数据流和性能指标
3. **单元测试** - 为 DDS 实体编写单元测试
4. **隔离测试** - 在隔离环境中复现问题

### 7.2 生产环境

1. **日志轮转** - 配置日志文件大小限制
2. **监控告警** - 设置关键指标阈值
3. **远程诊断** - 保留远程日志收集能力
4. **性能基线** - 建立正常运行的性能基线

### 7.3 问题报告模板

```markdown
## 问题描述
- Fast-DDS 版本:
- 操作系统:
- 网络环境:

## 复现步骤
1.
2.
3.

## 日志输出
```
[粘贴相关日志]
```

## Wireshark 捕获
[如可能，附上网卡捕获文件]

## 配置文件
```xml
[粘贴相关 XML 配置]
```
```

---

## 参考资源

- [Fast-DDS 官方文档](https://fast-dds.docs.eprosima.com/)
- [RTPS 协议规范](https://www.omg.org/spec/DDSI-RTPS/)
- [Wireshark RTPS 解析器文档](https://www.wireshark.org/docs/dfref/r/rtps.html)
- [Fast-DDS GitHub Issues](https://github.com/eProsima/Fast-DDS/issues)

---

*文档版本: 1.0*
*最后更新: 2026-03-02*
