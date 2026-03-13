# DDS 与 ROS2 集成实战指南

**创建时间**: 2026-03-13  
**ROS2 版本**: Jazzy Jalisco (LTS)  
**DDS 实现**: Fast-DDS 3.x / CycloneDDS  
**作者**: 旭旭助手

---

## 目录

1. [ROS2 架构概述](#一ros2-架构概述)
2. [RMW 中间件抽象层](#二rmw-中间件抽象层)
3. [DDS 实现对比与选择](#三dds-实现对比与选择)
4. [Fast-DDS 与 ROS2 集成](#四fast-dds-与-ros2-集成)
5. [配置与调优](#五配置与调优)
6. [调试与监控](#六调试与监控)
7. [常见问题与解决方案](#七常见问题与解决方案)
8. [从 ROS1 迁移](#八从-ros1-迁移)

---

## 一、ROS2 架构概述

### 1.1 ROS2 为什么选择 DDS？

| 特性 | ROS1 (TCPROS) | ROS2 (DDS) |
|------|--------------|-----------|
| **发现机制** | 中央 Master | 分布式自动发现 |
| **QoS** | 无 | 丰富 (可靠/尽力/截止期限等) |
| **实时性** | 差 | 支持硬实时 |
| **安全性** | 无 | DDS-Security |
| **跨平台** | Linux 为主 | Linux/Windows/macOS/嵌入式 |
| **多机器人** | 复杂 | 原生支持 (Domain ID) |

### 1.2 ROS2 架构层次

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Application Layer                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  │
│  │   ROS2 Node  │  │   ROS2 Node  │  │   ROS2 Node  │                  │
│  │  (Publisher) │  │  (Subscriber)│  │   (Service)  │                  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘                  │
└─────────┼─────────────────┼─────────────────┼──────────────────────────┘
          │                 │                 │
          └─────────────────┼─────────────────┘
                            │
┌───────────────────────────┼─────────────────────────────────────────────┐
│                      ROS2 Client Library (rclcpp/rclpy)                 │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  rclcpp::Publisher  rclcpp::Subscription  rclcpp::Service       │   │
│  │       ↓                    ↓                    ↓                │   │
│  │  ┌───────────────────────────────────────────────────────────┐  │   │
│  │  │              ROS Client Library (rcl)                      │  │   │
│  │  │     (生命周期管理、图接口、参数服务、时钟接口)               │  │   │
│  │  └───────────────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└───────────────────────────┬─────────────────────────────────────────────┘
                            │
┌───────────────────────────┼─────────────────────────────────────────────┐
│                    RMW (ROS Middleware Interface)                       │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │              rmw_implementation (运行时选择)                      │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │   │
│  │  │ rmw_fastrtps │  │rmw_cyclonedds│  │ rmw_connext  │          │   │
│  │  │  (Fast-DDS)  │  │ (CycloneDDS) │  │  (RTI)       │          │   │
│  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │   │
│  └─────────┼─────────────────┼─────────────────┼──────────────────┘   │
└────────────┼─────────────────┼─────────────────┼────────────────────────┘
             │                 │                 │
┌────────────┼─────────────────┼─────────────────┼────────────────────────┐
│       DDS Layer (Data Distribution Service)                             │
│  ┌─────────┴─────────────────┴─────────────────┴────────────────────┐   │
│  │                    DDS Implementation                              │   │
│  │  ┌───────────────────────────────────────────────────────────┐  │   │
│  │  │  Fast-DDS / CycloneDDS / RTI Connext / GurumDDS          │  │   │
│  │  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐    │  │   │
│  │  │  │Participant│ │Publisher │ │Subscriber│ │   Topic  │    │  │   │
│  │  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘    │  │   │
│  │  └───────────────────────────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.3 ROS2 vs DDS 概念映射

| ROS2 概念 | DDS 概念 | 说明 |
|----------|---------|------|
| `Node` | `DomainParticipant` | ROS2 节点 = DDS 域参与者 |
| `Topic` | `Topic` | 直接对应 |
| `Publisher` | `DataWriter` | 发布者 = 数据写入器 |
| `Subscription` | `DataReader` | 订阅者 = 数据读取器 |
| `QoS Profile` | `QoS Policy` | 服务质量配置 |
| `ROS Domain ID` | `DDS Domain ID` | 0-101 映射到 DDS Domain |
| `rosgraph` | `Builtin Topics` | 发现信息通过内置主题交换 |

---

## 二、RMW 中间件抽象层

### 2.1 RMW 架构设计

RMW (ROS Middleware Interface) 是 ROS2 的中间件抽象层，允许运行时切换不同的 DDS 实现。

```cpp
// RMW 接口定义 (rmw/include/rmw/rmw.h)

// 初始化
rmw_ret_t rmw_init(const rmw_init_options_t* options, rmw_context_t* context);

// 创建节点
rmw_node_t* rmw_create_node(
    rmw_context_t* context,
    const char* name,
    const char* namespace_);

// 创建 Publisher
rmw_publisher_t* rmw_create_publisher(
    const rmw_node_t* node,
    const rosidl_message_type_support_t* type_support,
    const char* topic_name,
    const rmw_qos_profile_t* qos_profile);

// 发布消息
rmw_ret_t rmw_publish(
    const rmw_publisher_t* publisher,
    const void* ros_message);

// 创建 Subscription
rmw_subscription_t* rmw_create_subscription(/* ... */);

// 接收消息
rmw_ret_t rmw_take(
    const rmw_subscription_t* subscription,
    void* ros_message,
    bool* taken);
```

### 2.2 运行时 DDS 切换

```bash
# 查看可用的 RMW 实现
ros2 run rmw_implementation rmw_implementation_info

# 切换 DDS 实现（环境变量）
export RMW_IMPLEMENTATION=rmw_fastrtps_cpp    # Fast-DDS
export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp  # CycloneDDS
export RMW_IMPLEMENTATION=rmw_connext_cpp     # RTI Connext

# 验证当前使用的 DDS
echo $RMW_IMPLEMENTATION
ros2 run demo_nodes_cpp talker --ros-args --rmw-implementation rmw_fastrtps_cpp
```

### 2.3 RMW 实现对比

| 特性 | rmw_fastrtps | rmw_cyclonedds | rmw_connext |
|------|--------------|----------------|-------------|
| **DDS 实现** | Fast-DDS | CycloneDDS | RTI Connext |
| **性能** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **内存占用** | 中 | 低 | 高 |
| **功能完整度** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| **许可证** | Apache 2.0 | EPL 2.0 | 商业/社区版 |
| **ROS2 默认** | 是 (Humble+) | 否 | 否 |
| **实时支持** | 是 | 是 | 是 |
| **安全认证** | DDS-Security | DDS-Security | DDS-Security |

---

## 三、DDS 实现对比与选择

### 3.1 Fast-DDS (eProsima)

**优势**:
- ROS2 Humble+ 默认 DDS
- 功能最完整 (DDS-Security, Discovery Server, SHM)
- 活跃社区，更新频繁
- 完善的文档和示例

**适用场景**:
- 通用机器人开发
- 需要 DDS-Security 的安全应用
- 大型多机器人系统 (Discovery Server)

**安装**:
```bash
# ROS2 已内置，如需独立安装
sudo apt install ros-$ROS_DISTRO-rmw-fastrtps-cpp
```

### 3.2 CycloneDDS (Eclipse)

**优势**:
- 极致性能 (低延迟、高吞吐)
- 内存占用低
- 代码简洁，易于审计
- 优秀的实时性能

**适用场景**:
- 资源受限嵌入式系统
- 硬实时应用
- 高性能计算

**安装**:
```bash
sudo apt install ros-$ROS_DISTRO-rmw-cyclonedds-cpp
```

**性能对比**:
```
测试场景: 1KB 消息，1000Hz，单节点发布/订阅

┌──────────────────┬────────────┬────────────┬────────────┐
│      指标         │ Fast-DDS   │ CycloneDDS │ RTI Connext│
├──────────────────┼────────────┼────────────┼────────────┤
│ 端到端延迟 (μs)   │    85      │    65      │    75      │
│ CPU 占用 (%)      │    15      │    12      │    14      │
│ 内存占用 (MB)     │    45      │    35      │    55      │
│ 最大吞吐 (Mbps)   │   950      │  1200      │  1000      │
└──────────────────┴────────────┴────────────┴────────────┘
```

### 3.3 选择决策树

```
                    ┌─────────────────┐
                    │  选择 DDS 实现   │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
        ┌─────────┐   ┌─────────┐   ┌─────────┐
        │需要极致  │   │需要完整  │   │企业支持  │
        │性能？    │   │功能？    │   │需求？    │
        └────┬────┘   └────┬────┘   └────┬────┘
             │             │             │
        ┌────┴────┐   ┌────┴────┐   ┌────┴────┐
        │  是     │   │  是     │   │  是     │
        └────┬────┘   └────┬────┘   └────┬────┘
             │             │             │
             ▼             ▼             ▼
     ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
     │ CycloneDDS   │ │ Fast-DDS     │ │ RTI Connext  │
     │ (低延迟)      │ │ (功能全面)    │ │ (商业支持)    │
     └──────────────┘ └──────────────┘ └──────────────┘
```

---

## 四、Fast-DDS 与 ROS2 集成

### 4.1 Fast-DDS 在 ROS2 中的配置

```bash
# 1. 设置 RMW 实现
export RMW_IMPLEMENTATION=rmw_fastrtps_cpp

# 2. 设置 Domain ID (0-101，默认 0)
export ROS_DOMAIN_ID=42

# 3. 验证配置
ros2 doctor --report | grep -A 5 "RMW"

# 输出示例:
# RMW MIDDLEWARE
#     middleware name    : rmw_fastrtps_cpp
#     middleware interface: Fast-DDS
```

### 4.2 QoS 配置映射

ROS2 QoS Profile → Fast-DDS QoS:

```cpp
// ROS2 QoS Profile
rclcpp::QoS qos(10);  // History depth = 10
qos.reliable();       // RELIABLE_RELIABILITY_QOS
qos.durability_volatile();  // VOLATILE_DURABILITY_QOS
qos.deadline(rclcpp::Duration::from_seconds(1.0));
qos.liveliness(rclcpp::LivelinessPolicy::Automatic);

// 映射到 Fast-DDS:
// - History: KeepLast(10)
// - Reliability: RELIABLE
// - Durability: VOLATILE
// - Deadline: 1s
// - Liveliness: AUTOMATIC
```

### 4.3 代码示例：ROS2 Node with Fast-DDS

```cpp
// talker.cpp - ROS2 发布者
#include <rclcpp/rclcpp.hpp>
#include <std_msgs/msg/string.hpp>

class Talker : public rclcpp::Node {
public:
    Talker() : Node("talker") {
        // 配置 QoS
        rclcpp::QoS qos(10);
        qos.reliable();
        qos.durability_volatile();
        
        publisher_ = this->create_publisher<std_msgs::msg::String>(
            "chatter", qos);
        
        timer_ = this->create_wall_timer(
            std::chrono::milliseconds(100),
            [this]() { publish_message(); });
    }
    
private:
    void publish_message() {
        auto message = std_msgs::msg::String();
        message.data = "Hello from Fast-DDS! " + 
                      std::to_string(count_++);
        RCLCPP_INFO(this->get_logger(), "Publishing: '%s'", 
                   message.data.c_str());
        publisher_->publish(message);
    }
    
    rclcpp::Publisher<std_msgs::msg::String>::SharedPtr publisher_;
    rclcpp::TimerBase::SharedPtr timer_;
    size_t count_ = 0;
};

int main(int argc, char* argv[]) {
    rclcpp::init(argc, argv);
    rclcpp::spin(std::make_shared<Talker>());
    rclcpp::shutdown();
    return 0;
}
```

```cpp
// listener.cpp - ROS2 订阅者
#include <rclcpp/rclcpp.hpp>
#include <std_msgs/msg/string.hpp>

class Listener : public rclcpp::Node {
public:
    Listener() : Node("listener") {
        // 配置 QoS (必须与发布者兼容)
        rclcpp::QoS qos(10);
        qos.reliable();
        qos.durability_volatile();
        
        subscription_ = this->create_subscription<std_msgs::msg::String>(
            "chatter", qos,
            [this](const std_msgs::msg::String::SharedPtr msg) {
                RCLCPP_INFO(this->get_logger(), 
                           "Received: '%s'", msg->data.c_str());
            });
    }
    
private:
    rclcpp::Subscription<std_msgs::msg::String>::SharedPtr subscription_;
};

int main(int argc, char* argv[]) {
    rclcpp::init(argc, argv);
    rclcpp::spin(std::make_shared<Listener>());
    rclcpp::shutdown();
    return 0;
}
```

### 4.4 CMakeLists.txt 配置

```cmake
cmake_minimum_required(VERSION 3.8)
project(fastdds_ros2_demo)

if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

find_package(ament_cmake REQUIRED)
find_package(rclcpp REQUIRED)
find_package(std_msgs REQUIRED)

# 发布者
add_executable(talker src/talker.cpp)
ament_target_dependencies(talker rclcpp std_msgs)

# 订阅者
add_executable(listener src/listener.cpp)
ament_target_dependencies(listener rclcpp std_msgs)

install(TARGETS
  talker
  listener
  DESTINATION lib/${PROJECT_NAME})

ament_package()
```

---

## 五、配置与调优

### 5.1 Fast-DDS XML 配置文件

ROS2 允许通过 XML 文件配置底层 DDS 参数：

```xml
<!-- fastdds_config.xml -->
<?xml version="1.0" encoding="UTF-8" ?>
<dds xmlns="http://www.eprosima.com/XMLSchemas/fastRTPS_Profiles">
    <profiles>
        <!-- 默认 Participant 配置 -->
        <participant profile_name="ros2_participant" is_default_profile="true">
            <rtps>
                <!-- 名称 -->
                <name>ROS2_FastDDS_Node</name>
                
                <!-- 内置传输配置 -->
                <builtinTransports>UDPv4</builtinTransports>
                
                <!-- 发现协议配置 -->
                <discoveryConfig>
                    <discoveryProtocol>SIMPLE</discoveryProtocol>
                    <leaseDuration><sec>20</sec></leaseDuration>
                    <leaseAnnouncement><sec>3</sec></leaseAnnouncement>
                </discoveryConfig>
                
                <!-- 传输层缓冲区 -->
                <sendSocketBufferSize>1048576</sendSocketBufferSize>
                <listenSocketBufferSize>1048576</listenSocketBufferSize>
                
                <!-- 端口配置 -->
                <port>
                    <domainIDGain>200</domainIDGain>
                    <participantIDGain>10</participantIDGain>
                </port>
            </rtps>
        </participant>
        
        <!-- Publisher 配置 -->
        <publisher profile_name="ros2_publisher" is_default_profile="true">
            <qos>
                <reliability>
                    <kind>RELIABLE</kind>
                </reliability>
                <durability>
                    <kind>VOLATILE</kind>
                </durability>
                <history>
                    <kind>KEEP_LAST</kind>
                    <depth>10</depth>
                </history>
            </qos>
        </publisher>
        
        <!-- Subscriber 配置 -->
        <subscriber profile_name="ros2_subscriber" is_default_profile="true">
            <qos>
                <reliability>
                    <kind>RELIABLE</kind>
                </reliability>
                <durability>
                    <kind>VOLATILE</kind>
                </durability>
                <history>
                    <kind>KEEP_LAST</kind>
                    <depth>10</depth>
                </history>
            </qos>
        </subscriber>
    </profiles>
</dds>
```

### 5.2 使用 XML 配置

```bash
# 方式1: 环境变量
export FASTRTPS_DEFAULT_PROFILES_FILE=/path/to/fastdds_config.xml

# 方式2: 代码中加载
std::string xml_file = "/path/to/fastdds_config.xml";
DomainParticipantFactory::get_instance()->load_XML_profiles_file(xml_file);

# 方式3: ROS2 launch 文件
from launch import LaunchDescription
from launch.actions import SetEnvironmentVariable
from launch_ros.actions import Node

def generate_launch_description():
    return LaunchDescription([
        SetEnvironmentVariable(
            'FASTRTPS_DEFAULT_PROFILES_FILE',
            '/path/to/fastdds_config.xml'
        ),
        Node(
            package='my_package',
            executable='talker',
            name='talker'
        ),
    ])
```

### 5.3 Discovery Server 配置 (大型系统)

```xml
<!-- discovery_server_config.xml -->
<dds>
    <profiles>
        <!-- Server 配置 -->
        <participant profile_name="server_profile">
            <rtps>
                <discoveryConfig>
                    <discoveryProtocol>SERVER</discoveryProtocol>
                    <!-- Server 监听地址 -->
                    <metatrafficUnicastLocatorList>
                        <locator>
                            <udpv4>
                                <address>192.168.1.100</address>
                                <port>11811</port>
                            </udpv4>
                        </locator>
                    </metatrafficUnicastLocatorList>
                    
                    <!-- 租约配置 -->
                    <leaseDuration><sec>60</sec></leaseDuration>
                </discoveryConfig>
            </rtps>
        </participant>
        
        <!-- Client 配置 -->
        <participant profile_name="client_profile" is_default_profile="true">
            <rtps>
                <discoveryConfig>
                    <discoveryProtocol>CLIENT</discoveryProtocol>
                    
                    <!-- 连接到 Server -->
                    <metatrafficUnicastLocatorList>
                        <locator>
                            <udpv4>
                                <address>192.168.1.100</address>
                                <port>11811</port>
                            </udpv4>
                        </locator>
                    </metatrafficUnicastLocatorList>
                </discoveryConfig>
            </rtps>
        </participant>
    </profiles>
</dds>
```

### 5.4 共享内存传输 (同机优化)

```xml
<!-- shm_config.xml -->
<dds>
    <profiles>
        <participant profile_name="shm_profile" is_default_profile="true">
            <rtps>
                <!-- 禁用内置传输 -->
                <builtinTransports>NONE</builtinTransports>
                
                <!-- 添加共享内存传输 -->
                <transportDescriptors>
                    <transportDescriptor>
                        <transport_id>shm_transport</transport_id>
                        <type>SHM</type>
                        <segmentSize>10485760</segmentSize>  <!-- 10MB -->
                    </transportDescriptor>
                </transportDescriptors>
                
                <!-- 用户传输列表 -->
                <userTransports>
                    <transport_id>shm_transport</transport_id>
                </userTransports>
            </rtps>
        </participant>
    </profiles>
</dds>
```

---

## 六、调试与监控

### 6.1 ROS2 调试工具

```bash
# 1. 查看节点列表
ros2 node list

# 2. 查看话题列表
ros2 topic list
ros2 topic list -t  # 显示类型

# 3. 查看话题信息
ros2 topic info /chatter
# 输出:
# Type: std_msgs/msg/String
# Publisher count: 1
# Subscription count: 1

# 4. 监控话题数据
ros2 topic echo /chatter

# 5. 查看话题带宽
ros2 topic bw /chatter

# 6. 查看话题延迟
ros2 topic delay /chatter

# 7. 查看 DDS 图结构
ros2 run rqt_graph rqt_graph

# 8. 查看节点详情
ros2 node info /talker
```

### 6.2 Fast-DDS 调试工具

```bash
# 1. 启用 Fast-DDS 日志
export FASTDDS_DEFAULT_PROFILES_FILE=/path/to/log_config.xml

# log_config.xml:
# <log>
#     <verbosity>DEBUG</verbosity>
# </log>

# 2. 使用 DDS Spy 监控
ros2 run fastdds fastdds spy --domain 42

# 3. 统计信息
ros2 run fastdds fastdds shm clean  # 清理共享内存
ros2 run fastdds fastdds shm info   # 查看共享内存信息

# 4. Wireshark 抓包
# 过滤: rtps
# 可以看到 SPDP/SEDP/HEARTBEAT/DATA 等消息
```

### 6.3 性能监控

```python
#!/usr/bin/env python3
"""ROS2 DDS 性能监控工具"""

import rclpy
from rclpy.node import Node
from std_msgs.msg import String
import time
import statistics

class DDSMonitor(Node):
    def __init__(self):
        super().__init__('dds_monitor')
        
        self.latencies = []
        self.message_count = 0
        self.start_time = time.time()
        
        # 创建订阅
        self.subscription = self.create_subscription(
            String,
            '/chatter',
            self.listener_callback,
            10)
        
        # 定时报告
        self.timer = self.create_timer(5.0, self.report_callback)
        
        self.get_logger().info('DDS Monitor started')
    
    def listener_callback(self, msg):
        # 假设消息包含时间戳
        try:
            parts = msg.data.split(',')
            if len(parts) >= 2:
                send_time = float(parts[1])
                latency = (time.time() - send_time) * 1000  # ms
                self.latencies.append(latency)
                self.message_count += 1
        except:
            self.message_count += 1
    
    def report_callback(self):
        elapsed = time.time() - self.start_time
        rate = self.message_count / elapsed if elapsed > 0 else 0
        
        if self.latencies:
            avg_latency = statistics.mean(self.latencies)
            max_latency = max(self.latencies)
            min_latency = min(self.latencies)
            
            self.get_logger().info(
                f'Messages: {self.message_count}, '
                f'Rate: {rate:.1f} Hz, '
                f'Latency: {avg_latency:.2f}ms '
                f'(min: {min_latency:.2f}, max: {max_latency:.2f})'
            )
        else:
            self.get_logger().info(f'Messages: {self.message_count}, Rate: {rate:.1f} Hz')

def main(args=None):
    rclpy.init(args=args)
    monitor = DDSMonitor()
    rclpy.spin(monitor)
    monitor.destroy_node()
    rclpy.shutdown()

if __name__ == '__main__':
    main()
```

---

## 七、常见问题与解决方案

### 7.1 发现失败

**问题**: 节点之间无法发现

**排查步骤**:
```bash
# 1. 检查 Domain ID
ros2 doctor | grep -i domain

# 2. 检查网络连通性
ping <other_host>

# 3. 检查防火墙
sudo iptables -L | grep -i udp

# 4. 检查多播 (Simple Discovery)
socat UDP4-RECVFROM:7400,ip-add-membership=239.255.0.1:0.0.0.0 -
```

**解决方案**:
```xml
<!-- 跨网段/云环境使用 Discovery Server -->
<discoveryConfig>
    <discoveryProtocol>SERVER/CLIENT</discoveryProtocol>
    <!-- Server IP 配置 -->
</discoveryConfig>
```

### 7.2 QoS 不匹配

**问题**: 发布者和订阅者无法匹配

**诊断**:
```bash
ros2 topic info /topic_name --verbose
```

**常见 QoS 不匹配**:
| 发布者 QoS | 订阅者 QoS | 兼容性 | 建议 |
|-----------|-----------|--------|------|
| RELIABLE | BEST_EFFORT | ❌ | 订阅者改为 RELIABLE |
| BEST_EFFORT | RELIABLE | ✅ | OK (降级) |
| VOLATILE | TRANSIENT_LOCAL | ❌ | 不匹配 |
| KEEP_ALL | KEEP_LAST | ✅ | OK (混合) |

### 7.3 内存泄漏

**问题**: 长时间运行内存持续增长

**原因**:
- KEEP_ALL History 无限制
- 未清理的孤立 Reader/Writer
- 共享内存段未释放

**解决**:
```xml
<!-- 限制 History -->
<history>
    <kind>KEEP_LAST</kind>
    <depth>100</depth>
</history>
<resourceLimits>
    <maxSamples>100</maxSamples>
</resourceLimits>
```

### 7.4 高延迟

**优化 checklist**:

```bash
# 1. 使用共享内存 (同机)
export RMW_IMPLEMENTATION=rmw_fastrtps_cpp
export FASTRTPS_DEFAULT_PROFILES_FILE=shm_config.xml

# 2. 调整缓冲区大小
export RMW_FASTRTPS_SEND_BUFFER_SIZE=1048576
export RMW_FASTRTPS_RECEIVE_BUFFER_SIZE=1048576

# 3. 禁用 Nagle 算法 (TCP)
sudo sysctl -w net.ipv4.tcp_nodelay=1

# 4. CPU 亲和性
taskset -c 0 ./ros2_node
```

---

## 八、从 ROS1 迁移

### 8.1 核心差异

| 方面 | ROS1 | ROS2 |
|------|------|------|
| **中间件** | 自定义 TCPROS | DDS |
| **发现** | Master 节点 | 分布式发现 |
| **QoS** | 无 | 丰富 |
| **构建工具** | catkin | colcon |
| **节点** | 单进程多节点 | 单节点单进程 |
| **生命周期** | 无 | 有 |
| **安全** | 无 | DDS-Security |

### 8.2 迁移工具

```bash
# 1. 安装 ros1_bridge
sudo apt install ros-$ROS_DISTRO-ros1-bridge

# 2. 启动桥接 (ROS1 <-> ROS2)
source /opt/ros/noetic/setup.bash
source /opt/ros/jazzy/setup.bash
ros2 run ros1_bridge dynamic_bridge --bridge-all-topics

# 3. 使用 rosbag 迁移数据
ros2 bag convert -i input.bag -o output.db3
```

### 8.3 代码迁移示例

**ROS1**:
```cpp
ros::init(argc, argv, "talker");
ros::NodeHandle nh;
ros::Publisher pub = nh.advertise<std_msgs::String>("chatter", 10);
ros::Rate loop_rate(10);

while (ros::ok()) {
    std_msgs::String msg;
    msg.data = "hello";
    pub.publish(msg);
    ros::spinOnce();
    loop_rate.sleep();
}
```

**ROS2**:
```cpp
rclcpp::init(argc, argv);
auto node = rclcpp::Node::make_shared("talker");

rclcpp::QoS qos(10);
auto pub = node->create_publisher<std_msgs::msg::String>("chatter", qos);

rclcpp::Rate loop_rate(10);
while (rclcpp::ok()) {
    std_msgs::msg::String msg;
    msg.data = "hello";
    pub->publish(msg);
    rclcpp::spin_some(node);
    loop_rate.sleep();
}
rclcpp::shutdown();
```

---

## 九、最佳实践总结

### 9.1 开发建议

1. **始终使用 QoS 配置文件**，不要硬编码
2. **大型系统使用 Discovery Server**，减少网络负载
3. **同机通信优先使用 SHM**，降低延迟
4. **跨网段通信使用 TCP**，穿透 NAT
5. **关键数据使用 Reliable + Deadline**，保证时效性

### 9.2 生产环境 checklist

- [ ] Domain ID 规划 (0-101，避免冲突)
- [ ] QoS 策略文档化
- [ ] DDS 实现选择文档
- [ ] XML 配置文件版本控制
- [ ] 监控和告警配置
- [ ] 安全认证配置 (DDS-Security)
- [ ] 故障恢复机制

---

*文档版本: 1.0*  
*最后更新: 2026-03-13*  
*关联笔记: 00-Core-Classes-Reference.md, 03A-Discovery-Server-Detail.md*
