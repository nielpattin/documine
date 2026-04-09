import json
import os
import shutil
import sys
import traceback
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"type": "startup-error", "error": "Missing bundled runtime directory argument."}), flush=True)
        return 1

    bundle_dir = Path(sys.argv[1])
    if not bundle_dir.exists():
        print(json.dumps({"type": "startup-error", "error": f"Bundled runtime directory not found: {bundle_dir}"}), flush=True)
        return 1

    if hasattr(os, 'add_dll_directory'):
        os.add_dll_directory(str(bundle_dir))

    try:
        from weasyprint import HTML
    except Exception as error:
        print(json.dumps({
            "type": "startup-error",
            "error": f"Failed to import WeasyPrint: {error}",
            "traceback": traceback.format_exc(),
        }), flush=True)
        return 1

    print(json.dumps({"type": "ready"}), flush=True)

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except Exception as error:
            print(json.dumps({"type": "error", "error": f"Invalid JSON request: {error}"}), flush=True)
            continue

        if message.get('type') == 'shutdown':
            print(json.dumps({"type": "shutdown"}), flush=True)
            return 0

        request_id = str(message.get('id', ''))
        html_path = message.get('htmlPath')
        pdf_path = message.get('pdfPath')
        cache_dir = message.get('cacheDir')

        if not request_id or not html_path or not pdf_path:
            print(json.dumps({
                "type": "error",
                "id": request_id,
                "error": 'Missing required request fields.',
            }), flush=True)
            continue

        try:
            cache_path = Path(str(cache_dir)) if cache_dir else None
            if cache_path is not None:
                cache_path.mkdir(parents=True, exist_ok=True)
            HTML(filename=str(html_path)).write_pdf(str(pdf_path), cache=str(cache_path) if cache_path else None)
            print(json.dumps({"type": "done", "id": request_id}), flush=True)
        except Exception as error:
            error_text = str(error)
            try:
                if cache_dir and ('No such file or directory' in error_text or isinstance(error, FileNotFoundError)):
                    cache_path = Path(str(cache_dir))
                    shutil.rmtree(cache_path, ignore_errors=True)
                    cache_path.mkdir(parents=True, exist_ok=True)
                    HTML(filename=str(html_path)).write_pdf(str(pdf_path), cache=None)
                    print(json.dumps({"type": "done", "id": request_id, "retry": "no-cache"}), flush=True)
                    continue
            except Exception:
                pass
            print(json.dumps({
                "type": "error",
                "id": request_id,
                "error": error_text,
                "traceback": traceback.format_exc(),
            }), flush=True)

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
