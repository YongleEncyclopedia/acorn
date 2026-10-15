#!/bin/bash
# we-mp-rss（微信公众号 → RSS）的本地容器管理。
#   ./ctl.sh up        首次创建 .env（随机密码与密钥）并启动容器
#   ./ctl.sh upgrade   拉取新镜像后重建容器（数据在 ./data，不受影响）
#   ./ctl.sh down | restart | logs | status | login
# 只监听 127.0.0.1:8001：它的 RSS 地址不需要登录，不要暴露到局域网。
set -euo pipefail
cd "$(dirname "$0")"

NAME=we-mp-rss
IMAGE=${WE_MP_RSS_IMAGE:-ghcr.io/rachelos/we-mp-rss:latest}
PORT=${WE_MP_RSS_PORT:-8001}

ensure_env() {
  [ -f .env ] && return
  local pass secret
  pass=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)
  secret=$(openssl rand -hex 32)
  umask 077
  cat > .env <<EOF
TZ=Asia/Shanghai
USERNAME=admin
PASSWORD=${pass}
SECRET_KEY=${secret}
RSS_BASE_URL=http://127.0.0.1:${PORT}/
RSS_FULL_CONTEXT=True
RSS_PAGE_SIZE=30
GATHER.CONTENT=True
GATHER.CONTENT_AUTO_CHECK=True
EOF
  echo "已生成 .env（登录账号 admin，密码见 ./ctl.sh login）"
}

up() {
  ensure_env
  mkdir -p data
  if docker container inspect "$NAME" >/dev/null 2>&1; then
    docker start "$NAME" >/dev/null
  else
    docker run -d --name "$NAME" --restart unless-stopped \
      -p "127.0.0.1:${PORT}:8001" \
      -v "$PWD/data:/app/data" \
      --env-file .env \
      "$IMAGE" >/dev/null
  fi
  echo "we-mp-rss → http://127.0.0.1:${PORT}/"
}

case "${1:-status}" in
  up) up ;;
  down) docker stop "$NAME" >/dev/null && echo stopped ;;
  restart) docker restart "$NAME" >/dev/null && echo restarted ;;
  upgrade)
    docker pull "$IMAGE"
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    up ;;
  logs) docker logs --tail "${2:-100}" -f "$NAME" ;;
  status) docker ps -a --filter "name=^${NAME}$" --format '{{.Names}}  {{.Status}}  {{.Ports}}' ;;
  login) ensure_env; echo "http://127.0.0.1:${PORT}/  admin / $(sed -n 's/^PASSWORD=//p' .env)" ;;
  *) sed -n '2,7p' "$0"; exit 1 ;;
esac
