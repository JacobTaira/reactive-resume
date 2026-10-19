ARG LATEX_BASE_IMAGE=debian:bookworm-slim
FROM ${LATEX_BASE_IMAGE}

USER root

RUN apt-get update && apt-get install -y --no-install-recommends python3 poppler-utils \
    && if ! command -v pdflatex >/dev/null 2>&1; then \
      apt-get install -y --no-install-recommends \
        texlive-latex-base texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended; \
    fi \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home compiler

WORKDIR /opt/latex
COPY worker.py ./worker.py
USER compiler
EXPOSE 8010
CMD ["python3", "-B", "/opt/latex/worker.py"]
