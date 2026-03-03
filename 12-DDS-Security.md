# 12 DDS-Security 安全模块

**记录时间**: 2026-03-03  
**学习时长**: 约 1.5 小时  
**前置知识**: 01-11 基础笔记

---

## 1. 为什么需要 DDS-Security？

### 默认 DDS 的安全问题

- ❌ **无身份验证**：任何人都能加入 Domain
- ❌ **无加密**：数据明文传输，可被窃听
- ❌ **无访问控制**：任何 Reader 都能订阅任何 Topic

### DDS-Security 提供

- ✅ **认证**（Authentication）：证明你是谁（PKI 证书）
- ✅ **访问控制**（Access Control）：谁能读/写哪个 Topic
- ✅ **加密**（Encryption）：数据传输加密（AES-GCM）

---

## 2. 安全架构（SPI 模型）

```
DDS-Security 插件架构（SPI = Security Plugin Interface）
══════════════════════════════════════════════════════════

应用层 (DataWriter/DataReader)
    ↓
RTPS 层
    ↓
安全插件层
    ├── Authentication Plugin    → 验证身份（证书）
    ├── Access Control Plugin    → 检查权限（XML 策略）
    └── Cryptography Plugin      → 加密/签名（AES-GCM）
    ↓
传输层 (UDP/TCP/SHM)
```

### 安全实体

| 组件 | 作用 | 文件格式 |
|------|------|---------|
| **Identity Certificate** | 证明身份 | X.509 PEM |
| **Private Key** | 签名/解密 | PEM |
| **Governance** | Domain 级安全策略 | XML（签名） |
| **Permissions** | Participant 级权限 | XML（签名） |

---

## 3. 认证（Authentication）

### PKI 证书体系

```
证书链：
┌─────────────────┐
│   Root CA       │  ← 根证书（自签名）
│   (根证书)       │
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌────────┐ ┌────────┐
│Sub CA 1│ │Sub CA 2│  ← 中间 CA（可选）
│(中间证书)│ │(中间证书)│
└───┬────┘ └────┬───┘
    │           │
    ▼           ▼
┌────────┐   ┌────────┐
│Participant│   │Participant│  ← 终端实体证书
│   A     │   │   B     │
└────────┘   └────────┘
```

### 证书生成实战

```bash
# 1. 创建根 CA
openssl req -x509 -newkey rsa:4096 -keyout root_key.pem \
    -out root_cert.pem -days 3650 -nodes \
    -subj "/C=CN/O=MyOrg/CN=RootCA"

# 2. 创建 Participant A 的证书请求
openssl req -newkey rsa:2048 -keyout participantA_key.pem \
    -out participantA_req.pem -nodes \
    -subj "/C=CN/O=MyOrg/CN=ParticipantA"

# 3. 用根 CA 签名
openssl x509 -req -in participantA_req.pem \
    -CA root_cert.pem -CAkey root_key.pem \
    -out participantA_cert.pem -days 365 -CAcreateserial

# 4. 合并为 Identity 文件（Fast-DDS 格式）
cat participantA_cert.pem participantA_key.pem > participantA_identity.pem
```

### 配置认证

```cpp
DomainParticipantQos qos;

// 设置身份凭证
qos.properties().properties().emplace_back(
    "dds.sec.auth.builtin.PKI-DH.identity_ca",
    "file://root_cert.pem");

qos.properties().properties().emplace_back(
    "dds.sec.auth.builtin.PKI-DH.identity_certificate",
    "file://participantA_identity.pem");

qos.properties().properties().emplace_back(
    "dds.sec.auth.builtin.PKI-DH.private_key",
    "file://participantA_key.pem");

// 启用安全
qos.properties().properties().emplace_back(
    "dds.sec.auth.plugin",
    "builtin.PKI-DH");
```

---

## 4. 访问控制（Access Control）

### Governance（Domain 级策略）

