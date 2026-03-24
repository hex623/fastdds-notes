# 第6周：调试与调优实战 - 日志系统详解

## 学习目标

- 掌握 Fast-DDS 日志系统的配置方法
- 理解 Log 级别和模块过滤机制
- 学会使用日志进行问题排查

---

## 1. Fast-DDS 日志系统架构

### 1.1 日志级别 (Log Level)

Fast-DDS 使用分级日志系统，按严重程度排序：

| 级别 | 枚举值 | 用途 |
|------|--------|------|
| **Error** | `Log::Kind::Error` | 严重错误，可能导致功能失效 |
| **Warning** | `Log::Kind::Warning` | 警告，可能影响性能或行为 |
| **Info** | `Log::Kind::Info` | 一般信息，正常操作记录 |
| **Debug** | `Log::Kind::Debug` | 调试信息，详细执行流程 |

**默认级别**: Warning（只显示 Warning 和 Error）

### 1.2 日志类别 (Category)

Fast-DDS 将日志按功能模块分类：

```cpp
// 主要类别
"FASTDDS"       // 核心 DDS 层
"RTPS"          // RTPS 协议层
"TRANSPORT"     // 传输层
"DISCOVERY"     // 发现机制
"SECURITY"      // 安全模块
"PUBLISHER"     // 发布者相关
"SUBSCRIBER"    // 订阅者相关
"TYPE"          // 类型系统
"QOS"           // QoS 策略
"GENERAL"       // 通用信息
```

---

## 2. 日志配置方法

### 2.1 代码配置方式

#### 设置日志级别

```cpp
#include <fastdds/dds/log/Log.hpp>

using namespace eprosima::fastdds::dds;

// 设置全局日志级别为 Debug
Log::SetVerbosity(Log::Kind::Debug);

// 只显示 Info 及以上级别
Log::SetVerbosity(Log::Kind::Info);
```

#### 按模块过滤

```cpp
// 只显示 RTPS 和 DISCOVERY 模块的日志
Log::SetCategoryFilter(std::regex("(RTPS|DISCOVERY)"));

// 排除特定模块
Log::SetCategoryFilter(std::regex("^(?!.*TRANSPORT).*$"));
```

#### 设置日志输出目标

```cpp
#include <fastdds/dds/log/OStreamConsumer.hpp>
#include <fastdds/dds/log/FileConsumer.hpp>

// 1. 输出到标准输出
std::unique_ptr<OStreamConsumer> console_consumer(
    new OStreamConsumer(std::cout));
Log::RegisterConsumer(std::move(console_consumer));

// 2. 输出到文件
std::unique_ptr<FileConsumer> file_consumer(
    new FileConsumer("fastdds.log"));
Log::RegisterConsumer(std::move(file_consumer));

// 3. 自定义回调
class MyLogConsumer : public LogConsumer {
public:
    void Consume(const Log::Entry& entry) override {
        // 自定义处理逻辑
        std::cout << "[" << entry.context.category << "] "
                  << entry.message << std::endl;
    }
};

Log::RegisterConsumer(std::unique_ptr<MyLogConsumer>(new MyLogConsumer()));
```

### 2.2 XML 配置方式

```xml
<?xml version="1.0" encoding="UTF-8" ?>
<dds xmlns="http://www.eprosima.com/XMLSchemas/fastRTPS_Profiles">
    
    <!-- 日志配置 -->
    <log>
        <!-- 设置全局日志级别 -->
        <verbosity>DEBUG</verbosity>
        
        <!-- 模块过滤 -->
        <category_filter>
            <include>RTPS</include>
            <include>DISCOVERY</include>
            <exclude>TRANSPORT</exclude>
        </category_filter>
        
        <!-- 输出配置 -->
        <consumer>
            <class>StdoutConsumer</class>
        </consumer>
        
        <consumer>
            <class>FileConsumer</class>
            <property>
                <name>filename</name>
                <value>fastdds_debug.log</value>
            </property>
            <property>
                <name>append</name>
                <value>true</value>
            </property>
        </consumer>
    </log>
    
</dds>
```

### 2.3 环境变量配置

```bash
# 设置日志级别
export FASTDDS_DEFAULT_LOG_LEVEL=DEBUG

# 模块过滤（正则表达式）
export FASTDDS_LOG_FILTER="RTPS|DISCOVERY"

# 输出到文件
export FASTDDS_LOG_FILE=/tmp/fastdds.log
```

---

## 3. 日志格式解析

### 3.1 标准日志格式

```
[2024-03-24 10:15:32.123456] [RTPS] DEBUG: 
RTPSParticipantImpl::createWriter() - Created writer with GUID: 
01.0f.da.70.f5.ea.d7.9b.00.00.00.00|0.0.1.4
```

**格式说明**:
```
[时间戳] [类别] 级别: 消息内容
```

### 3.2 常见日志消息解读

#### 启动阶段

```
[INFO] RTPSParticipantImpl: Creating RTPSParticipant
[DEBUG] RTPSParticipantImpl: GUID prefix: 01.0f.da.70.f5.ea.d7.9b.00.00.00.00
[DEBUG] SPDP: Starting Simple Participant Discovery Protocol
[DEBUG] SEDP: Starting Simple Endpoint Discovery Protocol
```

**解读**:
- Participant 创建成功
- GUID 前缀已生成（基于 MAC/时间戳）
- SPDP 和 SEDP 发现协议已启动

#### 发现阶段

