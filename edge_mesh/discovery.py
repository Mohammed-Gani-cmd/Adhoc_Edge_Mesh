import socket
import threading
import time
import uuid

try:
    from zeroconf import Zeroconf, ServiceBrowser, ServiceInfo, ServiceStateChange
except ImportError:  # manual --peer mode still works
    Zeroconf = ServiceBrowser = ServiceInfo = ServiceStateChange = None


class Discovery:
    def __init__(self, name, port, protocol_version, service_type="_adhoc-edge._tcp.local."):
        self.name = name
        self.port = port
        self.protocol_version = protocol_version
        self.service_type = service_type
        self.node_id = uuid.uuid4().hex[:8]
        self.peers = {}
        self.lock = threading.Lock()
        self.zc = None
        self.info = None
        self.browser = None

    @staticmethod
    def local_ip():
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("192.0.2.1", 9))
            return s.getsockname()[0]
        except OSError:
            return "127.0.0.1"
        finally:
            s.close()

    def start(self):
        if Zeroconf is None:
            return False
        try:
            self.zc = Zeroconf()
            ip = self.local_ip()
            props = {
                b"node_id": self.node_id.encode(),
                b"display_name": self.name.encode(),
                b"port": str(self.port).encode(),
                b"protocol_version": self.protocol_version.encode(),
            }
            service_name = f"{self.name}-{self.node_id}.{self.service_type}"
            self.info = ServiceInfo(
                self.service_type,
                service_name,
                addresses=[socket.inet_aton(ip)],
                port=self.port,
                properties=props,
            )
            self.zc.register_service(self.info)
            self.browser = ServiceBrowser(self.zc, self.service_type, handlers=[self._on_change])
            return True
        except Exception:
            self.stop()
            return False

    def _on_change(self, zeroconf, service_type, name, state_change):
        if state_change == ServiceStateChange.Removed:
            with self.lock:
                for key, peer in list(self.peers.items()):
                    if peer.get("service_name") == name:
                        self.peers.pop(key, None)
            return
        try:
            info = zeroconf.get_service_info(service_type, name, timeout=1000)
            if not info or not info.addresses:
                return
            props = {
                (k.decode() if isinstance(k, bytes) else str(k)):
                (v.decode() if isinstance(v, bytes) else str(v))
                for k, v in info.properties.items()
            }
            peer_id = props.get("node_id") or name
            if peer_id == self.node_id:
                return
            peer = {
                "node_id": peer_id,
                "name": props.get("display_name", name),
                "host": socket.inet_ntoa(info.addresses[0]),
                "port": info.port,
                "protocol_version": props.get("protocol_version", "?"),
                "source": "mdns",
                "service_name": name,
                "last_seen": time.time(),
            }
            with self.lock:
                self.peers[peer_id] = peer
        except Exception:
            return

    def add_manual(self, host, port):
        key = f"manual-{host}:{port}"
        with self.lock:
            self.peers[key] = {
                "node_id": key,
                "name": f"Peer {host}:{port}",
                "host": host,
                "port": int(port),
                "protocol_version": self.protocol_version,
                "source": "manual",
                "last_seen": time.time(),
            }

    def list_peers(self):
        with self.lock:
            return [dict(p) for p in self.peers.values()]

    def stop(self):
        try:
            if self.zc and self.info:
                self.zc.unregister_service(self.info)
            if self.zc:
                self.zc.close()
        except Exception:
            pass
        finally:
            self.zc = self.info = self.browser = None
