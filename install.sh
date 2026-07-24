#!/usr/bin/env bash
# ================================================================
#  TechLife VoiceBridge Enterprise v2.0 — One-Click Installer
#  Debian 12 (Bookworm) / Debian 13 (Trixie)
# ================================================================
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
RED='\033[0;31m';GRN='\033[0;32m';YLW='\033[1;33m';CYN='\033[0;36m';BOLD='\033[1m';NC='\033[0m'
INSTALL_DIR="/opt/techlife-voicebridge"
LOG="/var/log/techlife-install.log"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
p()  { echo -e "${CYN}[INFO]${NC} $*" | tee -a "$LOG"; }
ok() { echo -e "${GRN}[ OK ]${NC} $*" | tee -a "$LOG"; }
w()  { echo -e "${YLW}[WARN]${NC} $*" | tee -a "$LOG"; }
e()  { echo -e "${RED}[ERR ]${NC} $*" | tee -a "$LOG"; exit 1; }
sec(){ echo -e "\n${BOLD}${CYN}━━━ $* ━━━${NC}" | tee -a "$LOG"; }

[[ $EUID -ne 0 ]] && e "Run as root: sudo bash install.sh"
source /etc/os-release 2>/dev/null || e "Cannot detect OS"
[[ "$ID" != "debian" ]] && e "Requires Debian (detected: $ID)"
touch "$LOG"

echo -e "\n${BOLD}${CYN}════════════════════════════════════════${NC}"
echo -e "${BOLD}${CYN}  TechLife VoiceBridge Enterprise Setup  ${NC}"
echo -e "${BOLD}${CYN}════════════════════════════════════════${NC}\n"

read -rp "CouchDB admin username [admin]: " COUCH_USER; COUCH_USER="${COUCH_USER:-admin}"
read -rsp "CouchDB password: " COUCH_PASS; echo
read -rp "Super Admin email [superadmin@techlife.ai]: " SA_EMAIL; SA_EMAIL="${SA_EMAIL:-superadmin@techlife.ai}"
read -rsp "Super Admin password [SuperAdmin@2024]: " SA_PASS; echo; SA_PASS="${SA_PASS:-SuperAdmin@2024}"
read -rp "Anthropic API key (sk-ant-...): " ANT_KEY; ANT_KEY="${ANT_KEY:-placeholder}"
read -rp "DeepL API key (optional): " DEEPL_KEY; DEEPL_KEY="${DEEPL_KEY:-}"
read -rp "Azure TTS key (optional): " AZ_TTS; AZ_TTS="${AZ_TTS:-}"
read -rp "Azure region [eastus]: " AZ_REGION; AZ_REGION="${AZ_REGION:-eastus}"
echo -e "\nPBX:\n  1) Asterisk\n  2) FreeSWITCH\n  3) Both\n  4) Full stack (+ Kamailio)"
read -rp "Choice [1]: " PBX; PBX="${PBX:-1}"
echo -e "\nWhisper model:\n  1) tiny  2) base  3) medium  4) large-v3"
read -rp "Choice [3]: " WC; WC="${WC:-3}"
case "$WC" in 1) WM=tiny;; 2) WM=base;; 4) WM=large-v3;; *) WM=medium;; esac
read -rp "Server IP [auto]: " SERVER_IP; [[ -z "$SERVER_IP" ]] && SERVER_IP=$(hostname -I|awk '{print $1}')
read -rp "SIP domain [$SERVER_IP]: " SIP_DOMAIN; SIP_DOMAIN="${SIP_DOMAIN:-$SERVER_IP}"

echo -e "\n${GRN}Starting installation…${NC}\n"

sec "System packages"
apt-get update -qq
apt-get install -y --no-install-recommends curl wget gnupg2 apt-transport-https ca-certificates \
  software-properties-common build-essential git unzip \
  python3 python3-pip python3-venv python3-dev \
  libssl-dev libffi-dev portaudio19-dev ffmpeg espeak-ng \
  ufw nginx >> "$LOG" 2>&1

