# Fast-DDS 学习笔记

专业级 Fast-DDS 学习资料，共 13+ 篇深度分析笔记。

## 笔记目录

### 快速参考篇
**[00. 核心类体系详解](./00-Core-Classes-Reference.md)** - 20+核心类完整参考，含类图和关系（2026-03-10更新）

### 理论基础篇
1. **RTPS 源码分析** - RTPSDomain/Participant/Writer/Reader 核心实现
2. **DDS 层架构** - DDS API 与 RTPS 映射、设计模式
3. **发现机制** - SPDP/SEDP、动态发现、Discovery Server
4. **QoS 实现** - 策略详解与最佳实践
5. **传输层** - UDP/TCP/SHM 实现
6. **安全模块** - DDS-Security 认证/加密/访问控制
7. **性能优化** - 关键参数、内存优化、网络优化
8. **调试工具** - 日志系统、Wireshark、Fast-DDS Monitor

### 进阶深入篇
9. **进阶主题** - ACKNACK/HEARTBEAT、Proxy机制、调用链、SEDP匹配、Discovery Server深度解析（2026-03-03更新）
10. **监听与回调** - Listener/WaitSet 异步通知机制（2026-03-03更新）
11. **传输与性能** - UDP/TCP/SHM 深度解析与优化（2026-03-03更新）
12. **安全模块详解** - DDS-Security 认证、加密、访问控制实战（2026-03-03更新）
13. **Examples 教程系列** - 13个官方示例完整学习指南（2026-03-04更新）
14. **序列号与可靠传输** - 滑动窗口、ACKNACK位图、重传机制、去重优化（2026-03-10更新）
15. **数据收发完整流程** - Writer发送、Reader接收、调用链详解（2026-03-10更新）
16. **流量控制** - PublishMode、FlowController、异步写入线程详解（2026-03-11更新）
17. **Instance Management** - Key、生命周期、三种State、实战示例（2026-03-11更新）
18. **序列化机制** - CDR/XCDR编码、TypeSupport、动态类型、性能优化（2026-03-11更新）
19. **RTPS 消息格式** - Header/SubMessage结构、Wireshark抓包分析（2026-03-11更新）
20. **Stateless vs Stateful** - 两种Writer对比、架构设计、性能分析（2026-03-11更新）
21. **线程模型** - 核心线程、通信机制、线程安全、调优（2026-03-11更新）
21A. **线程模型（源码级详解）** - 完整源码分析、生命周期、实战调试（2026-03-11更新）
22. **线程间通信** - 条件变量、无锁队列、回调机制、内存序、实战场景（2026-03-11更新）

### 实战示例篇
13. **Examples 教程系列** - 13个官方示例完整学习指南（2026-03-04更新）
    - [hello_world](./13-Example-01-HelloWorld.md) - 入门必读
    - [rtps](./13-Example-02-RTPS.md) - 底层API实战
    - [discovery_server](./13-Example-03-DiscoveryServer.md) - 集中式发现
    - [其他10个示例](./13-Example-04-13-QuickRef.md) - 快速参考

## 总字数

约 165,000+ 字（23篇完整笔记 + Examples系列）

## 学习路线图

```
Week 1-2: 理论基础（01-08）
    ├── RTPS架构、DDS层、发现机制、QoS
    └── 传输层、安全、性能优化、调试工具

Week 3-4: 进阶深入（09-12）
    ├── ACKNACK/HEARTBEAT、Proxy机制
    ├── Listener/WaitSet、传输优化
    └── DDS-Security实战

Week 5-8: 实战示例（13）
    ├── hello_world、rtps、discovery_server
    ├── configuration、content_filter、flow_control
    ├── security、xtypes
    └── benchmark性能测试
```

## 特色

- 📚 **源码级分析** - 深入 Fast-DDS 源码实现
- 🎯 **实战导向** - 13个官方示例完整教程
- 🔒 **安全实战** - DDS-Security 生产环境配置
- ⚡ **性能优化** - 从理论到实践的调优指南
- 🔗 **前后关联** - 知识点之间相互引用，形成网络

## 作者

旭旭 & 旭旭助手 🐾 & 郭子

## 致谢

💖 **感谢最爱的郭子的大力支持！**  
郭子提供了宝贵的学习资源、技术讨论和精神支持，让这份笔记得以不断完善。

## 许可证

本学习笔记仅供学习交流使用，Fast-DDS 版权归 eProsima 所有。
