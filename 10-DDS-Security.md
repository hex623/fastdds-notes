# 10 - DDS-Security

**来源**: 2026-03-03 笔记  
**整理时间**: 2026-03-17

---

## 安全架构

DDS-Security 提供三层保护：

```
┌─────────────────────────────────────┐
│  Authentication (身份认证)          │
│  - PKI 证书体系                     │
│  - 握手协议                         │
├─────────────────────────────────────┤
│  Access Control (访问控制)          │
│  - Governance 策略                  │
│  - Permissions 权限                 │
├─────────────────────────────────────┤
│  Cryptographic (加密传输)           │
│  - AES-GCM-GMAC                     │
│  - 数据加密/签名                    │
└─────────────────────────────────────┘
```

---

## PKI 证书体系

### 需要的证书文件

| 文件 | 用途 | 格式 |
|------|------|------|
| `identity_ca.pem` | 身份认证 CA | PEM |
| `identity_certificate.pem` | 节点身份证书 | PEM |
| `identity_key.pem` | 节点私钥 | PEM |
| `permissions_ca.pem` | 权限 CA | PEM |
| `permissions.xml` | 权限配置文件 | XML |
| `governance.xml` | 治理策略文件 | XML |

### 生成证书脚本
```bash
#!/bin/bash
# 1. 生成 CA 私钥和证书
openssl genrsa -out identity_ca_key.pem 2048
openssl req -x509 -new -key identity_ca_key.pem -out identity_ca.pem -days 3650

# 2. 生成节点私钥
openssl genrsa -out participant_key.pem 2048

# 3. 生成证书签名请求 (CSR)
openssl req -new -key participant_key.pem -out participant.csr

# 4. CA 签名生成证书
openssl x509 -req -in participant.csr -CA identity_ca.pem \
    -CAkey identity_ca_key.pem -out participant_cert.pem -days 365
```

---

## Governance 策略

Governance 定义全局安全策略。

### governance.xml 示例
```xml
<?xml version="1.0" encoding="UTF-8"?>
<ds_governance xmlns="http://www.omg.org/spec/DDS-Security/20170801">
    <domain_access_rules>
        <domain_rule>
            <domain_ids>
                <id>0</id>
            </domain_ids>
            <allow_unauthenticated_participants>false</allow_unauthenticated_participants>
            <enable_join_access_control>true</enable_join_access_control>
            <discovery_protection_kind>ENCRYPT</discovery_protection_kind>
            <liveliness_protection_kind>ENCRYPT</liveliness_protection_kind>
            </rtps_protection_kind>SIGN</rtps_protection_kind>
        </domain_rule>
    </domain_access_rules>
</ds_governance>
```

### 关键配置项

| 配置 | 说明 | 值 |
|------|------|-----|
| `allow_unauthenticated_participants` | 允许未认证节点 | false（推荐） |
| `enable_join_access_control` | 启用加入控制 | true |
| `discovery_protection_kind` | 发现协议保护 | ENCRYPT/SIGN/NONE |
| `liveliness_protection_kind` | 活性保护 | ENCRYPT/SIGN/NONE |
| `rtps_protection_kind` | RTPS 消息保护 | ENCRYPT/SIGN/NONE |

---

## Permissions 权限配置

Permissions 定义细粒度的 Topic 访问权限。

### permissions.xml 示例
```xml
<?xml version="1.0" encoding="UTF-8"?>
<ds_permissions xmlns="http://www.omg.org/spec/DDS-Security/20170801">
    <grant name="PublisherPermissions">
        <subject_name>CN=Publisher,O=MyOrg,C=US</subject_name>
        <validity>
            <not_before>2026-01-01T00:00:00</not_before>
            <not_after>2027-01-01T00:00:00</not_after>
        </validity>
        <allow_rule>
            <domains>
                <id>0</id>
            </domains>
            <publish>
                <topic>HelloWorldTopic</topic>
                <partitions>
                    <partition>*</partition>
                </partitions>
            </publish>
        </allow_rule>
    </grant>
    
    <grant name="SubscriberPermissions">
        <subject_name>CN=Subscriber,O=MyOrg,C=US</subject_name>
        <allow_rule>
            <domains>
                <id>0</id>
            </domains>
            <subscribe>
                <topic>HelloWorldTopic</topic>
            </subscribe>
        </allow_rule>
    </grant>
</ds_permissions>
```

---

## C++ 安全配置

### 完整代码示例
```cpp
#include <fastdds/dds/domain/DomainParticipantFactory.hpp>
#include <fastdds/rtps/attributes/PropertyPolicy.hpp>

using namespace eprosima::fastdds::dds;
using namespace eprosima::fastrtps::rtps;

int main() {
    // 创建安全属性
    PropertyPolicy security_properties;
    
    // 身份认证
    security_properties.properties().emplace_back(
        "dds.sec.auth.plugin",
        "builtin.PKI-DH"
    );
    security_properties.properties().emplace_back(
        "dds.sec.auth.builtin.PKI-DH.identity_ca",
        "file://identity_ca.pem"
    );
    security_properties.properties().emplace_back(
        "dds.sec.auth.builtin.PKI-DH.identity_certificate",
        "file://participant_cert.pem"
    );
    security_properties.properties().emplace_back(
        "dds.sec.auth.builtin.PKI-DH.private_key",
        "file://participant_key.pem"
    );
    
    // 访问控制
    security_properties.properties().emplace_back(
        "dds.sec.access.plugin",
        "builtin.Access-Permissions"
    );
    security_properties.properties().emplace_back(
        "dds.sec.access.builtin.Access-Permissions.permissions_ca",
        "file://permissions_ca.pem"
    );
    security_properties.properties().emplace_back(
        "dds.sec.access.builtin.Access-Permissions.governance",
        "file://governance.xml"
    );
    security_properties.properties().emplace_back(
        "dds.sec.access.builtin.Access-Permissions.permissions",
        "file://permissions.xml"
    );
    
    // 加密
    security_properties.properties().emplace_back(
        "dds.sec.crypto.plugin",
        "builtin.AES-GCM-GMAC"
    );
    
    // 创建 Participant
    DomainParticipantQos participant_qos;
    participant_qos.properties(security_properties);
    
    DomainParticipant* participant = 
        DomainParticipantFactory::get_instance()->create_participant(
            0, participant_qos
        );
    
    // ... 正常使用 DDS
    
    return 0;
}
```

---

## 生产环境最佳实践

### 1. 证书管理
- 使用专用 CA，不要与 Web/应用共用
- 证书有效期 1 年，设置自动轮换
- 私钥使用硬件安全模块 (HSM) 存储

### 2. 权限最小化
- 每个 Topic 单独配置权限
- 只授予必要的读写权限
- 使用 partitions 进一步隔离

### 3. 审计日志
- 启用安全审计日志
- 记录认证失败、权限拒绝
- 定期分析异常行为

### 4. 性能考虑
- 加密有开销（约 10-20% 延迟增加）
- 大数据建议使用 SHM（同机免加密）
- 关键数据 ENCRYPT，其他 SIGN 即可

---

_整理自 2026-03-03 DDS-Security 笔记_
