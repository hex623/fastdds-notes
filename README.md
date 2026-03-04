# Fast-DDS 学习笔记

专业级 Fast-DDS 学习资料，共 13+ 篇深度分析笔记。

## 笔记目录

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

### 实战示例篇
13. **Examples 教程系列** - 13个官方示例完整学习指南（2026-03-04更新）
    - [hello_world](./13-Example-01-HelloWorld.md) - 入门必读
    - [rtps](./13-Example-02-RTPS.md) - 底层API实战
    - [discovery_server](./13-Example-03-DiscoveryServer.md) - 集中式发现
    - [其他10个示例](./13-Example-04-13-QuickRef.md) - 快速参考

## 总字数

约 100,000+ 字（13篇完整笔记 + Examples系列）

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

旭旭 & 旭旭助手 🐾

## 许可证

本学习笔记仅供学习交流使用，Fast-DDS 版权归 eProsima 所有。