```xml
<!-- governance.xml -->
<?xml version="1.0" encoding="UTF-8"?>
<dds xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:noNamespaceSchemaLocation="http://www.omg.org/spec/DDS-Security/20170901/omg_shared_ca_domain_governance.xsd">
    
    <domain_access_rules>
        <domain_rule>
            <domain_ids>
                <id>0</id>
            </domain_ids>
            
            <allow_unauthenticated_participants>false</allow_unauthenticated_participants>
            <enable_join_access_control>true</enable_join_access_control>
            <discovery_protection_kind>ENCRYPT</discovery_protection_kind>
            <liveliness_protection_kind>SIGN</liveliness_protection_kind>
            
            <topic_access_rules>
                <!-- 规则1：敏感 Topic，必须加密 -->
                <topic_rule>
                    <topic_expression>FinancialData*</topic_expression>
                    <enable_discovery_protection>true</enable_discovery_protection>
                    <enable_read_access_control>true</enable_read_access_control>
                    <enable_write_access_control>true</enable_write_access_control>
                    <metadata_protection_kind>ENCRYPT</metadata_protection_kind>
                    <data_protection_kind>ENCRYPT</data_protection_kind>
                </topic_rule>
                
                <!-- 规则2：普通 Topic，只签名不加密 -->
                <topic_rule>
                    <topic_expression>PublicStatus</topic_expression>
                    <enable_discovery_protection>false</enable_discovery_protection>
                    <enable_read_access_control>false</enable_read_access_control>
                    <enable_write_access_control>false</enable_write_access_control>
                    <metadata_protection_kind>NONE</metadata_protection_kind>
                    <data_protection_kind>SIGN</data_protection_kind>
                </topic_rule>
                
                <!-- 规则3：默认规则 -->
                <topic_rule>
                    <topic_expression>*</topic_expression>
                    <enable_discovery_protection>false</enable_discovery_protection>
                    <enable_read_access_control>true</enable_read_access_control>
                    <enable_write_access_control>true</enable_write_access_control>
                    <metadata_protection_kind>NONE</metadata_protection_kind>
                    <data_protection_kind>NONE</data_protection_kind>
                </topic_rule>
            </topic_access_rules>
        </domain_rule>
    </domain_access_rules>
</dds>
```

### Permissions（Participant 级权限）

```xml
<!-- permissions_A.xml -->
<?xml version="1.0" encoding="UTF-8"?>
<dds xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:noNamespaceSchemaLocation="http://www.omg.org/spec/DDS-Security/20170901/omg_shared_ca_permissions.xsd">
    
    <permissions>
        <grant name="PublisherPermissions">
            <subject_name>CN=ParticipantA,O=MyOrg,C=CN</subject_name>
            
            <validity>
                <not_before>2026-03-01T00:00:00</not_before>
                <not_after>2027-03-01T00:00:00</not_after>
            </validity>
            
            <publish>
                <topics>
                    <topic>FinancialDataStock</topic>
                    <topic>PublicStatus</topic>
                </topics>
            </publish>
            
            <subscribe>
                <topics>
                    <topic>ControlCommands</topic>
                </topics>
            </subscribe>
            
            <deny_rule>
                <publish>
                    <topics>
                        <topic>AdminCommands</topic>
                    </topics>
                </publish>
            </deny_rule>
        </grant>
    </permissions>
</dds>
```

### 签名配置文件

```bash
# Governance 和 Permissions 必须签名才能生效！

# 1. 签名 Governance
openssl smime -sign -in governance.xml \
    -text -out governance.smime \
    -signer root_cert.pem \
    -inkey root_key.pem

# 2. 签名 Permissions
openssl smime -sign -in permissions_A.xml \
    -text -out permissions_A.smime \
    -signer root_cert.pem \
    -inkey root_key.pem
```

---

## 5. 完整安全配置

### Participant A（Publisher）

