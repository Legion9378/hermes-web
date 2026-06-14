#!/usr/bin/env python3
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import argparse
import http.client
import json
import os
import re
import subprocess
from urllib.parse import urlparse, urlsplit, urlunsplit

HOP_BY_HOP = {
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailers', 'transfer-encoding', 'upgrade', 'content-encoding'
}

class Handler(SimpleHTTPRequestHandler):
    hermes_target = 'http://127.0.0.1:8642'
    base_path = ''
    api_key = ''
    extensions_map = SimpleHTTPRequestHandler.extensions_map | {
        '.webmanifest': 'application/manifest+json',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml',
    }

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        # Hermes Web is a local-control UI that changes during development. Avoid
        # Safari/Chrome keeping a stale app.js/module graph after updates.
        self.send_header('Cache-Control', 'no-cache, must-revalidate')
        super().end_headers()

    def _path_without_base(self):
        if not self.base_path:
            return self.path
        parsed = urlsplit(self.path)
        path = parsed.path.rstrip('/') if parsed.path != '/' else parsed.path
        base = self.base_path.rstrip('/')
        if parsed.path == base:
            self.send_response(308)
            self.send_header('Location', base + '/' + (('?' + parsed.query) if parsed.query else ''))
            self.end_headers()
            return None
        if not parsed.path.startswith(base + '/'):
            self.send_error(404, f'Expected base path {base}/')
            return None
        stripped = parsed.path[len(base):] or '/'
        return urlunsplit(('', '', stripped, parsed.query, parsed.fragment))

    def _dispatch(self, static=False):
        routed = self._path_without_base()
        if routed is None:
            return
        if routed.startswith('/__hermes_web/'):
            if self.command != 'POST':
                self.send_error(405)
                return
            return self.handle_web_control(routed)
        if routed.startswith('/hermes/') or routed == '/hermes':
            return self.proxy_to_hermes(routed)
        if static:
            old_path = self.path
            self.path = routed
            try:
                return super().do_GET()
            finally:
                self.path = old_path
        self.send_error(404)

    def do_GET(self):
        return self._dispatch(static=True)

    def do_POST(self):
        return self._dispatch(static=False)

    def do_PATCH(self):
        return self._dispatch(static=False)

    def do_DELETE(self):
        return self._dispatch(static=False)

    def _control_authorized(self):
        expected = self.api_key or os.environ.get('API_SERVER_KEY', '')
        if not expected:
            return False
        return self.headers.get('Authorization', '') == f'Bearer {expected}'

    def _read_json(self):
        length = int(self.headers.get('Content-Length') or 0)
        if length > 10000:
            raise ValueError('Request body too large')
        raw = self.rfile.read(length) if length else b'{}'
        return json.loads(raw.decode('utf-8') or '{}')

    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    @staticmethod
    def _valid_token(value):
        return isinstance(value, str) and 0 < len(value.strip()) <= 160 and re.fullmatch(r'[A-Za-z0-9._:/@+\-]+', value.strip())

    def handle_web_control(self, routed_path):
        if not self._control_authorized():
            return self._send_json(401, {'error': 'unauthorized'})
        try:
            payload = self._read_json()
        except Exception as exc:
            return self._send_json(400, {'error': f'invalid_json: {exc}'})
        if routed_path == '/__hermes_web/models':
            refresh = bool(payload.get('refresh'))
            try:
                import sys
                repo = Path.home() / '.hermes' / 'hermes-agent'
                py = repo / 'venv' / 'bin' / 'python'
                script = """
import json, sys
sys.path.insert(0, '/home/work/.hermes/hermes-agent')
refresh = bool(int(sys.argv[1]))
if refresh:
    try:
        from hermes_cli.models import clear_provider_models_cache
        clear_provider_models_cache()
    except Exception:
        pass
from hermes_cli.inventory import load_picker_context, build_models_payload
print(json.dumps(build_models_payload(load_picker_context(), max_models=1000), ensure_ascii=False))
"""
                completed = subprocess.run([str(py if py.exists() else sys.executable), '-c', script, '1' if refresh else '0'], text=True, capture_output=True, timeout=90)
                if completed.returncode != 0:
                    return self._send_json(500, {'error': 'model_inventory_failed', 'message': completed.stderr[-4000:] or completed.stdout[-4000:]})
                return self._send_json(200, json.loads(completed.stdout))
            except Exception as exc:
                return self._send_json(500, {'error': 'model_inventory_failed', 'message': str(exc)})

        if routed_path != '/__hermes_web/model':
            return self._send_json(404, {'error': 'unknown_control_endpoint'})
        model = str(payload.get('model') or '').strip()
        provider = str(payload.get('provider') or '').strip()
        if model and not self._valid_token(model):
            return self._send_json(400, {'error': 'invalid_model'})
        if provider and not self._valid_token(provider):
            return self._send_json(400, {'error': 'invalid_provider'})
        if not model and not provider:
            return self._send_json(400, {'error': 'model_or_provider_required'})
        commands = []
        if provider:
            commands.append(['hermes', 'config', 'set', 'model.provider', provider])
        if model:
            commands.append(['hermes', 'config', 'set', 'model.default', model])
        outputs = []
        for cmd in commands:
            completed = subprocess.run(cmd, text=True, capture_output=True, timeout=30)
            outputs.append({'cmd': cmd, 'returncode': completed.returncode, 'stdout': completed.stdout[-2000:], 'stderr': completed.stderr[-2000:]})
            if completed.returncode != 0:
                return self._send_json(500, {'error': 'config_set_failed', 'outputs': outputs})
        return self._send_json(200, {'ok': True, 'model': model, 'provider': provider, 'outputs': outputs})

    def proxy_to_hermes(self, routed_path):
        target = urlparse(self.hermes_target)
        upstream_path = routed_path.removeprefix('/hermes') or '/'
        body = None
        length = self.headers.get('Content-Length')
        if length:
            body = self.rfile.read(int(length))

        headers = {}
        for key, value in self.headers.items():
            lk = key.lower()
            if lk in HOP_BY_HOP or lk in {'host', 'origin', 'referer'}:
                continue
            headers[key] = value

        conn_cls = http.client.HTTPSConnection if target.scheme == 'https' else http.client.HTTPConnection
        port = target.port or (443 if target.scheme == 'https' else 80)
        conn = conn_cls(target.hostname, port, timeout=3600)
        try:
            conn.request(self.command, upstream_path, body=body, headers=headers)
            resp = conn.getresponse()
            self.send_response(resp.status, resp.reason)
            for key, value in resp.getheaders():
                if key.lower() not in HOP_BY_HOP:
                    self.send_header(key, value)
            self.end_headers()
            while True:
                chunk = resp.read(8192)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except Exception as exc:
            self.send_error(502, f'Hermes proxy error: {exc}')
        finally:
            conn.close()

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Serve Hermes Web with same-origin Hermes API proxy')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=4173)
    parser.add_argument('--hermes-api', default=os.environ.get('HERMES_API_URL', 'http://127.0.0.1:8642'))
    parser.add_argument('--base-path', default=os.environ.get('HERMES_WEB_BASE_PATH', ''), help='Optional URL prefix, e.g. /ziel when Caddy does not strip the prefix')
    args = parser.parse_args()
    Handler.hermes_target = args.hermes_api.rstrip('/')
    Handler.api_key = os.environ.get('API_SERVER_KEY', '')
    if not Handler.api_key:
        env_path = Path.home() / '.hermes' / '.env'
        if env_path.exists():
            for line in env_path.read_text(errors='ignore').splitlines():
                if line.startswith('API_SERVER_KEY='):
                    Handler.api_key = line.split('=', 1)[1].strip().strip('"\'')
                    break
    Handler.base_path = ('/' + args.base_path.strip('/')) if args.base_path.strip('/') else ''
    os.chdir(Path(__file__).resolve().parent)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    base = Handler.base_path or ''
    print(f'Hermes Web listening on http://{args.host}:{args.port}{base or "/"}')
    print(f'Proxying {base}/hermes/* to {Handler.hermes_target}')
    server.serve_forever()
