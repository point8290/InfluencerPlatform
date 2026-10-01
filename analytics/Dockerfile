FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY pyproject.toml ./
COPY src ./src
COPY dashboard ./dashboard
RUN pip install '.[dashboard]'

# Unprivileged runtime user.
RUN useradd --create-home --uid 10001 analytics
USER analytics

EXPOSE 8000 8501
# One image, three entrypoints — selected by `command` in docker-compose.yml:
#   analytics-api | analytics-consumer | streamlit run dashboard/app.py
CMD ["analytics-api"]
