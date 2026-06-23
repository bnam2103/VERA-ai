FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

ENV PYTHONUNBUFFERED=1

# Install Python + system deps
RUN apt update && apt install -y \
    python3 python3-pip git ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN pip3 install --upgrade pip
COPY . .

# Install torch with CUDA
RUN pip3 install torch --index-url https://download.pytorch.org/whl/cu121

# Install remaining requirements
RUN pip3 install -r requirements.txt

# Expose port
EXPOSE 80

# Start server
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "80"]