```cpp
DomainParticipantQos qos;

// ========== 认证配置 ==========
qos.properties().properties().emplace_back(
    "dds.sec.auth.plugin", "builtin.PKI-DH");
qos.properties().properties().emplace_back(
    "dds.sec.auth.builtin.PKI-DH.identity_ca", "file://root_cert.pem");
qos.properties().properties().emplace_back(
    "dds.sec.auth.builtin.PKI-DH.identity_certificate", 
    "file://participantA_identity.pem");
qos.properties().properties().emplace_back(
    "dds.sec.auth.builtin.PKI-DH.private_key", "file://participantA_key.pem");

// ========== 访问控制配置 ==========
qos.properties().properties().emplace_back(
    "dds.sec.access.plugin", "builtin.Access-Permissions");
qos.properties().properties().emplace_back(
    "dds.sec.access.builtin.Access-Permissions.permissions_ca", 
    "file://root_cert.pem");
qos.properties().properties().emplace_back(
    "dds.sec.access.builtin.Access-Permissions.governance", 
    "file://governance.smime");
qos.properties().properties().emplace_back(
    "dds.sec.access.builtin.Access-Permissions.permissions", 
    "file://permissions_A.smime");

// ========== 加密配置 ==========
qos.properties().properties().emplace_back(
    "dds.sec.crypto.plugin", "builtin.AES-GCM-GMAC");

DomainParticipant* participant = 
    DomainParticipantFactory::get_instance()->create_participant(0, qos);
```

---

## 6. 安全调试与故障排查

### 常见问题

#### 1. 认证失败

```
错误日志：
[SECURITY Error] Authentication failed: 
Certificate verification failed: unable to get local issuer certificate

排查：
- 检查证书链是否完整
- 检查证书有效期
- 检查 Identity CA 路径是否正确
```

#### 2. 访问控制拒绝

```
错误日志：
[SECURITY Error] Access control deny: 
Not allowed to publish topic 'FinancialDataStock'

排查：
- 检查 Permissions 文件是否包含该 Topic
- 检查 Permissions 文件是否已签名
- 检查 Governance 中的 Topic 匹配规则
```

#### 3. 性能问题

**安全开销**：
- 认证握手：首次连接增加 10-100ms
- 加密：CPU 开销增加 10-20%
- 数据包大小：增加 20-50%（MAC 和加密头）

**优化建议**：
```cpp
// 只对敏感数据加密
<data_protection_kind>ENCRYPT</data_protection_kind>  // 敏感 Topic
<data_protection_kind>NONE</data_protection_kind>      // 普通 Topic
```

---

## 7. 生产环境最佳实践

### 1. 证书管理

```bash
# 证书有效期不要太长
# 建议：1年，最长不超过3年

# 使用中间 CA 管理不同部门
# 撤销证书时更新 CRL（Certificate Revocation List）

# 证书文件权限
chmod 600 *_key.pem      # 私钥只有 owner 可读
chmod 644 *_cert.pem     # 公证书可读
```

### 2. 配置文件管理

```bash
# 目录结构
/etc/dds-security/
├── ca/
│   ├── root_cert.pem
│   └── root_key.pem（离线保存！）
├── participants/
│   ├── participantA/
│   │   ├── identity.pem
│   │   ├── permissions.smime
│   │   └── permissions.xml（源码，不部署）
│   └── participantB/
│       └── ...
└── governance/
    ├── governance.smime（部署）
    └── governance.xml（源码，版本控制）
```

### 3. 性能与安全的权衡

| 场景 | 推荐配置 | 说明 |
|------|---------|------|
| **内部局域网** | 只认证，不加密 | 信任网络，减少开销 |
| **跨网段/VPN** | 认证 + 加密 | 防止窃听 |
| **云端部署** | 认证 + 加密 + 签名 | 零信任网络 |
| **高吞吐场景** | 选择性加密 | 只对敏感 Topic 加密 |

---

## 8. 安全检查清单

部署 DDS-Security 前检查：

- [ ] 所有证书已生成且未过期
- [ ] Governance 和 Permissions 已签名
- [ ] 证书文件权限正确（私钥 600）
- [ ] 配置文件路径正确（绝对路径或 file://）
- [ ] Topic 名称在 Permissions 中正确匹配
- [ ] 测试非安全 Participant 无法连接
- [ ] 测试未授权 Topic 无法发布/订阅
- [ ] 性能测试通过（安全开销可接受）

---

## 参考链接

- [01 RTPS源码分析](./01-RTPS-Source-Analysis.md)
- [09 进阶主题](./09-Advanced-Topics.md)
- Fast-DDS 官方文档: https://fast-dds.docs.eprosima.com/
- DDS-Security 规范: https://www.omg.org/spec/DDS-SECURITY/
