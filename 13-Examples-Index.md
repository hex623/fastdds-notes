# 13 Fast-DDS Examples 完整教程系列

**记录时间**: 2026-03-04  
**学习目标**: 通过13个官方示例深入理解 Fast-DDS 源码  
**前置知识**: 01-12 基础笔记

---

## 📚 教程系列概览

Fast-DDS 官方提供了 **13个 C++ 示例**，涵盖了从基础到高级的各种使用场景。通过逐一学习这些示例，可以全面掌握 Fast-DDS 的核心概念和源码实现。

### 示例列表

| 编号 | 示例名称 | 核心概念 | 难度 | 预计学习时长 |
|------|---------|---------|------|-------------|
| 1 | [hello_world](./13-Example-01-HelloWorld.md) | 基础 Pub/Sub，Listener vs WaitSet | ⭐ | 30分钟 |
| 2 | [rtps](./13-Example-02-RTPS.md) | RTPS 底层 API | ⭐⭐ | 45分钟 |
| 3 | [discovery_server](./13-Example-03-DiscoveryServer.md) | Discovery Server 集中式发现 | ⭐⭐ | 45分钟 |
| 4-13 | [其他示例速查](./13-Example-04-13-QuickRef.md) | Static EDP、Config、Filter、Flow Control、Delivery、Instances、Pool、Security、XTypes、Benchmark | ⭐⭐⭐-⭐⭐⭐⭐⭐ | 各30-60分钟 |

---

## 🎯 学习路径建议

### 路径 1：循序渐进（推荐新手）

```
Week 1: 基础入门
├── Day 1-2: hello_world (理解基础 Pub/Sub)
├── Day 3-4: rtps (理解 RTPS 层)
└── Day 5-7: discovery_server (理解发现机制)

Week 2: 进阶特性
├── Day 1-2: configuration (XML 配置)
├── Day 3-4: content_filter (内容过滤)
└── Day 5-7: flow_control + delivery_mechanisms

Week 3: 高级主题
├── Day 1-2: topic_instances
├── Day 3-4: custom_payload_pool
├── Day 5-6: security
└── Day 7: xtypes

Week 4: 性能优化
└── benchmark + 综合实战
```

### 路径 2：问题导向（有具体需求）

| 需求 | 推荐示例 |
|------|---------|
| 理解基础架构 | hello_world, rtps |
| 大规模部署 | discovery_server, static_edp_discovery |
| 灵活配置 | configuration |
| 数据过滤 | content_filter |
| 性能调优 | flow_control, custom_payload_pool, benchmark |
| 安全加固 | security |
| 动态类型 | xtypes |

---

## 📖 每个示例的学习方法

### 学习步骤

1. **阅读 README** - 理解示例目标和运行方法
2. **分析源码结构** - 查看文件组织和类设计
3. **跟踪关键流程** - 从 main 函数开始跟踪执行流程
4. **理解核心 API** - 掌握关键类的使用方法
5. **动手运行** - 编译运行，观察输出
6. **修改实验** - 修改参数，观察行为变化
7. **记录笔记** - 整理学习心得

### 源码阅读技巧

```cpp
// 1. 从 main 函数开始
int main(int argc, char** argv)
{
    // 2. 关注实体创建顺序
    DomainParticipant* participant = 
        DomainParticipantFactory::get_instance()->create_participant(...);
    
    // 3. 理解 QoS 配置
    Publisher* publisher = participant->create_publisher(PUBLISHER_QOS_DEFAULT);
    
    // 4. 跟踪数据流向
    DataWriter* writer = publisher->create_datawriter(topic, writer_qos, &listener);
    
    // 5. 理解回调机制
    writer->write(&data);
}
```

---

## 🛠️ 环境准备

### 编译示例代码

```bash
# 1. 进入 Fast-DDS 源码目录
cd ~/Documents/GitHub/Fast-DDS

# 2. 创建构建目录
mkdir -p build/examples && cd build/examples

# 3. 配置 CMake
cmake ../../examples/cpp -DCMAKE_BUILD_TYPE=Release

# 4. 编译所有示例
make -j$(nproc)

# 5. 或者单独编译某个示例
cd hello_world && make
```

### 运行环境要求

- **操作系统**: Ubuntu 20.04+ / macOS / Windows
- **依赖库**: Fast-DDS 库已安装
- **网络**: 本地回环测试不需要特殊网络
- **权限**: 普通用户权限即可

---

## 📝 学习笔记模板

建议为每个示例记录以下内容：

```markdown
# Example X: [名称]

## 学习目标
- 理解 [核心概念]
- 掌握 [关键 API]

## 核心类图
```
[绘制关键类的关系图]
```

## 执行流程
1. [步骤1]
2. [步骤2]
3. [步骤3]

## 关键代码分析
```cpp
// [代码片段]
```

## 运行结果
```
[实际输出]
```

## 实验记录
- [实验1] 修改 [参数]，观察到 [现象]
- [实验2] 修改 [代码]，观察到 [现象]

## 与笔记关联
- [关联到 01-RTPS-Source-Analysis.md 的某个概念]
- [关联到 09-Advanced-Topics.md 的某个机制]

## 收获与疑问
- [学到的知识点]
- [未理解的问题]
```

---

## 🔗 参考链接

- [Fast-DDS Examples 官方文档](https://fast-dds.docs.eprosima.com/en/latest/fastdds/examples/examples.html)
- [GitHub 源码](https://github.com/eProsima/Fast-DDS/tree/master/examples/cpp)
- [Fast-DDS 安装指南](https://fast-dds.docs.eprosima.com/en/latest/installation/binaries/binaries_linux.html)

---

## ✅ 学习检查清单

- [ ] 完成 hello_world 示例，理解基础 Pub/Sub
- [ ] 完成 rtps 示例，理解 RTPS 层 API
- [ ] 完成 discovery_server 示例，理解集中式发现
- [ ] 阅读所有示例的源码
- [ ] 运行至少 5 个示例并观察输出
- [ ] 修改至少 2 个示例的参数并观察变化
- [ ] 整理每个示例的学习笔记

---

_开始学习第一个示例：[hello_world](./13-Example-01-HelloWorld.md)_ 🚀
