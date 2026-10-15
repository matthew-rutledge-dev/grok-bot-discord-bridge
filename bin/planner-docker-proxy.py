#!/usr/bin/env python3
"""TCP proxy: docker-bridge gateway:18771 -> 127.0.0.1:18771 (rumble reverse tunnel)."""
import socket
import subprocess
import threading
import time

def gateway() -> str:
    out = subprocess.check_output(
        [
            "docker", "network", "inspect", "grok-bot-discord-bridge_default",
            "--format", "{{range .IPAM.Config}}{{.Gateway}}{{end}}",
        ],
        text=True,
    ).strip()
    if not out:
        raise RuntimeError("docker gateway missing")
    return out

def pipe(src: socket.socket, dst: socket.socket) -> None:
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except Exception:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except Exception:
            pass

def handle(client: socket.socket) -> None:
    try:
        upstream = socket.create_connection(("127.0.0.1", 18771), 10)
    except Exception:
        client.close()
        return
    threading.Thread(target=pipe, args=(client, upstream), daemon=True).start()
    pipe(upstream, client)

def bind_addrs() -> list[str]:
    found = []
    for candidate in ("172.17.0.1",):
        found.append(candidate)
    try:
        gw = gateway()
        if gw not in found:
            found.append(gw)
    except Exception as exc:
        print(f"gateway lookup {exc}", flush=True)
    return found

def listen_one(addr: str) -> None:
    while True:
        srv = None
        try:
            srv = socket.socket()
            srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            srv.bind((addr, 18771))
            srv.listen(32)
            print(f"proxy listening {addr}:18771 -> 127.0.0.1:18771", flush=True)
            while True:
                client, _peer = srv.accept()
                threading.Thread(target=handle, args=(client,), daemon=True).start()
        except Exception as exc:
            print(f"proxy retry {addr} {exc}", flush=True)
            if srv is not None:
                try:
                    srv.close()
                except Exception:
                    pass
            time.sleep(2)

def serve() -> None:
    addrs = bind_addrs()
    threads = []
    for addr in addrs:
        th = threading.Thread(target=listen_one, args=(addr,), daemon=True)
        th.start()
        threads.append(th)
    for th in threads:
        th.join()

if __name__ == "__main__":
    serve()
