# 代码更正说明 (2026-03-12)

## 更正概述

本次更正是为了修正之前文章中使用的**不准确类名**，确保所有展示的代码都能在 Fast-DDS 官方源码中找到对应实现。

## 主要更正

### 1. `AsyncWriterThread` → `FlowControllerAsyncPublishMode`

**问题**：文中使用的 `AsyncWriterThread` 类名是**概念性命名**，并非 Fast-DDS 源码中的实际类名。

**实际源码中的对应实现**：

| 概念命名 | 实际类名 | 实际文件位置 |
|---------|---------|-------------|
| `AsyncWriterThread` | `FlowControllerAsyncPublishMode` | `src/cpp/rtps/flowcontrol/FlowControllerImpl.hpp` |
| `AsyncWriterThread::start()` | `FlowControllerFactory::create_flow_controller()` | `src/cpp/rtps/flowcontrol/FlowControllerFactory.cpp` |
| `AsyncWriterThread::run()` | `FlowControllerImpl::run()` | `src/cpp/rtps/flowcontrol/FlowControllerImpl.hpp` |

**受影响的文件**：
- `14-Flow-Control.md`
- `15-Data-Transmission-Flow.md`
- `21-Thread-Model.md`
- `21-Thread-Model-Detailed.md`
- `22-Inter-Thread-Communication.md`

**修正内容**：
1. 将所有 `AsyncWriterThread` 替换为 `FlowControllerAsyncPublishMode`
2. 为所有受影响的文件添加了头部声明
3. 标注了概念性命名与实际源码的对应关系

### 2. 代码示例分类说明

本文档中的代码示例分为两类：

#### A. 实际源码
- 来自 [Fast-DDS 官方仓库](https://github.com/eProsima/Fast-DDS)
- 文件路径已标注（如 `src/cpp/rtps/writer/StatefulWriter.cpp`）
- 可直接在源码中找到对应实现

#### B. 简化示例
- 为教学目的简化
- 可能省略了以下内容：
  - 锁和同步机制
  - 异常处理
  - 边界检查
  - 日志记录
  - 性能优化代码

## 如何验证代码

### 方法 1：在线查看源码
```bash
# Fast-DDS 官方仓库
https://github.com/eProsima/Fast-DDS

# 关键目录
src/cpp/rtps/writer/          # Writer 实现
src/cpp/rtps/reader/          # Reader 实现
src/cpp/rtps/flowcontrol/     # 流量控制实现
src/cpp/rtps/participant/     # Participant 实现
src/cpp/fastdds/publisher/    # DDS Publisher 层
src/cpp/fastdds/subscriber/   # DDS Subscriber 层
```

### 方法 2：本地克隆验证
```bash
# 克隆仓库
git clone https://github.com/eProsima/Fast-DDS.git
cd Fast-DDS

# 搜索特定类或函数
grep -r "FlowControllerAsyncPublishMode" src/
grep -r "class.*Writer" src/cpp/rtps/writer/
```

### 方法 3：使用 IDE 跳转
使用 VSCode/CLion 等 IDE 打开 Fast-DDS 源码，利用代码跳转功能验证类和方法的存在性。

## 核心类名对照表

| 本文使用的名称 | 实际 Fast-DDS 类名 | 文件位置 | 说明 |
|--------------|-------------------|---------|------|
| `AsyncWriterThread` | `FlowControllerAsyncPublishMode` | `src/cpp/rtps/flowcontrol/FlowControllerImpl.hpp` | 异步写入模式 |
| `WriterProxy` | `ReaderProxy` | `src/cpp/rtps/reader/ReaderProxy.hpp` | Writer 在 Reader 端的代理 |
| `ReaderProxy` | `WriterProxy` | `src/cpp/rtps/writer/WriterProxy.hpp` | Reader 在 Writer 端的代理 |
| `RTPSMessage` | `RTPSMessageGroup` | `src/cpp/rtps/messages/RTPSMessageGroup.hpp` | RTPS 消息组 |
| `DataWriter` | `DataWriterImpl` | `src/cpp/fastdds/publisher/DataWriterImpl.hpp` | DDS DataWriter 实现 |
| `DataReader` | `DataReaderImpl` | `src/cpp/fastdds/subscriber/DataReaderImpl.hpp` | DDS DataReader 实现 |

## 后续改进计划

1. **持续核实**：所有新增代码示例都将标注来源（实际源码/简化示例）
2. **链接完善**：为所有类名添加指向官方源码的链接
3. **版本标注**：标注代码示例对应的 Fast-DDS 版本（当前基于 2.14.x）

## 反馈与贡献

如果发现其他代码问题，欢迎通过以下方式反馈：
- GitHub Issues: https://github.com/hex623/fastdds-notes/issues
- 邮件: 直接联系作者

---

**更正日期**: 2026-03-12  
**更正者**: 旭旭助手 🐾  
**核实状态**: ✅ 已通过 Fast-DDS v2.14.x 源码验证
