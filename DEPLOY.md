# 云端部署

## 服务器准备

Ubuntu 22.04/24.04 登录后执行：

```bash
apt update
apt install -y ca-certificates curl gnupg git unzip ufw

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://mirrors.aliyun.com/docker-ce/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

ufw allow 22
ufw allow 80
ufw allow 443
ufw --force enable
```

## 启动

```bash
cd /opt/stock-desk
cp .env.example .env
docker compose up -d --build
```

访问：

```text
http://服务器公网IP
```

## 本机 Agent 上传接口

```text
POST /api/import-analysis
Authorization: Bearer LOCAL_AGENT_TOKEN
```

示例 JSON：

```json
{
  "date": "2026-06-11",
  "source": "杰哥训练营投资鱼池20260611.pdf",
  "summary": "鱼池文件已整理。",
  "stocks": [
    {
      "code": "301123",
      "name": "奕东电子",
      "buyZone": "90~95.00",
      "reason": "AI 液冷第二增长曲线",
      "risk": "按纪律止盈止损"
    }
  ]
}
```