```
[DEBUG] SPDP: Received DATA(p) from remote participant: 
01.0f.da.70.a1.b2.c3.d4.00.00.00.00
[INFO] SEDP: New participant discovered: 
guid=01.0f.da.70.a1.b2.c3.d4.00.00.00.00, hostname=ubuntu-server
[DEBUG] SEDP: Matching writer 01.0f.da.70.a1.b2.c3.d4.00.00.00.00|0.0.1.3 
with reader 01.0f.da.70.f5.ea.d7.9b.00.00.00.00|0.0.1.4
[INFO] SEDP: Match found: writer_guid=..., reader_guid=...
```

**解读**:
- 收到远程 Participant 的宣告
- 发现新节点（ubuntu-server）
- Writer 和 Reader 匹配成功

#### 数据传输阶段

```
[DEBUG] RTPSWriter::write(): Writing sample with SN: 1
[DEBUG] StatefulWriter::send_any_unsent_changes(): 
Sending DATA to 1 readers
[DEBUG] RTPSReader::process_data_msg(): Received DATA from writer 
01.0f.da.70.a1.b2.c3.d4.00.00.00.00|0.0.1.3, SN: 1
[DEBUG] StatefulReader::send_acknack(): Sending ACKNACK to writer
```

**解读**:
- Writer 写入序列号 1 的数据
- 发送 DATA 子消息给 Reader
- Reader 收到数据并发送 ACKNACK 确认

#### 心跳和确认

```
[DEBUG] StatefulWriter::send_heartbeat(): Sending HEARTBEAT 
FirstSN: 1, LastSN: 5, Count: 1
[DEBUG] StatefulWriter::process_acknack(): Received ACKNACK 
from reader 01.0f.da.70.a1.b2.c3.d4.00.00.00.00|0.0.1.4
Base: 1, Bitmap: 11111 (all received)
```

**解读**:
- Writer 发送 HEARTBEAT（序列号范围 1-5）
- Reader 发送 ACKNACK，位图显示已全部收到

---

## 4. 实战配置示例

### 4.1 排查发现问题的配置

```cpp
// 只关注发现相关日志
Log::SetVerbosity(Log::Kind::Debug);
Log::SetCategoryFilter(std::regex("(DISCOVERY|SPDP|SEDP)"));

// 输出到文件便于分析
std::unique_ptr<FileConsumer> file_consumer(
    new FileConsumer("discovery_debug.log"));
Log::RegisterConsumer(std::move(file_consumer));
```

### 4.2 性能分析配置

```cpp
// 只记录 Warning 以上级别，避免影响性能
Log::SetVerbosity(Log::Kind::Warning);

// 但开启 TRANSPORT 模块的 Debug 来分析网络
Log::SetCategoryFilter(std::regex("TRANSPORT"));

// 使用自定义 Consumer 记录时间戳
class TimingConsumer : public LogConsumer {
public:
    void Consume(const Log::Entry& entry) override {
        static auto start = std::chrono::high_resolution_clock::now();
        auto now = std::chrono::high_resolution_clock::now();
        auto elapsed = std::chrono::duration_cast<std::chrono::microseconds>(now - start).count();
        
        std::cout << "[" << elapsed << "us] " << entry.message << std::endl;
    }
};
```

### 4.3 生产环境配置

```xml
<log>
    <!-- 生产环境只用 Warning 和 Error -->
    <verbosity>WARNING</verbosity>
    
    <!-- 输出到文件，保留7天 -->
    <consumer>
        <class>FileConsumer</class>
        <property>
            <name>filename</name>
            <value>/var/log/fastdds/app.log</value>
        </property>
        <property>
            <name>max_files</name>
            <value>7</value>
        </property>
    </consumer>
    
    <!-- 错误实时发送到监控系统 -->
    <consumer>
        <class>CustomAlertConsumer</class>
        <property>
            <name>webhook_url</name>
            <value>https://alerts.company.com/fastdds</value>
        </property>
    </consumer>
</log>
```

---

## 5. 常见问题排查

### 5.1 "Participant not discovered"

**查看日志**:
```
[DEBUG] SPDP: Sending DATA(p) to 239.255.0.1:7400
[DEBUG] SPDP: No DATA(p) received for 5 seconds
```

**诊断**:
- 组播是否正常发送？
- 网络是否有防火墙阻止 7400 端口？
- 两个节点是否在同一个 Domain？

### 5.2 "Writer/Reader not matching"

**查看日志**:
```
[INFO] SEDP: Checking compatibility between writer and reader
[WARNING] SEDP: QoS mismatch: Writer.RELIABILITY != Reader.RELIABILITY
[WARNING] SEDP: Match failed for writer=..., reader=...
```

**诊断**:
- QoS 是否兼容？
- Topic 名称和类型是否一致？

### 5.3 "Data loss"

**查看日志**:
```
[DEBUG] StatefulReader: Missing sequence numbers: 3, 4, 7
[DEBUG] StatefulReader: Sending ACKNACK with NACK for SN: 3, 4, 7
[WARNING] StatefulWriter: Max retries reached for SN: 3
```

**诊断**:
- 网络是否丢包？
- History 缓存是否足够大？
- 重试次数是否设置合理？

---

## 6. 学习检查清单

- [ ] 理解 Log 级别的区别和使用场景
- [ ] 掌握代码、XML、环境变量三种配置方式
- [ ] 能够解读常见日志消息
- [ ] 学会按模块过滤日志
- [ ] 能够配置日志进行问题排查

---

## 7. 下一步

完成日志系统学习后，进入 **调试工具** 模块：
- 使用 DDS Spy 监控 Topic 数据
- Wireshark 抓包分析 RTPS 协议
- 使用 DDS_RTPS_PCAP_Analyzer 分析通信

---

*记录时间: 2026-03-24*  
*模块: 第6周 - 日志系统详解*
