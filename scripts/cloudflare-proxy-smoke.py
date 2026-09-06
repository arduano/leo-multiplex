#!/usr/bin/env python3
"""Qualify the pinned proxy with a built Leo image and disposable credentials."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parent.parent
image = sys.argv[1] if len(sys.argv) > 1 else "leo-multiplex:cloudflare"
network = "leo-cloudflare-smoke-" + str(os.getpid())
proxy = network + "-proxy"
nginx = "nginxinc/nginx-unprivileged:stable-alpine@sha256:9b87ad3dd9f431c733f19dfb278c7eb3dba9dca381942c79818bb42f1a566a83"
# Keep the disposable volume and both nonroot containers owned by the runner.
# NAS uses 1000:100; hosted CI runners may have another unprivileged identity.
if os.getuid() == 0:
    raise SystemExit("Run the proxy smoke test as an unprivileged user")
user = f"{os.getuid()}:{os.getgid()}"
with tempfile.TemporaryDirectory(prefix="leo-cloudflare-socket-") as directory:
    os.chmod(directory, 0o700)
    subprocess.run(["docker", "network", "create", "--internal", network], check=True, stdout=subprocess.DEVNULL)
    try:
        subprocess.run([
            "docker", "run", "-d", "--name", proxy, "--network", network,
            "--network-alias", "multiplex-gatreway", "--user", user,
            "--read-only", "--tmpfs", "/tmp", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges",
            "--mount", f"type=bind,src={root}/deploy/nas/cloudflare-origin.conf,dst=/etc/nginx/nginx.conf,readonly",
            "--mount", f"type=bind,src={directory},dst=/run/leo-cloudflare,readonly",
            "--entrypoint", "nginx", nginx, "-g", "daemon off;",
        ], check=True, stdout=subprocess.DEVNULL)
        subprocess.run([
            "docker", "run", "--rm", "--network", network, "--user", user, "--read-only",
            "--tmpfs", "/tmp", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--mount", f"type=bind,src={directory},dst=/run/leo-cloudflare",
            "--mount", f"type=bind,src={root}/scripts,dst=/app/scripts,readonly",
            image, "node", "scripts/cloudflare-proxy-smoke.mjs",
        ], check=True, timeout=60)
    finally:
        subprocess.run(["docker", "rm", "-f", proxy], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["docker", "network", "rm", network], check=True, stdout=subprocess.DEVNULL)
