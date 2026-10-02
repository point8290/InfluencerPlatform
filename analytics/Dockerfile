FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Dependencies first, in their own layer: they only reinstall when
# pyproject.toml changes, not on every code edit. A placeholder package lets
# pip resolve the project's dependencies before the real source is copied.
COPY pyproject.toml ./
RUN mkdir -p src/analytics_service \
 && touch src/analytics_service/__init__.py \
 && pip install '.[dashboard]' \
 && pip uninstall -y analytics-service \
 && rm -rf src build

COPY src ./src
COPY dashboard ./dashboard
RUN pip install --no-deps .

# Unprivileged runtime user.
RUN useradd --create-home --uid 10001 analytics
USER analytics

EXPOSE 8000 8501
# One image, three entrypoints — selected by `command` in docker-compose.yml:
#   analytics-api | analytics-consumer | streamlit run dashboard/app.py
CMD ["analytics-api"]
