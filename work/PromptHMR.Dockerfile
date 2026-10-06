FROM python:3.11-slim-bookworm
ENV DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential git ffmpeg libgl1 libegl1 libsuitesparse-dev libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
RUN python -m pip install --upgrade pip setuptools wheel && \
    python -m pip install numpy==1.26.4 && \
    python -m pip install torch==2.4.0 torchvision==0.19.0 torchaudio==2.4.0 \
    --index-url https://download.pytorch.org/whl/cu121
RUN python -m pip install torch-scatter -f https://data.pyg.org/whl/torch-2.4.0+cu121.html && \
    python -m pip install xformers==0.0.27.post2 --index-url https://download.pytorch.org/whl/cu121 --no-deps
COPY PromptHMR/requirements.txt /tmp/requirements.txt
RUN python -m pip install -r /tmp/requirements.txt 'numpy<2'
RUN git clone https://github.com/Arthur151/chumpy /opt/chumpy && \
    python -m pip install /opt/chumpy --no-build-isolation
COPY PromptHMR/data/wheels/ /opt/phmr-wheels/
RUN python -m pip install \
    /opt/phmr-wheels/detectron2-0.8-cp311-cp311-linux_x86_64.whl \
    /opt/phmr-wheels/droid_backends_intr-0.3-cp311-cp311-linux_x86_64.whl \
    /opt/phmr-wheels/lietorch-0.3-cp311-cp311-linux_x86_64.whl \
    /opt/phmr-wheels/sam2-1.5-cp311-cp311-linux_x86_64.whl
WORKDIR /workspace/work/PromptHMR
