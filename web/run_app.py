#!/usr/bin/env python3
"""Run GBL Synapse locally, with same-origin harvester and validation APIs."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
from urllib.parse import urlsplit, parse_qs
import webbrowser

WEB_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(WEB_ROOT / 'scripts/yt-harvest'))
from service import HarvestService
from observed import ObservedCatalog


class LocalHandler(SimpleHTTPRequestHandler):
    MAX_BODY = 1024 * 1024

    def __init__(self, *args, service=None, **kwargs):
        self.service = service
        self.observed = getattr(service, "observed_catalog", None)
        if service is not None and self.observed is None:
            self.observed = service.observed_catalog = ObservedCatalog(service.work_dir, service.web_root)
        super().__init__(*args, **kwargs)

    def _json(self, status, value):
        data = json.dumps(value, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self, mutation=False):
        # Bind loopback and validate Host against DNS rebinding; Origin prevents browser cross-site writes.
        port = self.server.server_port
        valid = {'localhost:%s' % port, '127.0.0.1:%s' % port}
        if port == 80:
            valid.update(('localhost', '127.0.0.1'))
        host = self.headers.get('Host', '')
        if host not in valid:
            self._json(403, {'error': 'Local API requires this server’s localhost Host.'})
            return False
        origin = self.headers.get('Origin')
        if (mutation and origin != 'http://' + host) or (origin and origin != 'http://' + host):
            self._json(403, {'error': 'Local API requests must come from this page’s origin.'})
            return False
        if self.headers.get('Sec-Fetch-Site') == 'cross-site':
            self._json(403, {'error': 'Cross-site API requests are not allowed.'})
            return False
        return True

    def do_GET(self):
        path = urlsplit(self.path).path
        if not path.startswith('/api/'):
            return super().do_GET()
        if not self._authorized():
            return
        try:
            if path == '/api/harvest/status':
                self._json(200, self.service.status())
            elif path == '/api/observed-meta':
                state = self.observed.state()
                since = parse_qs(urlsplit(self.path).query).get('since', [''])[0]
                self._json(200, {'revision': state['revision'], 'unchanged': True} if since == state['revision'] else state)
            elif path == '/api/validation':
                self._json(200, self.service.feedback().state())
            elif path == '/api/validation/metrics':
                self._json(200, self.service.validation_metrics())
            else:
                self._json(404, {'error': 'Unknown API route.'})
        except Exception as ex:
            self._json(503, {'available': False, 'error': str(ex)[:500]})

    def do_POST(self):
        path = urlsplit(self.path).path
        if not path.startswith('/api/'):
            self._json(404, {'error': 'Unknown API route.'})
            return
        if not self._authorized(mutation=True):
            return
        if self.headers.get('Content-Type', '').split(';')[0].strip() != 'application/json':
            self._json(415, {'error': 'Send application/json.'})
            return
        try:
            if self.headers.get('Transfer-Encoding'):
                raise ValueError('Streaming request bodies are not supported.')
            length = int(self.headers.get('Content-Length', '-1'))
            if length < 0 or length > self.MAX_BODY:
                raise ValueError('JSON request body must be at most 1 MB.')
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError('Expected a JSON object.')
            if path == '/api/harvest/start':
                result = self.service.start(body)
            elif path == '/api/harvest/stop':
                result = self.service.stop()
            elif path == '/api/validation/answers':
                answers = body.get('answers')
                if not isinstance(answers, list) or len(answers) > 1000:
                    raise ValueError('answers must be a list with at most 1000 entries.')
                result = self.service.feedback().answer_many(answers)
            elif path == '/api/validation/resolve':
                # Gated LLM answers (scripts/freellm/validate_llm.py; source local-llm, haiku or freellm): reversible resolutions, never labels.
                items = body.get('resolutions')
                if not isinstance(items, list) or len(items) > 1000:
                    raise ValueError('resolutions must be a list with at most 1000 entries.')
                result = self.service.feedback().resolve_external(items)
            elif path == '/api/validation/retrain':
                result = self.service.feedback().retrain()
            elif path == '/api/validation/reopen':
                qid = body.get('qid')
                if not isinstance(qid, str) or not qid or len(qid) > 250:
                    raise ValueError('qid must be a nonempty question ID.')
                result = self.service.feedback().reopen(qid)
            else:
                self._json(404, {'error': 'Unknown API route.'})
                return
            self._json(200, result)
        except (ValueError, TypeError, KeyError) as ex:
            self._json(400, {'error': str(ex)[:500]})
        except RuntimeError as ex:
            self._json(409, {'error': str(ex)[:500]})
        except Exception as ex:
            self._json(503, {'error': str(ex)[:500]})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8000, help='Local port (0 selects a free port)')
    parser.add_argument('--no-browser', action='store_true')
    parser.add_argument('--harvest-work', help='Resumable harvester work directory (defaults to YT_HARVEST_WORK)')
    args = parser.parse_args()
    service = HarvestService(work_dir=args.harvest_work, web_root=WEB_ROOT)
    handler = partial(LocalHandler, directory=str(WEB_ROOT), service=service)
    try:
        server = ThreadingHTTPServer(('127.0.0.1', args.port), handler)
    except OSError as error:
        parser.exit(1, f'Unable to start: {error}. Try --port 8001.\n')
    url = f'http://localhost:{server.server_port}/familyRanks.html'
    print(f'GBL Synapse: {url}\nKeep this window open. Press Ctrl+C to stop the web server.\n'
          'Harvester runs survive closing this server; use Stop harvesting in the UI to drain them.', flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nWeb server stopped.')
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
