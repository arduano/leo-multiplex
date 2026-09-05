#!/usr/bin/env bash
set -euo pipefail
umask 077
pairing_file="${LEO_PAIRING_FILE:-${XDG_STATE_HOME:-$HOME/.local/state}/leo-multiplex/gateway-pairing.json}"
test -f "$pairing_file"
# Destination is deliberately fixed to this project's private configuration.
ssh -o BatchMode=yes nas 'umask 077; mkdir -p /home/arduano/host/leo-multiplex/config /home/arduano/host/leo-multiplex/state; chmod 700 /home/arduano/host/leo-multiplex/config /home/arduano/host/leo-multiplex/state'
scp -q "$pairing_file" nas:/home/arduano/host/leo-multiplex/config/gateway-pairing.json.new
ssh -o BatchMode=yes nas 'chmod 600 /home/arduano/host/leo-multiplex/config/gateway-pairing.json.new; mv /home/arduano/host/leo-multiplex/config/gateway-pairing.json.new /home/arduano/host/leo-multiplex/config/gateway-pairing.json'
printf '%s\n' 'Pairing delivered to the private Leo gateway configuration. Close enrollment after confirming the connection.'
