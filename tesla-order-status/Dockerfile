# TOST (github.com/chrisi51/tesla-order-status) pinned to one upstream commit.
ARG PYTHON_VERSION=3.11
FROM python:${PYTHON_VERSION}-slim

# Upstream commit baked into the image; bump it and rebuild to upgrade (the in-app auto-update is disabled).
ARG TOST_REF=5431bbddad6fcf87d366dbcb3ac7b5ff9beb4f37

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# pyperclip is optional (clipboard only), so it is left out of the headless image
RUN pip install requests curl_cffi \
 && useradd --create-home --uid 1000 tost

WORKDIR /app
ADD https://github.com/chrisi51/tesla-order-status/archive/${TOST_REF}.tar.gz /tmp/tost.tar.gz
RUN tar -xzf /tmp/tost.tar.gz --strip-components=1 -C /app \
 && rm /tmp/tost.tar.gz \
 && mkdir -p data/private \
 && chown -R tost:tost /app

COPY tost.py /usr/local/bin/tost.py

USER tost
VOLUME /app/data/private
ENTRYPOINT ["python", "/usr/local/bin/tost.py"]
CMD ["watch"]
