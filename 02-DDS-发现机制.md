# 02 - DDS 发现机制

**来源**: 2026-03-03 深度讲解  
**整理时间**: 2026-03-17

---

## 发现协议概述

DDS 使用两阶段发现机制：
1. **SPDP** - Simple Participant Discovery Protocol
2. **SEDP** - Simple Endpoint Discovery Protocol

---

## SPDP - 第一阶段：发现 Participant

### 功能
- 发现网络中的其他 Participant
- 周期性宣告 DATA(p) 消息
- 租约机制 (leaseDuration) 检测离线

### 消息流程
```
Participant A                  Participant B
     |                              |
     |---- DATA(p) [广播/组播] ---->|
     |<--- DATA(p) [响应] ---------|
     |                              |
     [互相发现，进入 SEDP 阶段]      |
```

### 租约机制
- **宣告周期**: 3秒
- **租约时长**: 20秒
- **故障检测**: 超过租约未收到宣告则清理条目

---

## SEDP - 第二阶段：发现 Endpoint

### 功能
- 发现 DataWriter/DataReader
- 4个内置端点交换信息
- QoS 兼容性检查

### 内置端点
| 端点 | 作用 | 方向 |
|------|------|------|
| SEDP Pub Writer | 宣告本地 Writer | 发送 |
| SEDP Pub Reader | 接收远端 Writer 信息 | 接收 |
| SEDP Sub Writer | 宣告本地 Reader | 发送 |
| SEDP Sub Reader | 接收远端 Reader 信息 | 接收 |

### 匹配流程
```
Writer 创建 → SEDP::announceWriter() → 发送 DATA(w)
  ↓
Reader 收到 DATA(w) → check_matching() → 匹配成功
  ↓
创建 WriterProxy → 发送 DATA(r) 回应
  ↓
Writer 收到 DATA(r) → 创建 ReaderProxy
  ↓
建立 RTPS 连接，开始传输
```

---

## 匹配条件

### 1. 主题名称相同
### 2. 类型名称兼容
### 3. QoS 兼容性

| Writer QoS | Reader QoS | 结果 |
|------------|------------|------|
| RELIABLE | BEST_EFFORT | ❌ 不匹配 |
| BEST_EFFORT | RELIABLE | ✅ 降级匹配 |
| VOLATILE | TRANSIENT_LOCAL | ❌ 不匹配 |
| TRANSIENT_LOCAL | VOLATILE | ✅ 降级匹配 |

**规则**: Writer 不能降级满足 Reader 的要求

---

## 动态发现

### 节点加入
```
新节点加入
  ↓
发送 SPDP DATA(p)
  ↓
现有节点发现新节点
  ↓
交换 SEDP 信息
  ↓
建立连接，自动开始通信
```

### 节点离开
```
租约超时（20秒未收到宣告）
  ↓
清理对应 Participant 条目
  ↓
清理关联的 WriterProxy/ReaderProxy
  ↓
通知应用层连接断开
```

---

## 发现协议对比

| 特性 | SPDP | SEDP |
|------|------|------|
| 发现对象 | Participant | Writer/Reader |
| 消息类型 | DATA(p) | DATA(w)/DATA(r) |
| 内置端点 | 2个 | 4个 |
| 匹配检查 | 无 | QoS 兼容性检查 |
| 顺序 | 先执行 | 后执行 |

---

_整理自 2026-03-03 发现机制讲解_
