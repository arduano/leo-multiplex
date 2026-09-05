#!/usr/bin/env python3
"""Configure only Leo's HTTP Serve route, retaining unrelated NAS services."""
import argparse
import copy
from contextlib import closing
import http.client
import ipaddress
import json
import socket

PORT = '8444'
PROXY = {'Handlers': {'/': {'Proxy': 'http://127.0.0.1:4328'}}}


class LocalAPI(http.client.HTTPConnection):
    def __init__(self):
        super().__init__('local-tailscaled.sock', timeout=10)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect('/var/run/tailscale/tailscaled.sock')


def updated_config(current, address, dns_name, remove=False):
    ip = ipaddress.ip_address(address)
    if ip.version != 4 or ip not in ipaddress.ip_network('100.64.0.0/10'):
        raise ValueError('Expected this NAS\'s assigned Tailscale IPv4 address')
    dns_name = dns_name.rstrip('.')
    if '.' not in dns_name:
        raise ValueError('Tailscale status has no tailnet DNS suffix')
    suffix = dns_name.split('.', 1)[1]
    # Tailscale 1.102 appends the tailnet suffix to an HTTP Host IP before lookup.
    keys = [f'{dns_name}:{PORT}', f'{address}.{suffix}:{PORT}']
    config = copy.deepcopy(current or {})
    if any(key.endswith(':' + PORT) and enabled for key, enabled in (config.get('AllowFunnel') or {}).items()):
        raise ValueError('Leo HTTP route must not have Funnel enabled')
    tcp = config['TCP'] = config.get('TCP') or {}
    web = config['Web'] = config.get('Web') or {}
    if PORT in tcp and tcp[PORT] != {'HTTP': True}:
        raise ValueError('Leo HTTP port already has another Serve listener')
    for key in keys:
        if key in web and web[key] != PROXY:
            raise ValueError('Leo route already has another Serve handler')
    if remove:
        for key in keys:
            web.pop(key, None)
        if not any(key.endswith(':' + PORT) for key in web):
            tcp.pop(PORT, None)
    else:
        tcp[PORT] = {'HTTP': True}
        for key in keys:
            web[key] = copy.deepcopy(PROXY)
    return config


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--remove', action='store_true', help='Remove only Leo\'s HTTP Serve routes')
    args = parser.parse_args()
    with closing(LocalAPI()) as client:
        client.request('GET', '/localapi/v0/status')
        response = client.getresponse()
        if response.status != 200:
            raise RuntimeError('Cannot read Tailscale status')
        status = json.load(response)
        address = next(ip for ip in status['TailscaleIPs'] if ipaddress.ip_address(ip).version == 4)
        client.request('GET', '/localapi/v0/serve-config')
        response = client.getresponse()
        if response.status != 200:
            raise RuntimeError('Cannot read Tailscale Serve configuration')
        etag = response.getheader('ETag')
        if not etag:
            raise RuntimeError('Missing Serve configuration revision')
        current = json.load(response)
        config = updated_config(current, address, status['Self']['DNSName'], args.remove)
        client.request('POST', '/localapi/v0/serve-config', body=json.dumps(config),
                       headers={'If-Match': etag, 'Content-Type': 'application/json'})
        response = client.getresponse()
        response.read()
        if response.status != 200:
            raise RuntimeError(f'Serve update rejected (HTTP {response.status}); no retry attempted')
    print('Leo HTTP route removed' if args.remove else f'Leo workspace: http://{address}:{PORT}/')


if __name__ == '__main__':
    main()
