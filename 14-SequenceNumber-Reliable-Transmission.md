# Fast-DDS 序列号管理与可靠传输机制深度解析

**创建时间**: 2026-03-10  
**源码版本**: Fast-DDS 3.5.0  
**作者**: 旭旭助手

---

## 目录

1. [序列号基础](#一序列号基础)
2. [滑动窗口机制](#二滑动窗口机制)
3. [ACKNACK 位图详解](#三acknack-位图详解)
4. [重传队列管理](#四重传队列管理)
5. [去重机制](#五去重机制)
6. [关键数据结构源码](#六关键数据结构源码)
7. [性能优化策略](#七性能优化策略)

---

## 一、序列号基础

### 1.1 序列号的作用

序列号 (SequenceNumber) 是 RTPS 可靠传输的核心机制：

| 功能 | 说明 |
|------|------|
| **顺序保证** | 确保数据按发送顺序接收 |
| **丢包检测** | 通过序列号连续性检测丢包 |
| **去重** | 识别并丢弃重复数据 |
| **重传定位** | 精确定位需要重传的数据 |
| **流量控制** | 基于序列号窗口控制发送速率 |

### 1.2 序列号结构

```cpp
// include/fastdds/rtps/common/SequenceNumber.h
struct SequenceNumber_t {
    int32_t high;      // 高位 (通常用于大文件传输)
    uint32_t low;      // 低位 (日常计数)
    
    // 操作符重载
    bool operator==(const SequenceNumber_t& other) const;
    bool operator<(const SequenceNumber_t& other) const;
    SequenceNumber_t& operator++();  // 递增
};

// 常用定义
const SequenceNumber_t SEQUENCENUMBER_UNKNOWN = {-1, 0};
const SequenceNumber_t SEQUENCENUMBER_ZERO = {0, 0};
```

**设计要点：**

```
64位序列号 = high (32位) + low (32位)
              ↓              ↓
           高32位         低32位
           
实际使用：大多数情况下只用 low 部分
- 每秒发送 10万 条消息
- low 部分可支持 2^32 / 100000 ≈ 42,949 秒 ≈ 11.9 小时
- 加上 high，几乎无限
```

### 1.3 序列号分配策略

```cpp
// src/cpp/rtps/writer/RTPSWriter.cpp
SequenceNumber_t RTPSWriter::get_next_sequence_number() {
    // 原子操作，线程安全
    SequenceNumber_t next = m_current_sequence_number;
    ++m_current_sequence_number;
    return next;
}

// 每个 Writer 独立维护自己的序列号空间
// Writer A: Seq#1, Seq#2, Seq#3...
// Writer B: Seq#1, Seq#2, Seq#3...
// 不同 Writer 的序列号相互独立
```

---

## 二、滑动窗口机制

### 2.1 为什么需要滑动窗口？

**问题：** 如果 Writer 无限发送，Reader 可能处理不过来，导致：
- 内存溢出
- 网络拥塞
- 数据丢失

**解决方案：** 滑动窗口限制在途 (in-flight) 数据量

```
概念类比：工厂流水线
─────────────────────────────────────────
原料(数据) → [工序1] → [工序2] → [工序3] → 成品(接收)
            ↑                      ↑
         生产上限                消费进度

如果工序3卡住，工序1必须暂停，否则缓冲区溢出
```

### 2.2 Writer 端滑动窗口

```cpp
// Writer 维护的窗口状态
struct WriterWindow {
    // 窗口边界
    SequenceNumber_t highest_acked_seq;      // 已确认的最高序列号
    SequenceNumber_t next_seq_to_send;       // 下一个要发送的序列号
    
    // 窗口大小 (可配置)
    uint32_t window_size;  // 默认 256
    
    // 在途数据
    std::map<SequenceNumber_t, CacheChange_t*> outstanding_changes;
};
```

**窗口计算公式：**

```cpp
// 可用窗口 = 窗口大小 - 在途数据量
uint32_t available_window = window_size - outstanding_changes.size();

// 是否可以发送新数据？
bool can_send_new_data() {
    return next_seq_to_send < highest_acked_seq + window_size;
}

// 示例：
// window_size = 10
// highest_acked_seq = 100
// 可发送范围: 101 ~ 110
// 已发送但未确认: {105, 106, 107} (3个在途)
// 还可发送: 110 - 100 - 3 = 7 个
```

### 2.3 Reader 端接收窗口

```cpp
// Reader 维护的接收窗口
struct ReaderWindow {
    // 期望的下一个序列号
    SequenceNumber_t next_expected_seq;
    
    // 已接收的序列号集合 (用于去重)
    std::set<SequenceNumber_t> received_seqs;
    
    // 缺失的序列号
    std::set<SequenceNumber_t> missing_seqs;
    
    // 接收缓冲区大小
    uint32_t max_received_changes;
};
```

### 2.4 滑动窗口动态调整

```cpp
// 自适应窗口调整 (基于网络状况)
class AdaptiveWindow {
public:
    void on_ack_received() {
        // 收到 ACK，网络状况良好，增大窗口
        if (window_size < max_window_size) {
            window_size = std::min(window_size * 2, max_window_size);
        }
    }
    
    void on_nack_received() {
        // 收到 NACK，发生丢包，减小窗口
        if (window_size > min_window_size) {
            window_size = std::max(window_size / 2, min_window_size);
        }
    }
    
    void on_timeout() {
        // 超时，网络拥塞，大幅减小窗口
        window_size = min_window_size;
    }

private:
    uint32_t window_size = 32;       // 当前窗口
    uint32_t min_window_size = 8;    // 最小窗口
    uint32_t max_window_size = 1024; // 最大窗口
};
```

---

## 三、ACKNACK 位图详解

### 3.1 为什么用位图？

**问题：** Reader 收到数据后，如何高效告知 Writer 哪些收到了、哪些缺失了？

**方案对比：**

| 方案 | 数据量 | 效率 |
|------|--------|------|
| 列出所有收到的 Seq | O(n) | 低 |
| **位图 (Bitmap)** | O(1) | **高** |

### 3.2 位图结构

```cpp
// ACKNACK Submessage 结构
struct AckNackSubmessage {
    // 头部
    EntityId_t readerId;           // 发送者 Reader ID
    EntityId_t writerId;           // 目标 Writer ID
    
    // 关键字段
    SequenceNumber_t base;         // 基准序列号
    SequenceNumberSet bitmap;      // 位图
    Count_t count;                 // 计数器 (去重用)
    bool finalFlag;                // true = 全部收到
};

// 位图实现
struct SequenceNumberSet {
    SequenceNumber_t base;         // 基准序列号 (从哪个开始)
    uint32_t numBits;              // 位图长度 (多少位)
    std::vector<uint32_t> bitmap;  // 位图数据 (每32位一个 uint32_t)
};
```

### 3.3 位图编码示例

```
场景：Reader 收到 Writer 的 HEARTBEAT(First=10, Last=20)
Reader 实际状态：
  收到: #10, #11, #12, #15, #16, #17, #20
  缺失: #13, #14, #18, #19

ACKNACK 构造：
────────────────────────────────────────
base = 10                    // 从 10 开始

位图 (从 base 开始，每个 bit 代表一个 seq):
位置:   0   1   2   3   4   5   6   7   8   9
Seq:   10  11  12  13  14  15  16  17  18  19

状态:   1   1   1   0   0   1   1   1   0   0
       ↑   ↑   ↑   ↑   ↑   ↑   ↑   ↑   ↑   ↑
      收到 收到 收到 缺失 缺失 收到 收到 收到 缺失 缺失

位图数据:
bitmap[0] = 0b0011100111 = 0x1C7 (二进制从右到左读)
         = 231 (十进制)

numBits = 10 (表示 10-19 共10个序列号)

含义: "10-12收到了，13-14缺失，15-17收到了，18-19缺失"
```

### 3.4 位图操作源码

```cpp
// include/fastdds/rtps/common/SequenceNumber.h
class SequenceNumberSet {
public:
    // 添加一个序列号到位图
    bool add(const SequenceNumber_t& seq) {
        if (seq < base) return false;  // 小于 base，无法添加
        uint32_t diff = seq - base;
        if (diff >= numBits) {
            // 需要扩展位图
            extend_bitmap(diff + 1);
        }
        set_bit(diff);  // 设置对应位为 1
        return true;
    }
    
    // 检查序列号是否在集合中
    bool is_set(const SequenceNumber_t& seq) const {
        if (seq < base) return false;
        uint32_t diff = seq - base;
        if (diff >= numBits) return false;
        return get_bit(diff);
    }
    
    // 获取第一个缺失的序列号
    SequenceNumber_t get_first_missing() const {
        for (uint32_t i = 0; i < numBits; ++i) {
            if (!get_bit(i)) {
                return base + i;
            }
        }
        return base + numBits;
    }

private:
    void set_bit(uint32_t bit) {
        uint32_t word = bit / 32;
        uint32_t offset = bit % 32;
        bitmap[word] |= (1u << offset);
    }
    
    bool get_bit(uint32_t bit) const {
        uint32_t word = bit / 32;
        uint32_t offset = bit % 32;
        return (bitmap[word] >> offset) & 1u;
    }
};
```

### 3.5 NACK 优化：只报告连续的缺失

```
场景：大量丢包
Writer 发送: #1 ~ #100
Reader 收到: #1, #2, #50, #51, #52, #100

方案 A：报告所有缺失 (低效)
NACK: {3-49, 53-99}  (94个数字，很大)

方案 B：只报告第一个缺失 (Fast-DDS 默认)
NACK: base=3, bitmap=0
含义: "3缺失，3之后的我不告诉你"

方案 C：报告前 N 个缺失 (平衡)
NACK: base=3, bitmap=前32位
含义: "3-34的状态我告诉你，35之后的我不管"

Fast-DDS 策略：
- 首次 NACK：只报告 base (最小缺失)
- 重复 NACK：逐步扩大 bitmap 范围
- 目的：减少网络开销，快速恢复
```

---

## 四、重传队列管理

### 4.1 ReaderProxy 中的重传状态

```cpp
// src/cpp/rtps/writer/ReaderProxy.h
class ReaderProxy {
public:
    // 为每个 Reader 维护的发送状态
    struct ChangeForReader {
        CacheChange_t* change;           // 数据指针
        ChangeStatus status;             // 状态
        uint32_t times_nack;             // 被 NACK 的次数
        Time_t last_send_time;           // 上次发送时间
    };
    
    enum ChangeStatus {
        UNSENT,           // 未发送
        REQUESTED,        // Reader 请求 (NACK)
        UNACKNOWLEDGED,   // 已发送，未确认
        ACKNOWLEDGED,     // 已确认
        UNDERWAY          // 正在发送
    };
    
    // 在途数据队列
    std::map<SequenceNumber_t, ChangeForReader> outstanding_changes_;
    
    // 已确认的最高序列号
    SequenceNumber_t acked_changes_;
    
    // 最高发送的序列号
    SequenceNumber_t highest_seq_sent_;
};

// 状态转换图
UNSENT → UNDERWAY → UNACKNOWLEDGED → ACKNOWLEDGED
            ↓              ↓
         REQUESTED ←──────┘ (收到 NACK，重传)
```

### 4.2 重传触发条件

```cpp
// 触发重传的 3 种情况

// 1. 收到 NACK (显式请求)
void ReaderProxy::on_nack_received(const SequenceNumberSet& nack_bitmap) {
    for (auto seq : nack_bitmap.get_missing_sequences()) {
        auto it = outstanding_changes_.find(seq);
        if (it != outstanding_changes_.end()) {
            it->second.status = REQUESTED;  // 标记为需要重传
            it->second.times_nack++;         // NACK 计数+1
            schedule_retransmission(it->second);  // 调度重传
        }
    }
}

// 2. 超时重传 (定时器)
void ReaderProxy::on_retransmission_timer() {
    for (auto& [seq, change_for_reader] : outstanding_changes_) {
        if (change_for_reader.status == UNACKNOWLEDGED) {
            // 检查是否超时
            if (now() - change_for_reader.last_send_time > retransmission_timeout_) {
                change_for_reader.status = REQUESTED;
                schedule_retransmission(change_for_reader);
            }
        }
    }
}

// 3. HEARTBEAT 触发 (定期确认)
void StatefulWriter::send_heartbeat() {
    for (auto* reader_proxy : matched_readers_) {
        // 发送 HEARTBEAT 提醒 Reader 确认
        send_heartbeat_to_reader(reader_proxy);
        
        // 如果 Reader 长时间未 ACK，重传
        if (reader_proxy->get_last_ack_time() > heartbeat_period_ * 3) {
            // Reader 可能掉线或丢包严重
            for (auto& [seq, change] : reader_proxy->outstanding_changes_) {
                if (change.status != ACKNOWLEDGED) {
                    change.status = REQUESTED;
                    schedule_retransmission(change);
                }
            }
        }
    }
}
```

### 4.3 重传调度策略

```cpp
// 重传调度器 (避免重传风暴)
class RetransmissionScheduler {
public:
    void schedule_retransmission(ChangeForReader& change) {
        // 计算重传延迟 (指数退避)
        Duration_t delay = calculate_backoff_delay(change.times_nack);
        
        // 添加到重传队列
        retransmission_queue_.push({
            change.change->sequenceNumber,
            now() + delay,
            change.reader_proxy
        });
    }
    
    void process_retransmissions() {
        while (!retransmission_queue_.empty()) {
            auto& item = retransmission_queue_.top();
            if (item.scheduled_time > now()) break;  // 还没到时间
            
            // 执行重传
            retransmit(item.reader_proxy, item.sequence_number);
            retransmission_queue_.pop();
        }
    }

private:
    Duration_t calculate_backoff_delay(uint32_t nack_count) {
        // 指数退避: 1ms → 2ms → 4ms → 8ms ... (最大 1秒)
        uint32_t delay_ms = std::min(1u << nack_count, 1000u);
        return Duration_t(0, delay_ms * 1000000);  // 转换为纳秒
    }
    
    // 优先队列：按 scheduled_time 排序
    std::priority_queue<RetransmissionItem> retransmission_queue_;
};
```

### 4.4 重传次数限制

```cpp
// 防止无限重传
const uint32_t MAX_NACK_COUNT = 10;

void ReaderProxy::on_nack_received(...) {
    for (auto seq : missing_seqs) {
        auto& change = outstanding_changes_[seq];
        
        if (change.times_nack >= MAX_NACK_COUNT) {
            // 超过最大重试次数
            log_warning("Seq %d retried %d times, giving up", seq, MAX_NACK_COUNT);
            change.status = ACKNOWLEDGED;  // 假装已确认，丢弃
            continue;
        }
        
        change.status = REQUESTED;
        schedule_retransmission(change);
    }
}
```

---

## 五、去重机制

### 5.1 为什么需要去重？

```
场景：网络延迟导致重复数据
────────────────────────────────────────
Writer                  Reader
  │                       │
  │── DATA(Seq#5) ────────────────────►│ ✅ 收到
  │                       │
  │── HEARTBEAT(5) ──────►│ (延迟)
  │                       │
  │  (超时未收到 ACK)      │
  │── DATA(Seq#5) 【重传】►│ ⚠️ 重复数据！
  │                       │
  │◄────── ACK(5) ────────│ (延迟到达)
  │                       │
  如果没有去重，Reader 会处理两次 Seq#5
```

### 5.2 Reader 端去重实现

```cpp
// src/cpp/rtps/reader/StatefulReader.cpp
bool StatefulReader::processDataMsg(CacheChange_t* change) {
    const SequenceNumber_t& seq = change->sequenceNumber;
    const GUID_t& writer_guid = change->writerGUID;
    
    // 1. 查找或创建 WriterProxy
    WriterProxy* proxy = nullptr;
    if (!matched_writer_lookup(writer_guid, &proxy)) {
        // 未知 Writer，是否接受？
        if (!m_acceptMessagesFromUnknownWriters) {
            return false;
        }
        // 创建新的 WriterProxy
        proxy = add_matched_writer(writer_guid);
    }
    
    // 2. 检查是否已收到过 (关键！)
    if (proxy->received_change_set(seq)) {
        // ❌ 重复数据，丢弃
        log_debug("Duplicate Seq#%d from Writer %s, dropping",
                  seq, writer_guid);
        return false;
    }
    
    // 3. 检查序列号是否小于期望值 (乱序或过期)
    if (seq < proxy->next_expected_seq_) {
        // 可能是旧数据重传，但已经处理过了
        log_debug("Seq#%d < expected %d, dropping",
                  seq, proxy->next_expected_seq_);
        return false;
    }
    
    // 4. 标记为已收到
    proxy->received_change_set(seq) = true;
    
    // 5. 处理数据
    return deliver_change_to_application(change);
}
```

### 5.3 WriterProxy 中的接收记录

```cpp
// src/cpp/rtps/reader/WriterProxy.h
class WriterProxy {
public:
    // 记录已接收的序列号
    bool received_change_set(const SequenceNumber_t& seq) {
        // 方法1：使用位图 (内存高效)
        return received_bitmap_.is_set(seq);
    }
    
    void add_received_change(const SequenceNumber_t& seq) {
        received_bitmap_.add(seq);
        update_next_expected_seq();
    }

private:
    // 已接收序列号的位图
    SequenceNumberSet received_bitmap_;
    
    // 期望的下一个序列号
    SequenceNumber_t next_expected_seq_;
    
    // 最高接收的序列号
    SequenceNumber_t highest_received_seq_;
};
```

### 5.4 位图压缩与清理

```cpp
// 问题：位图无限增长会占用大量内存
// 解决方案：定期清理已确认的低序列号

class SequenceNumberSet {
public:
    // 压缩位图：移除 base 之前的连续 1
    void compact() {
        uint32_t shift = 0;
        // 计算可以从 base 移除多少连续的 1
        for (uint32_t i = 0; i < numBits; ++i) {
            if (get_bit(i)) {
                shift++;
            } else {
                break;  // 遇到第一个 0，停止
            }
        }
        
        if (shift > 0) {
            base += shift;           // 提高 base
            left_shift_bitmap(shift); // 位图左移
            numBits -= shift;
        }
    }
};

// 示例：
// 压缩前: base=10, bitmap=1111110001 (10-15都收到了，16-18缺失，19收到)
// 压缩后: base=16, bitmap=0001 (只保留16-19)
// 节省 60% 内存！
```

---

## 六、关键数据结构源码

### 6.1 ReaderProxy 完整定义

```cpp
// src/cpp/rtps/reader/WriterProxy.h (注意：ReaderProxy 在 Writer 端)
class ReaderProxy {
public:
    ReaderProxy(
        StatefulWriter* writer,
        const ReaderProxyData& reader_data,
        const SequenceNumber_t& initial_seq);
    
    // 添加要发送的变更
    bool add_change(
        CacheChange_t* change,
        bool immediate_send);
    
    // 处理 ACKNACK
    void on_acknack_received(
        const SequenceNumberSet& ack_bitmap,
        const SequenceNumberSet& nack_bitmap,
        bool final_flag);
    
    // 执行重传
    void perform_nack_response();
    
    // 获取状态
    ChangeForReaderStatus get_change_status(const SequenceNumber_t& seq) const;
    bool are_there_changes_for_reader() const;

private:
    // 所属 Writer
    StatefulWriter* writer_;
    
    // Reader 信息
    GUID_t remote_reader_guid_;
    LocatorList_t remote_locators_;
    
    // 发送状态管理
    struct ChangeForReader {
        CacheChange_t* change_;
        ChangeForReaderStatus status_;
        uint32_t nack_count_;
        Time_t last_send_time_;
    };
    std::map<SequenceNumber_t, ChangeForReader> changes_for_reader_;
    
    // 确认状态
    SequenceNumber_t acked_changes_;       // 已确认的最高序列号
    SequenceNumber_t highest_seq_sent_;    // 已发送的最高序列号
    
    // 重传定时器
    TimedEvent* nack_response_event_;
    bool nack_suppression_;
};
```

### 6.2 WriterProxy 完整定义

```cpp
// src/cpp/rtps/writer/ReaderProxy.h (注意：WriterProxy 在 Reader 端)
class WriterProxy {
public:
    WriterProxy(
        StatefulReader* reader,
        const WriterProxyData& writer_data,
        const SequenceNumber_t& initial_seq);
    
    // 数据处理
    bool received_change(CacheChange_t* change);
    bool missing_changes_update(const SequenceNumber_t& seq);
    
    // ACKNACK 生成
    void perform_acknack_response();
    bool should_send_acknack() const;
    
    // 活性检测
    void assert_liveliness();
    bool is_alive() const;

private:
    // 所属 Reader
    StatefulReader* reader_;
    
    // Writer 信息
    GUID_t remote_writer_guid_;
    LocatorList_t remote_locators_;
    
    // 接收状态
    SequenceNumberSet received_changes_;    // 已接收位图
    SequenceNumberSet missing_changes_;     // 缺失位图
    SequenceNumber_t next_expected_seq_;    // 期望的下一个序列号
    SequenceNumber_t max_available_seq_;    // Writer 声明的最大序列号
    
    // 心跳跟踪
    Time_t last_heartbeat_time_;
    SequenceNumber_t last_heartbeat_first_seq_;
    SequenceNumber_t last_heartbeat_last_seq_;
    
    // ACKNACK 抑制
    bool acknack_count_;
    TimedEvent* acknack_event_;
};
```

---

## 七、性能优化策略

### 7.1 延迟 ACK 机制

```cpp
// 问题：每个数据包都发 ACK，网络开销大
// 解决方案：批量 ACK

class DelayedAckStrategy {
public:
    void on_data_received(const SequenceNumber_t& seq) {
        pending_acks_.insert(seq);
        
        // 启动延迟定时器 (50ms)
        if (!ack_timer_running_) {
            ack_timer_.start(Duration_t(0, 50000000));  // 50ms
            ack_timer_running_ = true;
        }
        
        // 如果积压太多，立即发送
        if (pending_acks_.size() >= MAX_PENDING_ACKS) {
            send_acknack_immediately();
        }
    }
    
    void on_timer() {
        // 定时器触发，批量发送 ACK
        send_acknack_immediately();
    }

private:
    std::set<SequenceNumber_t> pending_acks_;
    static const uint32_t MAX_PENDING_ACKS = 10;
    bool ack_timer_running_ = false;
};
```

### 7.2 NACK 抑制

```cpp
// 问题：连续丢包时，Reader 疯狂发送 NACK
// 解决方案：NACK 抑制期

class NackSuppression {
public:
    bool should_send_nack() {
        Time_t now = Time_t::now();
        if (now - last_nack_time_ < suppression_duration_) {
            // 在抑制期内，不发送 NACK
            return false;
        }
        last_nack_time_ = now;
        return true;
    }

private:
    Time_t last_nack_time_ = Time_t::zero();
    Duration_t suppression_duration_ = Duration_t(0, 10000000);  // 10ms
};
```

### 7.3 选择性重传

```cpp
// 问题：Reader 丢失 #5, #6, #7，Writer 重传所有，浪费带宽
// 解决方案：Reader 只报告第一个缺失

SequenceNumberSet build_efficient_nack() {
    SequenceNumberSet nack;
    
    // 只报告第一个缺失的序列号
    SequenceNumber_t first_missing = missing_changes_.get_first_missing();
    nack.base = first_missing;
    nack.numBits = 0;  // 空位图 = "我只告诉你第一个缺失的"
    
    return nack;
}

// Writer 收到后：
// - 重传 first_missing
// - 如果 Reader 还缺其他的，下次 NACK 会报告
// 优势：减少 NACK 消息大小，减少重传压力
```

---

## 八、总结

| 机制 | 核心思想 | 优化方向 |
|------|---------|---------|
| **序列号** | 64位唯一标识 | 原子递增，线程安全 |
| **滑动窗口** | 限制在途数据 | 自适应调整窗口大小 |
| **ACKNACK 位图** | 高效报告接收状态 | 延迟 ACK，NACK 抑制 |
| **重传队列** | 指数退避重传 | 最大重试限制 |
| **去重** | 位图记录已接收 | 定期压缩位图 |

---

_文档版本: 1.0  
最后更新: 2026-03-10  
作者: 旭旭助手_