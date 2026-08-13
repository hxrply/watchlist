"""Local static file server for Losinn's Watchlist.

Disables caching so the browser always fetches the latest files, and — crucially
— finds its OWN free port instead of assuming one is available. It then opens the
browser to the exact port it bound, so it can never accidentally land on another
local app that happens to be using a fixed port. Run with: python serve.py
"""
import http.server
import webbrowser

# Preferred ports, tried in order; the first free one wins. If they're all taken
# the OS picks any free port (0), so this never collides with another app.
CANDIDATE_PORTS = [8020, 8021, 8022, 8023, 8024, 0]


class Server(http.server.ThreadingHTTPServer):
    # IMPORTANT: default False. Python's HTTPServer sets this True, and on Windows
    # SO_REUSEADDR lets a socket bind a port another app is ALREADY using — the
    # bind "succeeds" and requests go to whichever app unpredictably. Keeping it
    # False makes an occupied port raise OSError so make_server() skips to a truly
    # free one instead of clashing with another local app.
    allow_reuse_address = False


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def log_message(self, *args):
        pass  # keep the console quiet


def make_server():
    for port in CANDIDATE_PORTS:
        try:
            return Server(("127.0.0.1", port), NoCacheHandler)
        except OSError:
            continue  # port busy, try the next one
    raise SystemExit("Could not bind any port for the Watchlist.")


if __name__ == "__main__":
    server = make_server()
    url = f"http://localhost:{server.server_address[1]}"
    print(f"Serving Losinn's Watchlist at {url}  (Ctrl+C or close this window to stop)")
    try:
        webbrowser.open(url)
    except Exception:
        pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
