import json
import subprocess
import sys
import time
import urllib.error
import urllib.request


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'Missing app target'}), file=sys.stderr)
        sys.exit(1)

    app_target = sys.argv[1]
    process = subprocess.Popen(
        ['uvicorn', app_target, '--host', '127.0.0.1', '--port', '8000'],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    try:
        openapi_url = 'http://127.0.0.1:8000/openapi.json'
        for _ in range(300):
            if process.poll() is not None:
                print(json.dumps({'error': 'Uvicorn failed to start'}), file=sys.stderr)
                sys.exit(1)

            try:
                with urllib.request.urlopen(openapi_url, timeout=1) as response:
                    if response.status == 200:
                        sys.stdout.buffer.write(response.read())
                        sys.exit(0)
            except urllib.error.URLError:
                pass

            time.sleep(0.1)

        print(json.dumps({'error': 'Timeout waiting for openapi.json'}), file=sys.stderr)
        sys.exit(1)
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except Exception:
            process.kill()
            process.wait()


if __name__ == '__main__':
    main()