if ! command -v node &>/dev/null || [[ $(node -e "process.exit(parseInt(process.version.slice(1))<18?1:0)" 2>/dev/null; echo $?) -ne 0 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >> "$LOG" 2>&1
  apt-get install -y nodejs >> "$LOG" 2>&1
fi
ok "Node $(node -v)"

sec "CouchDB"
curl -fsSL https://couchdb.apache.org/repo/keys.asc | gpg --dearmor | tee /usr/share/keyrings/couchdb-archive-keyring.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/couchdb-archive-keyring.gpg] https://apache.jfrog.io/artifactory/couchdb-deb/ ${VERSION_CODENAME:-bookworm} main" > /etc/apt/sources.list.d/couchdb.list
apt-get update -qq
echo "couchdb couchdb/mode select standalone"               | debconf-set-selections
echo "couchdb couchdb/bindaddress string 127.0.0.1"         | debconf-set-selections
echo "couchdb couchdb/adminpass password $COUCH_PASS"       | debconf-set-selections
echo "couchdb couchdb/adminpass_again password $COUCH_PASS" | debconf-set-selections
apt-get install -y couchdb >> "$LOG" 2>&1
systemctl enable couchdb; systemctl start couchdb; sleep 4
ok "CouchDB ready"

sec "Application files"
mkdir -p "$INSTALL_DIR"
cp -r "$SCRIPT_DIR/." "$INSTALL_DIR/"

sec "Environment config"
cat > "$INSTALL_DIR/.env" << ENV
SERVER_IP=${SERVER_IP}
SIP_DOMAIN=${SIP_DOMAIN}
API_PORT=4000
WS_PORT=8765
WEBHOOK_PORT=5000
DASHBOARD_PORT=3000
ESL_PORT=8776
LOG_DIR=/var/log/techlife
LOG_LEVEL=info
COUCH_URL=http://${COUCH_USER}:${COUCH_PASS}@127.0.0.1:5984
SUPERADMIN_EMAIL=${SA_EMAIL}
SUPERADMIN_PASS=${SA_PASS}
ANTHROPIC_API_KEY=${ANT_KEY}
AI_MODEL=claude-sonnet-4-20250514
WHISPER_MODEL=${WM}
PYTHON_BIN=${INSTALL_DIR}/venv/bin/python3
DEEPL_API_KEY=${DEEPL_KEY}
AZURE_TTS_KEY=${AZ_TTS}
AZURE_TTS_REGION=${AZ_REGION}
JWT_SECRET=$(openssl rand -hex 32)
JWT_EXPIRES=12h
ENV
chmod 600 "$INSTALL_DIR/.env"
ok ".env written"

sec "Python / Whisper ASR"
python3 -m venv "$INSTALL_DIR/venv"
source "$INSTALL_DIR/venv/bin/activate"
pip install --upgrade pip wheel >> "$LOG" 2>&1
pip install openai-whisper torch torchaudio --extra-index-url https://download.pytorch.org/whl/cpu >> "$LOG" 2>&1
python3 -c "import whisper; whisper.load_model('$WM')" >> "$LOG" 2>&1 && ok "Whisper $WM ready" || w "Whisper will download on first run"

sec "NPM packages"
cd "$INSTALL_DIR"
npm install --production >> "$LOG" 2>&1
ok "NPM packages installed"

sec "CouchDB setup"
node scripts/setup-db.js >> "$LOG" 2>&1 && ok "Databases ready"

sec "Nginx"
cp -f "$INSTALL_DIR/configs/nginx/techlife.conf" /etc/nginx/sites-available/techlife
ln -sf /etc/nginx/sites-available/techlife /etc/nginx/sites-enabled/techlife
rm -f /etc/nginx/sites-enabled/default
nginx -t >> "$LOG" 2>&1 && systemctl restart nginx; ok "Nginx configured"

sec "Firewall"
ufw --force reset >> "$LOG" 2>&1
ufw default deny incoming >> "$LOG" 2>&1
ufw default allow outgoing >> "$LOG" 2>&1
for r in "22/tcp" "80/tcp" "443/tcp" "5060/tcp" "5060/udp" "5061/tcp" "5080/tcp" "5080/udp"; do ufw allow $r >> "$LOG" 2>&1; done
ufw allow 16384:32768/udp >> "$LOG" 2>&1
ufw --force enable >> "$LOG" 2>&1; ok "Firewall configured"

if [[ "$PBX" == "1" ]] || [[ "$PBX" == "3" ]] || [[ "$PBX" == "4" ]]; then
  sec "Asterisk"
  apt-get install -y asterisk >> "$LOG" 2>&1
  cp -f "$INSTALL_DIR/configs/asterisk/pjsip.conf"       /etc/asterisk/pjsip.conf
  cp -f "$INSTALL_DIR/configs/asterisk/extensions.conf"  /etc/asterisk/extensions.conf
  cp -f "$INSTALL_DIR/configs/asterisk/ari.conf"         /etc/asterisk/ari.conf
  cp -f "$INSTALL_DIR/configs/asterisk/rtp.conf"         /etc/asterisk/rtp.conf
  cp -f "$INSTALL_DIR/configs/asterisk/techlife_agi.py"  /usr/share/asterisk/agi-bin/
  chmod +x /usr/share/asterisk/agi-bin/techlife_agi.py
  systemctl enable asterisk; systemctl restart asterisk; ok "Asterisk ready"
fi

if [[ "$PBX" == "4" ]]; then
  sec "Kamailio"
  apt-get install -y kamailio kamailio-websocket-modules >> "$LOG" 2>&1 || w "Kamailio install — check repo"
  cp -f "$INSTALL_DIR/configs/kamailio/kamailio.cfg"    /etc/kamailio/kamailio.cfg
  cp -f "$INSTALL_DIR/configs/kamailio/dispatcher.list" /etc/kamailio/dispatcher.list
  sed -i "s/SERVERIP/$SERVER_IP/g;s/SIPDOMAIN/$SIP_DOMAIN/g" /etc/kamailio/kamailio.cfg
  systemctl enable kamailio; systemctl restart kamailio; ok "Kamailio ready"
fi

sec "Systemd service"
mkdir -p /var/log/techlife; chown www-data:www-data /var/log/techlife 2>/dev/null || true
cp -f "$INSTALL_DIR/configs/systemd/techlife-voicebridge.service" /etc/systemd/system/
sed -i "s|/opt/techlife-voicebridge|$INSTALL_DIR|g" /etc/systemd/system/techlife-voicebridge.service
systemctl daemon-reload
systemctl enable techlife-voicebridge
systemctl start techlife-voicebridge; ok "Service started"

echo ""
echo -e "${GRN}${BOLD}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GRN}${BOLD}║   TechLife VoiceBridge Enterprise — INSTALLED!       ║${NC}"
echo -e "${GRN}${BOLD}╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${CYN}Dashboard${NC}   http://${SERVER_IP}"
echo -e "  ${CYN}API${NC}         http://${SERVER_IP}:4000"
echo -e "  ${CYN}Swagger${NC}     http://${SERVER_IP}:4000/api-docs"
echo -e "  ${CYN}Webhooks${NC}    http://${SERVER_IP}:5000/webhook/test"
echo ""
echo -e "  ${YLW}Super Admin:${NC} ${SA_EMAIL} / ${SA_PASS}"
echo -e "  ${YLW}SIP agents:${NC}  1001-1003 / agent1234"
echo -e "  ${YLW}AI line:${NC}     dial 9000"
echo ""
echo -e "  Logs: journalctl -u techlife-voicebridge -f"
