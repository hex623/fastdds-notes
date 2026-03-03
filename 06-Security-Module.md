# Fast-DDS 安全模块 (Security) 分析

## 目录
1. [DDS-Security 规范概述](#1-dds-security-规范概述)
2. [Authentication (认证)](#2-authentication-认证)
3. [Access Control (访问控制)](#3-access-control-访问控制)
4. [Cryptographic (加密)](#4-cryptographic-加密)
5. [Logging (日志审计)](#5-logging-日志审计)
6. [代码示例：配置安全通信](#6-代码示例配置安全通信)

---

## 1. DDS-Security 规范概述

DDS-Security 是 OMG 针对 DDS 标准制定的安全规范，旨在为 DDS 系统提供端到端的安全保护。Fast-DDS 完整实现了 DDS-Security 1.1 规范，提供了五个核心安全插件模块：

| 模块 | 功能 | 关键文件 |
|------|------|----------|
| **Authentication** | 身份验证与密钥交换 | `authentication/PKIDH.h/cpp` |
| **Access Control** | 访问权限控制 | `accesscontrol/Permissions.h/cpp` |
| **Cryptography** | 数据加密与完整性 | `cryptography/AESGCMGMAC.h/cpp` |
| **Logging** | 安全事件日志审计 | `logging/LogTopic.h/cpp` |
| **PKI Provider** | 证书文件提供 | `artifact_providers/FileProvider.cpp` |

### 1.1 安全架构设计

Fast-DDS 安全模块采用插件化架构设计：

```
┌─────────────────────────────────────────────────────────┐
│                    RTPS 参与者层                          │
└─────────────────────────────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│Authentication│  │Access Control│  │Cryptography  │
│   (PKIDH)    │  │ (Permissions)│  │(AESGCMGMAC) │
└──────────────┘  └──────────────┘  └──────────────┘
        │                  │                  │
        └──────────────────┼──────────────────┘
                           ▼
              ┌──────────────────────┐
              │   OpenSSL Provider   │
              │  (PKI/HMAC/AES/GCM)  │
              └──────────────────────┘
```

### 1.2 安全通信流程

1. **身份验证阶段**：通过数字证书交换验证参与者身份
2. **密钥协商阶段**：使用 DH 或 ECDH 算法生成共享密钥
3. **权限检查阶段**：验证参与者的访问权限
4. **安全通信阶段**：使用对称加密算法保护数据传输

---

## 2. Authentication (认证)

### 2.1 PKI 基础设施

Fast-DDS 使用公钥基础设施 (PKI) 进行身份验证，支持 X.509 数字证书：

```cpp
// src/cpp/security/authentication/PKIDH.h
class PKIDH : public Authentication
{
public:
    // 验证本地身份
    ValidationResult_t validate_local_identity(
        IdentityHandle** local_identity_handle,
        GUID_t& adjusted_participant_key,
        const uint32_t domain_id,
        const RTPSParticipantAttributes& participant_attr,
        const GUID_t& candidate_participant_key,
        SecurityException& exception) override;

    // 验证远端身份
    ValidationResult_t validate_remote_identity(
        IdentityHandle** remote_identity_handle,
        const IdentityHandle& local_identity_handle,
        const IdentityToken& remote_identity_token,
        const GUID_t& remote_participant_key,
        SecurityException& exception) override;

    // 握手请求发起
    ValidationResult_t begin_handshake_request(
        HandshakeHandle** handshake_handle,
        HandshakeMessageToken** handshake_message,
        const IdentityHandle& initiator_identity_handle,
        IdentityHandle& replier_identity_handle,
        const CDRMessage_t& cdr_participant_data,
        SecurityException& exception) override;
};
```

### 2.2 证书交换流程

握手过程遵循 DDS-Security 规范，分为四个步骤：

```
参与者A                         参与者B
   │                               │
   │─── Handshake Request Token ──▶│
   │                               │
   │◀── Handshake Reply Token ─────│
   │                               │
   │─── Final Token ──────────────▶│
   │                               │
```

**关键配置属性：**

| 属性名 | 说明 | 示例值 |
|--------|------|--------|
| `dds.sec.auth.builtin.PKI-DH.identity_ca` | 身份CA证书路径 | `file://certs/identity_ca.pem` |
| `dds.sec.auth.builtin.PKI-DH.identity_certificate` | 身份证书路径 | `file://certs/participant.crt` |
| `dds.sec.auth.builtin.PKI-DH.identity_crl` | 证书吊销列表 | `file://certs/crl.pem` |
| `dds.sec.auth.builtin.PKI-DH.private_key` | 私钥文件路径 | `file://certs/private.pem` |
| `dds.sec.auth.builtin.PKI-DH.password` | 私钥密码 | `passphrase` |

### 2.3 支持的签名算法

```cpp
// 从 PKIDH.cpp 中提取的签名算法支持
static bool get_signature_algorithm(X509* certificate, std::string& signature_algorithm, ...)
{
    if (strncmp(ptr->data, "ecdsa-with-SHA256", ptr->length) == 0) {
        signature_algorithm = ECDSA_SHA256;
        returnedValue = true;
    }
    else if (strncmp(ptr->data, "sha256WithRSAEncryption", ptr->length) == 0) {
        signature_algorithm = RSA_SHA256;
        returnedValue = true;
    }
    else if (strncmp(ptr->data, "sha1WithRSAEncryption", ptr->length) == 0) {
        signature_algorithm = RSA_SHA256;
        returnedValue = true;
    }
}
```

---

## 3. Access Control (访问控制)

### 3.1 Governance 文件

Governance 文件定义了域级别的安全策略，控制发现、认证和数据保护：

```xml
<!-- Governance 示例 -->
<dds xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <domain_access_rules>
    <domain_rule>
      <domains>
        <id_range>
          <min>0</min>
          <max>10</max>
        </id_range>
      </domains>
      <!-- 是否允许未认证参与者 -->
      <allow_unauthenticated_participants>false</allow_unauthenticated_participants>
      <!-- 是否启用加入访问控制 -->
      <enable_join_access_control>true</enable_join_access_control>
      <!-- 发现保护级别 -->
      <discovery_protection_kind>ENCRYPT</discovery_protection_kind>
      <!-- 活性保护级别 -->
      <liveliness_protection_kind>SIGN</liveliness_protection_kind>
      <!-- RTPS 消息保护级别 -->
      <rtps_protection_kind>ENCRYPT</rtps_protection_kind>
      
      <topic_access_rules>
        <topic_rule>
          <topic_expression>Square*</topic_expression>
          <enable_discovery_protection>true</enable_discovery_protection>
          <enable_liveliness_protection>false</enable_liveliness_protection>
          <enable_read_access_control>true</enable_read_access_control>
          <enable_write_access_control>true</enable_write_access_control>
          <metadata_protection_kind>ENCRYPT</metadata_protection_kind>
          <data_protection_kind>ENCRYPT</data_protection_kind>
        </topic_rule>
      </topic_access_rules>
    </domain_rule>
  </domain_access_rules>
</dds>
```

### 3.2 ProtectionKind 枚举

```cpp
// src/cpp/security/accesscontrol/GovernanceParser.h
enum class ProtectionKind
{
    NONE,                               // 无保护
    SIGN,                               // 仅签名
    ENCRYPT,                            // 加密
    SIGN_WITH_ORIGIN_AUTHENTICATION,    // 签名+源认证
    ENCRYPT_WITH_ORIGIN_AUTHENTICATION  // 加密+源认证
};
```

### 3.3 Permissions 文件

Permissions 文件定义了具体参与者的访问权限：

```xml
<!-- Permissions 示例 -->
<dds xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <permissions>
    <grant name="PublisherPermissions">
      <!-- 主体名称，对应证书中的DN -->
      <subject_name>CN=Publisher,O=eProsima,C=ES</subject_name>
      
      <!-- 权限有效期 -->
      <validity>
        <not_before>2024-01-01T00:00:00</not_before>
        <not_after>2025-01-01T00:00:00</not_after>
      </validity>
      
      <!-- 允许规则 -->
      <allow_rule>
        <domains>
          <id>0</id>
        </domains>
        <publish>
          <topics>
            <topic>Square</topic>
          </topics>
        </publish>
        <subscribe>
          <topics>
            <topic>Circle</topic>
          </topics>
        </subscribe>
      </allow_rule>
      
      <!-- 默认规则 -->
      <default>DENY</default>
    </grant>
  </permissions>
</dds>
```

### 3.4 权限检查接口

```cpp
// src/cpp/security/accesscontrol/Permissions.h
class Permissions : public AccessControl
{
public:
    // 验证本地权限
    PermissionsHandle* validate_local_permissions(
        Authentication& auth_plugin,
        const IdentityHandle& identity,
        const uint32_t domain_id,
        const RTPSParticipantAttributes& participant_attr,
        SecurityException& exception) override;

    // 检查创建参与者权限
    bool check_create_participant(
        const PermissionsHandle& local_handle,
        const uint32_t domain_id,
        const RTPSParticipantAttributes& qos,
        SecurityException& exception) override;

    // 检查创建 DataWriter 权限
    bool check_create_datawriter(
        const PermissionsHandle& local_handle,
        const uint32_t domain_id,
        const std::string& topic_name,
        const std::vector<std::string>& partitions,
        SecurityException& exception) override;

    // 检查创建 DataReader 权限
    bool check_create_datareader(
        const PermissionsHandle& local_handle,
        const uint32_t domain_id,
        const std::string& topic_name,
        const std::vector<std::string>& partitions,
        SecurityException& exception) override;
};
```

---

## 4. Cryptographic (加密)

### 4.1 AES-GCM-GMAC 加密插件

Fast-DDS 使用 AES-GCM-GMAC 算法实现加密和完整性保护：

```cpp
// src/cpp/security/cryptography/AESGCMGMAC.h
class AESGCMGMAC : public Cryptography
{
    CryptoKeyExchange* m_cryptokeyexchange;      // 密钥交换
    std::shared_ptr<AESGCMGMAC_KeyFactory> m_cryptokeyfactory;  // 密钥工厂
    CryptoTransform* m_cryptotransform;          // 数据转换(加解密)

public:
    AESGCMGMAC_KeyExchange* keyexchange();
    std::shared_ptr<AESGCMGMAC_KeyFactory> keyfactory();
    AESGCMGMAC_Transform* transform();
};
```

### 4.2 密钥派生机制

```cpp
// src/cpp/security/cryptography/AESGCMGMAC_KeyFactory.cpp
static bool create_kx_key(
    std::array<uint8_t, 32>& out_data,
    const std::vector<uint8_t>* first_data,
    const char* cookie,
    const std::vector<uint8_t>* second_data,
    const std::vector<uint8_t>* shared_secret)
{
    uint8_t tmp_data[32 + 16 + 32];
    uint8_t sha256[32];
    
    // 组合密钥材料
    memcpy(tmp_data, first_data->data(), 32);
    memcpy(&tmp_data[32], cookie, 16);
    memcpy(&tmp_data[32 + 16], second_data->data(), 32);
    
    // SHA256 哈希
    EVP_Digest(tmp_data, 32 + 16 + 32, sha256, nullptr, EVP_sha256(), nullptr);
    
    // HMAC-SHA256 派生最终密钥
    EVP_PKEY* key = EVP_PKEY_new_mac_key(EVP_PKEY_HMAC, nullptr, sha256, 32);
    // ... HMAC 计算
}
```

### 4.3 数据加解密流程

```cpp
// src/cpp/security/cryptography/AESGCMGMAC_Transform.cpp
bool AESGCMGMAC_Transform::encode_serialized_payload(
    SerializedPayload_t& output_payload,
    std::vector<uint8_t>& /*extra_inline_qos*/,
    const SerializedPayload_t& payload,
    DatawriterCryptoHandle& sending_datawriter_crypto,
    SecurityException& /*exception*/)
{
    // 获取 Writer 的加密句柄
    AESGCMGMAC_WriterCryptoHandle& local_writer = 
        AESGCMGMAC_WriterCryptoHandle::narrow(sending_datawriter_crypto);
    
    // 使用 OpenSSL EVP API 进行 AES-GCM 加密
    // IV 后缀长度为 8 字节
    constexpr int initialization_vector_suffix_length = 8;
    
    // 加密数据...
}
```

### 4.4 加密参数配置

| 参数 | 说明 | 典型值 |
|------|------|--------|
| 加密算法 | AES 模式 | AES-128-GCM / AES-256-GCM |
| 密钥长度 | 主密钥长度 | 128/256 位 |
| IV 长度 | 初始化向量 | 96 位 (12 字节) |
| Tag 长度 | GCM 认证标签 | 128 位 (16 字节) |

---

## 5. Logging (日志审计)

### 5.1 安全日志系统

Fast-DDS 提供内置的安全日志审计功能，记录安全相关事件：

```cpp
// src/cpp/security/logging/LogTopic.h
class LogTopic final : public Logging
{
public:
    LogTopic(uint32_t thread_id = 0, 
             const fastdds::rtps::ThreadSettings& thr_config = {});
    ~LogTopic();

private:
    void log_impl(const BuiltinLoggingType& message,
                  SecurityException& exception) const override;
    
    bool enable_logging_impl(SecurityException& exception) override;
    
    void publish(BuiltinLoggingType& builtin_msg);

    std::ofstream file_stream_;                           // 日志文件流
    mutable ConcurrentQueue<BuiltinLoggingTypePtr> queue_; // 并发队列
    std::atomic_bool stop_;                               // 停止标志
    eprosima::thread thread_;                             // 日志线程
};
```

### 5.2 日志事件类型

| 类别 | 事件 | 说明 |
|------|------|------|
| **认证** | IDENTITY_ESTABLISHED | 身份验证成功 |
| **认证** | AUTHENTICATION_FAILURE | 身份验证失败 |
| **访问控制** | PERMISSIONS_GRANTED | 权限授予 |
| **访问控制** | PERMISSIONS_DENIED | 权限拒绝 |
| **加密** | CRYPTOGRAPHIC_OPERATION | 加密操作 |
| **系统** | PARTICIPANT_STATE_CHANGE | 参与者状态变化 |

### 5.3 日志配置

```cpp
// 启用安全日志的属性配置
PropertyPolicy security_properties;
security_properties.properties().emplace_back(
    "dds.sec.log.class",
    "LogTopic"  // 或 "BuiltinLogging"
);
security_properties.properties().emplace_back(
    "dds.sec.log.builtin.LogTopic.logging_level",
    "4"  // 日志级别: 0=ERROR, 1=WARNING, 2=INFO, 3=DEBUG, 4=TRACE
);
security_properties.properties().emplace_back(
    "dds.sec.log.builtin.LogTopic.log_file",
    "security_logs.txt"
);
```

---

## 6. 代码示例：配置安全通信

### 6.1 完整安全配置示例

```cpp
#include <fastdds/dds/domain/DomainParticipantFactory.hpp>
#include <fastdds/rtps/attributes/PropertyPolicy.hpp>

using namespace eprosima::fastdds::dds;
using namespace eprosima::fastdds::rtps;

// 创建安全参与者
DomainParticipant* create_secure_participant(
    const std::string& participant_name,
    uint32_t domain_id)
{
    DomainParticipantQos participant_qos;
    
    // 设置参与者名称
    participant_qos.name(participant_name);
    
    // ====== 认证配置 ======
    // 身份CA证书
    participant_qos.properties().properties().emplace_back(
        "dds.sec.auth.builtin.PKI-DH.identity_ca",
        "file://certs/identity_ca.pem");
    
    // 身份证书
    participant_qos.properties().properties().emplace_back(
        "dds.sec.auth.builtin.PKI-DH.identity_certificate",
        "file://certs/" + participant_name + ".crt");
    
    // 私钥
    participant_qos.properties().properties().emplace_back(
        "dds.sec.auth.builtin.PKI-DH.private_key",
        "file://certs/" + participant_name + ".key");
    
    // 密码（如果私钥加密）
    participant_qos.properties().properties().emplace_back(
        "dds.sec.auth.builtin.PKI-DH.password",
        "secret_password");
    
    // ====== 访问控制配置 ======
    // Governance 文件
    participant_qos.properties().properties().emplace_back(
        "dds.sec.access.builtin.Access-Permissions.governance",
        "file://certs/governance.xml");
    
    // Permissions 文件
    participant_qos.properties().properties().emplace_back(
        "dds.sec.access.builtin.Access-Permissions.permissions",
        "file://certs/permissions.xml");
    
    // Permissions CA
    participant_qos.properties().properties().emplace_back(
        "dds.sec.access.builtin.Access-Permissions.permissions_ca",
        "file://certs/permissions_ca.pem");
    
    // ====== 加密配置 ======
    // 启用 AES-GCM-GMAC 加密
    participant_qos.properties().properties().emplace_back(
        "dds.sec.crypto.plugin",
        "builtin.AES-GCM-GMAC");
    
    // ====== 日志配置 ======
    participant_qos.properties().properties().emplace_back(
        "dds.sec.log.plugin",
        "builtin.LogTopic");
    participant_qos.properties().properties().emplace_back(
        "dds.sec.log.builtin.LogTopic.logging_level",
        "2");  // INFO级别
    
    // 创建域参与者
    return DomainParticipantFactory::get_instance()->
        create_participant(domain_id, participant_qos);
}
```

### 6.2 XML 配置文件示例

```xml
<!-- 参与者配置 XML -->
<dds xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <profiles>
    <participant profile_name="SecureParticipant">
      <rtps>
        <propertiesPolicy>
          <properties>
            <!-- 认证插件 -->
            <property>
              <name>dds.sec.auth.plugin</name>
              <value>builtin.PKI-DH</value>
            </property>
            <property>
              <name>dds.sec.auth.builtin.PKI-DH.identity_ca</name>
              <value>file://certs/identity_ca.pem</value>
            </property>
            <property>
              <name>dds.sec.auth.builtin.PKI-DH.identity_certificate</name>
              <value>file://certs/participant.crt</value>
            </property>
            <property>
              <name>dds.sec.auth.builtin.PKI-DH.private_key</name>
              <value>file://certs/participant.key</value>
            </property>
            
            <!-- 访问控制插件 -->
            <property>
              <name>dds.sec.access.plugin</name>
              <value>builtin.Access-Permissions</value>
            </property>
            <property>
              <name>dds.sec.access.builtin.Access-Permissions.governance</name>
              <value>file://certs/governance.xml</value>
            </property>
            <property>
              <name>dds.sec.access.builtin.Access-Permissions.permissions</name>
              <value>file://certs/permissions.xml</value>
            </property>
            <property>
              <name>dds.sec.access.builtin.Access-Permissions.permissions_ca</name>
              <value>file://certs/permissions_ca.pem</value>
            </property>
            
            <!-- 加密插件 -->
            <property>
              <name>dds.sec.crypto.plugin</name>
              <value>builtin.AES-GCM-GMAC</value>
            </property>
          </properties>
        </propertiesPolicy>
      </rtps>
    </participant>
  </profiles>
</dds>
```

### 6.3 证书生成脚本示例

```bash
#!/bin/bash
# generate_certs.sh - 证书生成脚本

CERTS_DIR="./certs"
mkdir -p $CERTS_DIR

# 1. 生成根CA私钥和证书
openssl genrsa -out $CERTS_DIR/ca.key 2048
openssl req -new -x509 -days 3650 -key $CERTS_DIR/ca.key \
    -out $CERTS_DIR/identity_ca.pem \
    -subj "/C=CN/O=MyCompany/CN=RootCA"

# 2. 生成参与者私钥
openssl genrsa -out $CERTS_DIR/participant.key 2048

# 3. 生成证书请求
openssl req -new -key $CERTS_DIR/participant.key \
    -out $CERTS_DIR/participant.csr \
    -subj "/C=CN/O=MyCompany/CN=Participant001"

# 4. 使用CA签发证书
openssl x509 -req -in $CERTS_DIR/participant.csr \
    -CA $CERTS_DIR/identity_ca.pem \
    -CAkey $CERTS_DIR/ca.key \
    -CAcreateserial \
    -out $CERTS_DIR/participant.crt \
    -days 365

echo "证书生成完成！"
echo "文件位置: $CERTS_DIR/"
```

---

## 总结

Fast-DDS 的安全模块提供了完整的企业级安全解决方案：

1. **认证层**：基于 PKI 的数字证书机制，确保通信双方身份可信
2. **访问控制**：通过 Governance 和 Permissions 文件实现细粒度权限管理
3. **加密层**：使用 AES-GCM-GMAC 算法提供数据机密性和完整性保护
4. **审计层**：完善的日志系统记录所有安全事件，便于事后追溯

在实际部署中，需要特别注意：
- 证书的有效期管理和轮换机制
- Governance 和 Permissions 文件的访问控制
- 加密算法的性能开销与安全性平衡
- 安全日志的存储和保护

---

## 参考资源

- **源码目录**: `src/cpp/security/`
- **DDS-Security 规范**: [OMG DDS-Security](https://www.omg.org/spec/DDS-SECURITY/)
- **Fast-DDS 文档**: [Fast-DDS Security Documentation](https://fast-dds.docs.eprosima.com/en/latest/fastdds/security/security.html)
- **相关文件**:
  - `authentication/PKIDH.h/cpp` - 认证实现
  - `accesscontrol/Permissions.h/cpp` - 访问控制
  - `cryptography/AESGCMGMAC_*.h/cpp` - 加密实现
  - `logging/LogTopic.h/cpp` - 日志审计
