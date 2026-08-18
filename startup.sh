#!/bin/bash
# Azure App Service entry point for the public demo.
#
# Dependencies are vendored into ./vendor as linux wheels and the platform's
# build step is turned off, so a restart is an unzip of files that are already
# in place rather than a pip install and a 129 MB tarball extraction. That is
# what keeps a cold start in seconds instead of minutes, and it removes the
# class of failure where the build container and the runtime disagree about
# where the application lives.
set -e
cd /home/site/wwwroot
export PYTHONPATH=/home/site/wwwroot/vendor:/home/site/wwwroot
exec python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2
