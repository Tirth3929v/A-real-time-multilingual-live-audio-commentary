# Use a lightweight Python image
FROM python:3.10-slim

# Set the working directory
WORKDIR /code

# Install system dependencies required for WebRTC VAD and audio compilation
RUN apt-get update && apt-get install -y ffmpeg gcc portaudio19-dev

# Copy the requirements file and install dependencies
COPY ./requirements.txt /code/requirements.txt
RUN pip install --no-cache-dir --upgrade -r /code/requirements.txt

# Copy the rest of your backend code into the container
COPY . .

# Run the FastAPI server
EXPOSE 8000
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000"]
